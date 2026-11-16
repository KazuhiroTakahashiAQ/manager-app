// mgr の声かけ。アプリが予定・メッセージ・期限・人の手の止まり具合を見て、きっかけがあれば
// mgr のターミナルに合図（[manager-app: 声かけ]）を送る。合図を受けた mgr が中身を考えて人に話しかける。
// - 判定は決まった規則だけで行い、LLM は呼ばない（何もなければトークンを使わない）。
// - 設定は Manager/settings/manager-app.md（なければ既定値）。
// - mgr 自身も state/ui/nudge-*.json（{ "at": "HH:MM" か ISO, "text": "…" }）を書けば、後で自分に合図を送れる。
// - 活動の記録（activity.ts）から、脱線（関係ないことが続く）と停滞（同じタスクにいてノートが進まない）を拾う。
// - 壁打ちが書いた state/buddy/feedback-*.json を拾って合図し、state/buddy/log.jsonl に移す。

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import type { VaultState } from "../shared/types";
import { taskMtime, type Run } from "./activity";
import { readSettings, toMin, type AppSettings } from "./settings";
import { localDate } from "./vault";

type Settings = AppSettings;

type Candidate = {
	key: string;
	text: string;
	urgent: boolean;
	/** 送ったら消すファイル（予約） */
	file?: string;
	/** 送ったあとの片づけ（file の代わり） */
	done?: () => void;
};

type Ledger = { day: string; fired: string[]; count: number; lastAt: number };

/** 合図を送る先（mgr のターミナル） */
export type NudgeTarget = { readyForNudge(): boolean; paste(text: string, submit?: boolean): void };

type PulseOptions = {
	managerDir: string;
	ledgerPath: string;
	scan: () => VaultState;
	target: () => NudgeTarget | null;
	/** 人が最後にターミナルを操作した時刻（ms） */
	lastHumanInput: () => number;
	/** 活動の記録のいまの区間 */
	currentRun: (s: AppSettings) => Run | null;
	sent: (summary: string) => void;
};

const TICK_MS = 30_000;

export class Pulse {
	private ledger: Ledger;
	private startedAt = Date.now();

	constructor(private o: PulseOptions) {
		this.ledger = this.loadLedger();
		this.seedMessages();
		setInterval(() => this.tick(), TICK_MS);
		setTimeout(() => this.tick(), 5_000);
	}

	private tick() {
		try {
			const now = new Date();
			const today = localDate(now);
			if (this.ledger.day !== today) {
				this.ledger = { day: today, fired: [], count: 0, lastAt: 0 };
				this.seedMessages();
			}
			const s = this.settings();
			if (!s.enabled) return;
			const st = this.o.scan();
			const cands = [...this.scheduled(now), ...this.feedback(), ...this.watch(now, st, s)].filter((c) => !this.ledger.fired.includes(c.key));
			if (!cands.length) return;

			const urgent = cands.some((c) => c.urgent);
			if (this.ledger.count >= s.maxPerDay && !cands.some((c) => c.file || c.done)) return;
			if (!urgent && Date.now() - this.ledger.lastAt < s.minGap * 60_000) return;
			const t = this.o.target();
			if (!t || !t.readyForNudge()) return;

			const hhmm = now.toTimeString().slice(0, 5);
			const text = [`[manager-app: 声かけ ${hhmm}] 人の発言ではない。skill manager-app の「声かけを受けたとき」に従う。`, ...cands.map((c) => `- ${c.text}`)].join("\n");
			t.paste(text, true);
			for (const c of cands) {
				this.ledger.fired.push(c.key);
				if (c.done) c.done();
				else if (c.file) rmSync(c.file, { force: true });
			}
			this.ledger.count++;
			this.ledger.lastAt = Date.now();
			this.saveLedger();
			this.o.sent(cands.map((c) => c.text.split("。")[0]).join(" / "));
		} catch (e) {
			console.error("声かけの判定に失敗", e);
		}
	}

