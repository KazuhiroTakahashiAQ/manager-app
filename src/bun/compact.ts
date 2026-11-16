// 文脈の compact。claude の文脈が膨らむと mgr が重くなるので、2 段で対処する。
// 1. claude 自身の自動 compact を早める（起動時の env）。公式 docs（code.claude.com/docs/en/env-vars・model-config）より:
//    - CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: 自動 compact が発火する「auto-compact window に対する割合」（1-100）。
//      既定の割合より上げることはできない（大きい値は無視）。
//    - CLAUDE_CODE_AUTO_COMPACT_WINDOW: auto-compact window（トークン数、100000〜1000000）。sonnet（Sonnet 5.5）は
//      1M の窓で、既定では約 967K で compact する。割合だけでは 60% でも約 60 万トークンなので、窓も小さくする。
//    - env は claude の起動時にしか読まれない。設定を変えたらタブの claude を立ち上げ直すと効く。
// 2. 定期の /compact: 止まっている（声かけを送ってよい状態の）セッションで、前回の compact（か起動）から compact_min 分以上たち、
//    文脈が compact_tokens を超えていたら、残す要点を指示した /compact を送る。1 セッション 1 日 compact_max_per_day 回まで。
//    文脈の大きさは ~/.claude/projects/<cwd>/<session>.jsonl 末尾の assistant 行の usage から読む。
//    記録（日付・回数・最後に送った時刻）は userData の compact.json（pulse.json と同じ流儀）。

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import type { TermKind } from "../shared/types";
import { readSettings, type AppSettings } from "./settings";
import { localDate } from "./vault";
import { projectDir } from "./workers";

/** compact を送る相手（Term の一部） */
export type CompactTarget = {
	id: string;
	rec: { kind: TermKind; sessionId: string; taskPath: string | null };
	running: boolean;
	startedAt: number;
	readyForNudge(): boolean;
	paste(text: string, submit?: boolean): void;
};

type Ledger = { day: string; counts: Record<string, number>; last: Record<string, number> };

type CompactorOptions = {
	managerDir: string;
	ledgerPath: string;
	/** 対象のセッション（mgr を先に） */
	targets: () => CompactTarget[];
	sent?: (id: string, tokens: number) => void;
};

const TICK_MS = 60_000;
/** jsonl の末尾から読む量（compact の境目の行は長いことがある） */
const TAIL_BYTES = 1024 * 1024;

/** claude を起動するときに足す env（設定が 0 なら付けない） */
export function autocompactEnv(s: AppSettings): Record<string, string> {
	const env: Record<string, string> = {};
	const pct = Math.round(s.autocompactPct);
	if (pct >= 1 && pct <= 100) env["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"] = String(pct);
	const win = Math.round(s.autocompactWindow);
	if (win >= 100_000 && win <= 1_000_000) env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] = String(win);
	return env;
}

/** /compact に付ける、残す要点の指示（1 行。長いと貼り付けが [Pasted text] に畳まれるので短く） */
export function compactInstruction(kind: TermKind, taskPath: string | null): string {
	const drop = "生ログ・ツール出力は捨てる";
	if (kind === "main") return `次を残して要約する: 未完了のタスクと next_action、人に確認中の事項、sub mgr に渡した依頼と返事待ちの件、決まったこと。${drop}`;
	if (kind === "system") return `次を残して要約する: 担当の改修の依頼・完了条件・手順・決定・worker に出した作業と結果・次の一手、mgr への報告待ち。${drop}`;
	return `次を残して要約する: 担当タスク（${taskPath ?? "不明"}）の完了条件・手順・決定・次の一手。${drop}`;
}

/**
 * セッションのいまの文脈の大きさ（トークン）。末尾の assistant 行の usage（input + cache_read + cache_creation）。
 * それより後に compact の境目があれば、compact 後の大きさ（なければ 0）。記録がなければ null。
 */
export function contextTokens(cwd: string, sessionId: string): number | null {
	const file = join(projectDir(cwd), `${sessionId}.jsonl`);
	if (!existsSync(file)) return null;
	let text = "";
	try {
		const size = statSync(file).size;
		const len = Math.min(size, TAIL_BYTES);
		const buf = Buffer.alloc(len);
		const fd = openSync(file, "r");
		try {
			readSync(fd, buf, 0, len, size - len);
		} finally {
			closeSync(fd);
		}
		text = buf.toString("utf-8");
	} catch {
		return null;
	}
	return tokensFromTail(text);
}

/** jsonl の末尾の文字列から読む（テスト用に切り出す） */
export function tokensFromTail(text: string): number | null {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const l = lines[i]!;
		if (!l.trim()) continue;
		let ev: any;
		try {
			ev = JSON.parse(l);
		} catch {
			// 先頭の切れた行。境目の行なら compact 直後とみなす（文字列の中の引用符はエスケープされるので、生のキーだけに当たる）
			if (l.includes('"subtype":"compact_boundary"')) return 0;
			continue;
		}
		if (ev.isSidechain) continue;
		if (ev.type === "system" && ev.subtype === "compact_boundary") return Number(ev.compactMetadata?.postTokens) || 0;
		if (ev.type !== "assistant") continue;
		const u = ev.message?.usage;
		if (!u || ev.message?.model === "<synthetic>") continue;
		const n = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
		if (n > 0) return n;
	}
	return null;
}

export class Compactor {
	private ledger: Ledger;

	constructor(private o: CompactorOptions) {
		this.ledger = this.loadLedger();
		setInterval(() => this.tick(), TICK_MS);
	}

	private tick() {
		try {
			const s = readSettings(this.o.managerDir);
			if (!s.compact) return;
			const today = localDate();
			if (this.ledger.day !== today) this.ledger = { day: today, counts: {}, last: this.ledger.last };
			const now = Date.now();
			for (const t of this.o.targets()) {
				if (!t.running) continue;
				if ((this.ledger.counts[t.id] ?? 0) >= s.compactMaxPerDay) continue;
				const since = Math.max(this.ledger.last[t.id] ?? 0, t.startedAt);
				if (now - since < s.compactMin * 60_000) continue;
				if (!t.readyForNudge()) continue;
				const tokens = contextTokens(this.o.managerDir, t.rec.sessionId);
				if (tokens === null || tokens <= s.compactTokens) continue;
				t.paste(`/compact ${compactInstruction(t.rec.kind, t.rec.taskPath)}`, true);
				this.ledger.counts[t.id] = (this.ledger.counts[t.id] ?? 0) + 1;
				this.ledger.last[t.id] = now;
				this.saveLedger();
				this.o.sent?.(t.id, tokens);
				// 1 周に 1 セッションだけ（compact は重いので重ねない）
				return;
			}
		} catch (e) {
			console.error("compact の判定に失敗", e);
		}
	}

	private loadLedger(): Ledger {
		try {
			const v = JSON.parse(readFileSync(this.o.ledgerPath, "utf-8")) as Partial<Ledger>;
			const last = v.last && typeof v.last === "object" ? v.last : {};
			if (v.day === localDate()) return { day: v.day, counts: v.counts ?? {}, last };
			return { day: localDate(), counts: {}, last };
		} catch {
			// 初回
		}
		return { day: localDate(), counts: {}, last: {} };
	}

	private saveLedger() {
		try {
			writeFileSync(this.o.ledgerPath, JSON.stringify(this.ledger));
		} catch (e) {
			console.error("compact.json を保存できなかった", e);
		}
	}
}
