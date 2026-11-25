// 完了した sub mgr のタブと claude を、朝（日付が変わって最初の周回）に自動で閉じる。
// - 閉じる経路は人が × で閉じるときと同じ（hub.close → pty 終了・タブ削除・terms.json と sessions.json の更新）。
//   同じタスクへの handoff（to: tasks/<名>.md）が来れば、openTask が新しいタブ（新しいセッション）を立てる。
// - 判定は純関数 decideClose（テスト対象）。副作用は DoneCloser にまとめる。
// - 1 日 1 回: 記録（userData/close-done.json）の day が今日で done なら何もしない。
//   入力中・出力中・判断待ちで見送ったタブがあれば、その日のうちは次の周回（60 秒後）で再び試す。
// - 設定 close_done_submgr: false で止める（settings/manager-app.md）。

import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { TermKind } from "../shared/types";
import { readSettings } from "./settings";
import { localDate } from "./vault";

/** 完了とみなす status（done / dropped。cancelled は旧名として同じ扱い） */
const FINISHED = new Set(["done", "dropped", "cancelled"]);
/** タスクノートの updated がこの日数より古いと「状態がファイルに残っているか疑わしい」として閉じない */
export const RECENT_DAYS = 14;

export type CloseTerm = {
	id: string;
	kind: TermKind;
	title: string;
	taskPath: string | null;
	running: boolean;
	/** readyForNudge()（出力中・人が入力中・直前にアプリが送信・判断待ちなら false） */
	ready: boolean;
	/** 判断待ち（waiting バッジ） */
	waiting: boolean;
};

export type CloseTask = { name: string; path: string; fm: Record<string, string> };
export type CloseMessage = { path: string; fm: Record<string, string> };
/** state/ui/handoff-*.json の宛先と送り元（読めたものだけ） */
export type PendingHandoff = { to: string; from: string };

export type CloseDecision = {
	close: { id: string; title: string }[];
	/** 入力中・出力中・判断待ちなので次の周回に回す */
	defer: { id: string; title: string; reason: string }[];
	/** 疑わしいので閉じず mgr に知らせる */
	hold: { id: string; title: string; reason: string }[];
};

export function isFinished(status: string | undefined): boolean {
	return FINISHED.has(status ?? "");
}

/** YYYY-MM-DD の差（today - d）日。読めなければ null */
export function daysSince(d: string | undefined, today: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d ?? "");
	const t = /^(\d{4})-(\d{2})-(\d{2})/.exec(today);
	if (!m || !t) return null;
	const a = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!);
	const b = Date.UTC(+t[1]!, +t[2]! - 1, +t[3]!);
	return Math.round((b - a) / 86_400_000);
}

export function decideClose(i: {
	terms: CloseTerm[];
	tasks: CloseTask[];
	messages: CloseMessage[];
	handoffs: PendingHandoff[];
	today: string;
}): CloseDecision {
	const out: CloseDecision = { close: [], defer: [], hold: [] };
	for (const t of i.terms) {
		// 固定タブ（mgr・システム改修・自己改善）とタスクのないタブは対象外
		if (t.kind !== "task" || !t.taskPath) continue;
		const task = i.tasks.find((x) => x.path === t.taskPath);
		// ノートが読めない・まだ完了でない → 何もしない（閉じない・知らせない）
		if (!task || !isFinished(task.fm["status"])) continue;

		// 子が開いている親は閉じない（親は成果物の取りまとめ役で、子の完了報告を受ける）
		const openChild = i.tasks.find((x) => x.fm["parent"] === task.name && !isFinished(x.fm["status"]));
		if (openChild) continue;

		const age = daysSince(task.fm["updated"], i.today);
		if (age === null || age > RECENT_DAYS || !task.fm["next_action"]?.trim()) {
			out.hold.push({ id: t.id, title: t.title, reason: `ノートの updated が古い／読めない、または next_action が空（updated: ${task.fm["updated"] ?? "なし"}）` });
			continue;
		}
		const h = i.handoffs.find((x) => x.to === t.taskPath || x.from === t.title);
		if (h) {
			out.hold.push({ id: t.id, title: t.title, reason: `未処理の handoff がある（to: ${h.to}、from: ${h.from}）` });
			continue;
		}
		const m = i.messages.find((x) => x.fm["status"] !== "完了" && x.fm["task"] && (x.fm["task"] === task.name || x.fm["task"].includes(task.name)));
		if (m) {
			out.hold.push({ id: t.id, title: t.title, reason: `未処理の messages がある（${m.path}）` });
			continue;
		}

		// 止まっている claude は、人が入力中・出力中・判断待ちでなければ閉じる（動いていなければタブだけ消す）
		if (t.running && (t.waiting || !t.ready)) {
			out.defer.push({ id: t.id, title: t.title, reason: t.waiting ? "判断待ち" : "入力中・出力中" });
			continue;
		}
		out.close.push({ id: t.id, title: t.title });
	}
	return out;
}