	/** 決まった規則で拾うきっかけ（平日・祝日以外の勤務時間内だけ） */
	private watch(now: Date, st: VaultState, s: Settings): Candidate[] {
		const today = st.today;
		const dow = now.getDay();
		if (dow === 0 || dow === 6 || st.holidays[today]) return [];
		const min = now.getHours() * 60 + now.getMinutes();
		if (min < s.workStart || min >= s.workEnd) return [];
		const out: Candidate[] = [];

		// 人が今日すでに話しかけていれば、始業の声かけは要らない
		const midnight = new Date(now).setHours(0, 0, 0, 0);
		if (this.o.lastHumanInput() < midnight) {
			out.push({ key: "start", urgent: false, text: `始業。/boot-manager で今日の段取りを整え、最初に人が決めることを示す${this.nightNote(now, st, s)}` });
		}

		for (const e of st.plan.events) {
			if (e.status === "辞退") continue;
			const start = toMin(e.start);
			const end = toMin(e.end);
			const until = start - min;
			if (until >= 0 && until <= s.meetingBefore) {
				out.push({
					key: `before:${e.start}:${e.title}`,
					urgent: true,
					text: `${e.start} から「${e.title}」（あと ${until} 分）。関係するタスク・資料・前回の決定を確かめ、準備の要点と持っていく論点を人に伝える`,
				});
			}
			const since = min - end;
			if (e.meet && since >= s.meetingAfter && since <= s.meetingAfter + 60) {
				out.push({
					key: `after:${e.start}:${e.title}`,
					urgent: false,
					text: `「${e.title}」（${e.start}-${e.end}）が終わった。Gemini メモが届いていれば /meeting-notes で取り込み、自分の宿題と次の一手を人に確かめる`,
				});
			}
		}

		for (const m of st.messages) {
			if (m.fm["status"] !== "未読") continue;
			const high = m.fm["priority"] === "高";
			out.push({
				key: `msg:${m.path}`,
				urgent: high,
				text: `新しいメッセージ ${m.path}（${m.fm["kind"] ?? ""}・優先度 ${m.fm["priority"] ?? "中"}）「${m.summary}」。AI で進められるところまで進め、人に要る判断だけを聞く`,
			});
		}

		if (min >= s.middayAt) {
			const open = st.tasks.filter((t) => t.fm["status"] !== "done" && t.fm["status"] !== "cancelled");
			const prep = open.filter((t) => t.fm["ready"] !== "着手可" && t.fm["prep_due"] && t.fm["prep_due"] <= today).map((t) => t.name);
			const due = open.filter((t) => t.fm["due"] && t.fm["due"] <= today).map((t) => t.name);
			if (prep.length || due.length) {
				const parts = [prep.length ? `準備の期限が来ていて着手可でない: ${prep.join("、")}` : "", due.length ? `期限が今日以前: ${due.join("、")}` : ""].filter(Boolean);
				out.push({ key: "midday", urgent: false, text: `昼の確認。${parts.join("。")}。今日中に片づける順を決め、人に 1 つだけ持ちかける` });
			}
		}

		const doing = st.tasks.filter((t) => t.fm["status"] === "doing").map((t) => t.name);
		const last = Math.max(this.o.lastHumanInput(), this.startedAt);
		const idle = Math.floor((Date.now() - last) / 60_000);
		if (doing.length && idle >= s.idleMin && this.ledger.fired.filter((k) => k.startsWith("idle:")).length < 2) {
			out.push({
				key: `idle:${last}`,
				urgent: false,
				text: `人の操作が ${idle} 分ない。doing（${doing.join("、")}）の進み具合と、詰まっていることがないかを 1 問だけ聞く`,
			});
		}

		out.push(...this.drift(st, s));

		if (min >= s.eodAt) {
			out.push({ key: "eod", urgent: false, text: "終業の時刻。/eod を持ちかけ、今日の完了と明日のトップ3を確かめる" });
		}
		return out;
	}

	/** 始業の合図に添える夜の成果（research/ と state/plan/lookahead.json の更新時刻から） */
	private nightNote(now: Date, st: VaultState, s: Settings): string {
		const y = new Date(now);
		y.setDate(y.getDate() - 1);
		y.setHours(Math.floor(s.workEnd / 60), s.workEnd % 60, 0, 0);
		const n = st.research.filter((r) => r.mtime >= y.getTime()).length;
		const la = st.lookahead?.generated ?? "";
		if (!n && !la) return "";
		return `。夜の下調べ: research 更新 ${n} 件、先読み ${la || "なし"}`;
	}

	/** 活動の記録から拾う脱線と停滞 */
	private drift(st: VaultState, s: Settings): Candidate[] {
		const run = this.o.currentRun(s);
		if (!run) return [];
		const mins = Math.floor((run.endMs - run.startMs) / 60_000);
		const out: Candidate[] = [];
		if (run.label === "off") {
			// すぐには言わない。off_task_min 続いたら 1 回、なお続けば off_task_repeat_min 後にもう 1 回（1 区切りで最大 2 回）
			const prefix = `off:${run.startMs}:`;
			const n = this.ledger.fired.filter((k) => k.startsWith(prefix)).length + 1;
			if (n <= 2 && mins >= s.offTaskMin + (n - 1) * s.offTaskRepeatMin) {
				const doing = st.tasks.filter((t) => t.fm["status"] === "doing").map((t) => t.name);
				out.push({
					key: `${prefix}${n}`,
					urgent: false,
					text: `人は約 ${mins} 分、タスクと関係ないこと（${run.summaries.slice(-3).join(" / ") || "内容不明"}）をしている。いまの doing: ${doing.join("、") || "なし"}。skill の「脱線に気づいたとき」に従う`,
				});
			}
		}
		if (run.label === "task" && run.task && mins >= s.stuckMin) {
			const mt = taskMtime(this.o.managerDir, run.task);
			if (mt !== null && mt < run.startMs) {
				out.push({
					key: `stuck:${run.task}:${run.startMs}`,
					urgent: false,
					text: `「${run.task}」に約 ${mins} 分いるが、ノートが進んでいない。skill の「ストッパー」に従う`,
				});
			}
		}
		return out;
	}