/** mgr への 1 行 handoff の本文。何も知らせることがなければ null */
export function closeBrief(closed: string[], held: { title: string; reason: string }[]): string | null {
	const parts: string[] = [];
	if (closed.length) parts.push(`完了済みの sub mgr を自動で閉じた: ${closed.join("、")}`);
	if (held.length) parts.push(`閉じずに残した（要確認）: ${held.map((h) => `${h.title}（${h.reason}）`).join("、")}`);
	return parts.length ? parts.join("。") : null;
}

type Ledger = { day: string; done: boolean; reported: string[] };

type CloserOptions = {
	managerDir: string;
	ledgerPath: string;
	terms: () => CloseTerm[];
	scan: () => { tasks: CloseTask[]; messages: CloseMessage[] };
	/** 人が × で閉じるときと同じ経路（hub.close + shells.close） */
	close: (id: string) => void;
	/** トースト・通知 */
	closed: (titles: string[]) => void;
};

const TICK_MS = 60_000;

export class DoneCloser {
	private ledger: Ledger;

	constructor(private o: CloserOptions) {
		this.ledger = this.loadLedger();
		// 起動直後はセッションの復元が済んでから。起動後の最初の周回で今日の分を実行する
		setTimeout(() => this.tick(), 20_000);
		setInterval(() => this.tick(), TICK_MS);
	}

	tick() {
		try {
			if (!readSettings(this.o.managerDir).closeDoneSubmgr) return;
			const today = localDate();
			if (this.ledger.day !== today) this.ledger = { day: today, done: false, reported: [] };
			if (this.ledger.done) return;

			const st = this.o.scan();
			const d = decideClose({ terms: this.o.terms(), tasks: st.tasks, messages: st.messages, handoffs: this.readHandoffs(), today });
			for (const c of d.close) this.o.close(c.id);

			const newHolds = d.hold.filter((h) => !this.ledger.reported.includes(h.id));
			const brief = closeBrief(d.close.map((c) => c.title), newHolds);
			if (brief) this.writeHandoff(brief);
			if (d.close.length) this.o.closed(d.close.map((c) => c.title));
			this.ledger.reported.push(...newHolds.map((h) => h.id));
			// 見送り（入力中・判断待ち）が残っていなければ今日はおしまい
			if (!d.defer.length) this.ledger.done = true;
			this.saveLedger();
		} catch (e) {
			console.error("完了 sub mgr の自動クローズに失敗", e);
		}
	}

	private readHandoffs(): PendingHandoff[] {
		const dir = join(this.o.managerDir, "state", "ui");
		if (!existsSync(dir)) return [];
		const out: PendingHandoff[] = [];
		for (const f of readdirSync(dir).filter((x) => /^handoff-.*\.json$/.test(x))) {
			try {
				const v = JSON.parse(readFileSync(join(dir, f), "utf-8")) as Record<string, unknown>;
				const to = typeof v["to"] === "string" ? v["to"] : typeof v["task"] === "string" ? v["task"] : "";
				out.push({ to, from: typeof v["from"] === "string" ? v["from"] : "" });
			} catch {
				// 書きかけは無視
			}
		}
		return out;
	}

	private writeHandoff(brief: string) {
		const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
		const p = join(this.o.managerDir, "state", "ui", `handoff-${ts}-close.json`);
		writeFileSync(p, JSON.stringify({ to: "main", from: "system", brief }));
	}

	private loadLedger(): Ledger {
		try {
			const v = JSON.parse(readFileSync(this.o.ledgerPath, "utf-8")) as Partial<Ledger>;
			if (v.day === localDate()) return { day: v.day, done: !!v.done, reported: Array.isArray(v.reported) ? v.reported : [] };
		} catch {
			// 初回
		}
		return { day: "", done: false, reported: [] };
	}

	private saveLedger() {
		try {
			writeFileSync(this.o.ledgerPath, JSON.stringify(this.ledger));
		} catch (e) {
			console.error("close-done.json を保存できなかった", e);
		}
	}
}