	/** 壁打ちからのフィードバック（state/buddy/feedback-*.json）。時間帯に関係なく届ける。severity 高はすぐ */
	private feedback(): Candidate[] {
		const dir = join(this.o.managerDir, "state", "buddy");
		if (!existsSync(dir)) return [];
		const out: Candidate[] = [];
		const log = join(dir, "log.jsonl");
		for (const f of readdirSync(dir).filter((x) => /^feedback-.*\.json$/.test(x)).sort()) {
			const p = join(dir, f);
			let raw = "";
			let v: { kind?: string; summary?: string; task?: string; severity?: string } = {};
			try {
				raw = readFileSync(p, "utf-8");
				v = JSON.parse(raw);
			} catch {
				// 書きかけかもしれない。1 分たっても読めなければ記録に移して捨てる
				try {
					if (Date.now() - statSync(p).mtimeMs > 60_000) {
						appendFileSync(log, `${JSON.stringify({ file: f, at: new Date().toISOString(), error: "読めない", raw: raw.slice(0, 500) })}\n`);
						rmSync(p, { force: true });
					}
				} catch {
					// 消えていた
				}
				continue;
			}
			if (!v.summary) {
				appendFileSync(log, `${JSON.stringify({ file: f, at: new Date().toISOString(), error: "summary がない", ...v })}\n`);
				rmSync(p, { force: true });
				continue;
			}
			const sev = v.severity || "中";
			out.push({
				key: `buddy:${f}`,
				urgent: sev === "高",
				text: `壁打ちから [${v.kind || "その他"}/${sev}] ${v.summary}（${v.task || "タスクなし"}）。skill の「壁打ちからのフィードバック」に従う`,
				done: () => {
					try {
						mkdirSync(dir, { recursive: true });
						appendFileSync(log, `${JSON.stringify({ file: f, at: new Date().toISOString(), ...v })}\n`);
					} finally {
						rmSync(p, { force: true });
					}
				},
			});
		}
		return out;
	}

	/** mgr が自分で予約した合図（state/ui/nudge-*.json） */
	private scheduled(now: Date): Candidate[] {
		const dir = join(this.o.managerDir, "state", "ui");
		if (!existsSync(dir)) return [];
		const out: Candidate[] = [];
		for (const f of readdirSync(dir).filter((x) => /^nudge-.*\.json$/.test(x))) {
			const p = join(dir, f);
			let v: { at?: string; text?: string } = {};
			try {
				v = JSON.parse(readFileSync(p, "utf-8"));
			} catch {
				continue; // 書きかけかもしれない
			}
			if (!v.text) {
				rmSync(p, { force: true });
				continue;
			}
			const at = parseAt(v.at ?? "", now);
			if (at === null || at > now.getTime()) continue;
			out.push({ key: `nudge:${f}`, urgent: true, text: `予約していた確認: ${v.text}`, file: p });
		}
		return out;
	}

	/** 起動時・日替わり時点で既にある未読は始業の声かけ（boot）で扱うので、新着だけを拾う */
	private seedMessages() {
		const dir = join(this.o.managerDir, "messages");
		if (!existsSync(dir)) return;
		for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
			const key = `msg:messages/${f}`;
			if (!this.ledger.fired.includes(key)) this.ledger.fired.push(key);
		}
		this.saveLedger();
	}

	private settings(): Settings {
		return readSettings(this.o.managerDir);
	}

	private loadLedger(): Ledger {
		try {
			const v = JSON.parse(readFileSync(this.o.ledgerPath, "utf-8")) as Ledger;
			if (v.day === localDate()) return v;
		} catch {
			// 初回
		}
		return { day: localDate(), fired: [], count: 0, lastAt: 0 };
	}

	private saveLedger() {
		try {
			writeFileSync(this.o.ledgerPath, JSON.stringify(this.ledger));
		} catch (e) {
			console.error("pulse.json を保存できなかった", e);
		}
	}
}

/** "HH:MM"（今日）か ISO 日時 → ms。読めなければ null */
function parseAt(at: string, now: Date): number | null {
	if (/^\d{1,2}:\d{2}$/.test(at)) {
		const d = new Date(now);
		const [h, m] = at.split(":").map(Number);
		d.setHours(h!, m!, 0, 0);
		return d.getTime();
	}
	const t = Date.parse(at);
	return Number.isNaN(t) ? null : t;
}
