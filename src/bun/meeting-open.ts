// 会議の自動オープン。開始の N 分前（既定 5 分）に、その予定の Meet / Teams のリンクを macOS の open で開く。
// - 毎回 calendar/upcoming.md を読み直す。予定が古い（取得ジョブのエラー・取得の回が抜けている）ときは何も開かず、1 日 1 回だけ知らせる。
// - 開いた予定は state/ui/meeting-open.json に残し、アプリを再起動しても二重に開かない。日が変わったら前日までの分を消す。
// - 辞退・リンクなし・Meet / Teams 以外（Zoom など）・終日・開始を過ぎた予定は開かない。未回答は設定で切り替え（既定は開く）。
// 声かけ（nudge）の on/off とは独立。settings/manager-app.md の meeting_open で止める。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { DayPlan } from "../shared/types";
import { readDayPlan } from "./calendar";
import { type AppSettings, readSettings } from "./settings";
import { localDate, parseNote } from "./vault";

type Event = DayPlan["events"][number];
type OpenSettings = Pick<AppSettings, "meetingOpenBefore" | "meetingOpenUnanswered">;
export type CalendarJob = { time?: string; days?: string; last_status?: string; last_run?: string };
export type Ledger = { opened: { key: string; day: string; at: string }[]; staleWarned: string };

const MEETING_HOSTS = new Set(["meet.google.com", "teams.microsoft.com", "teams.live.com"]);
/** 取得ジョブの回から何分たっても取れていなければ古いとみなすか */
const GRACE_MIN = 30;
/** ジョブの定義が読めないときの目安 */
const FALLBACK_STALE_H = 6;

/** Meet / Teams の参加リンクか（https のみ） */
export function isMeetingUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return u.protocol === "https:" && MEETING_HOSTS.has(u.hostname.toLowerCase());
	} catch {
		return false;
	}
}

export function meetingKind(url: string): "Meet" | "Teams" {
	return /^https:\/\/teams\./i.test(url) ? "Teams" : "Meet";
}

/** "YYYY-MM-DD" と "HH:MM"（または "YYYY-MM-DDTHH:MM"）をローカル時刻の Date に */
export function localTime(date: string, hhmm = ""): Date | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(hhmm ? `${date}T${hhmm}` : date);
	if (!m) return null;
	const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
	return Number.isNaN(d.getTime()) ? null : d;
}

export function eventKey(date: string, e: Pick<Event, "start" | "title" | "meet">): string {
	return `${date} ${e.start} ${e.title} ${e.meet}`;
}

/** いま開くべき予定: リンクが Meet / Teams、辞退でない、開始まで 0 分より多く N 分以内 */
export function pickToOpen(plan: DayPlan, now: Date, s: OpenSettings): Event[] {
	const nowMs = now.getTime();
	return plan.events.filter((e) => {
		if (!e.meet || !isMeetingUrl(e.meet)) return false;
		if (e.status === "辞退") return false;
		if (e.status === "未回答" && !s.meetingOpenUnanswered) return false;
		const start = localTime(plan.date, e.start);
		if (!start) return false;
		const diff = start.getTime() - nowMs;
		return diff > 0 && diff <= s.meetingOpenBefore * 60_000;
	});
}

/** jobs の days（'' / 毎日 / 平日 / 土日 / 月水金 など）を曜日の集合に。null は毎日 */
function parseDays(days = ""): Set<number> | null {
	const d = days.trim();
	if (!d || d === "毎日") return null;
	if (d === "平日") return new Set([1, 2, 3, 4, 5]);
	if (d === "土日" || d === "週末") return new Set([0, 6]);
	const set = new Set<number>();
	for (const ch of d.replace(/曜/g, "")) {
		const i = "日月火水木金土".indexOf(ch);
		if (i >= 0) set.add(i);
	}
	return set.size ? set : null;
}

/** 取得ジョブの回のうち、ref 以前で最も新しいもの（7 日さかのぼる） */
export function latestSlot(job: CalendarJob, ref: Date): Date | null {
	const times = (job.time ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter((t) => /^\d{1,2}:\d{2}$/.test(t))
		.map((t) => t.split(":").map(Number) as [number, number])
		.sort((a, b) => b[0] * 60 + b[1] - (a[0] * 60 + a[1]));
	if (!times.length) return null;
	const days = parseDays(job.days);
	for (let back = 0; back <= 7; back++) {
		const day = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - back);
		if (days && !days.has(day.getDay())) continue;
		for (const [h, m] of times) {
			const slot = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
			if (slot.getTime() <= ref.getTime()) return slot;
		}
	}
	return null;
}

const hm = (d: Date) => `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** 予定が古いか。古ければ理由（短い 1 句）、新しければ "" */
export function staleness(fetched: string, job: CalendarJob | null, now: Date): string {
	const f = localTime(fetched);
	if (!f) return "取得日時が読めない";
	if (job?.last_status === "error") {
		const run = job.last_run ? localTime(job.last_run) : null;
		// 失敗した回より後に手で取り直していれば古くない
		if (!run || f.getTime() < run.getTime()) return `取得ジョブがエラー（${hm(f)} 取得）`;
	}
	const slot = job ? latestSlot(job, new Date(now.getTime() - GRACE_MIN * 60_000)) : null;
	if (slot) {
		// 取得の時刻は分単位なので 2 分の余裕を見る
		if (f.getTime() < slot.getTime() - 2 * 60_000) return `${hm(slot)} の取得が抜けている（${hm(f)} 取得）`;
		return "";
	}
	if (now.getTime() - f.getTime() > FALLBACK_STALE_H * 3_600_000) return `${hm(f)} から取り直していない`;
	return "";
}

/** 前日までの記録を消す */
export function prune(ledger: Ledger, today: string): Ledger {
	return { opened: ledger.opened.filter((o) => o.day >= today), staleWarned: ledger.staleWarned };
}

export type MeetingOpenerOptions = {
	managerDir: string;
	/** 既定は Manager/state/ui/meeting-open.json */
	ledgerPath?: string;
	/** 既定は /usr/bin/open <url> */
	open?: (url: string) => void;
	/** 1 行の知らせ。warn は予定が古いときの知らせ */
	toast: (text: string, warn: boolean) => void;
	now?: () => Date;
};

export class MeetingOpener {
	private ledgerPath: string;
	private ledger: Ledger;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(private o: MeetingOpenerOptions) {
		this.ledgerPath = o.ledgerPath ?? join(o.managerDir, "state", "ui", "meeting-open.json");
		this.ledger = this.load();
	}

	start(intervalMs = 30_000, firstMs = 5_000): this {
		setTimeout(() => this.safeTick(), firstMs);
		this.timer = setInterval(() => this.safeTick(), intervalMs);
		return this;
	}

	stop() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	private safeTick() {
		try {
			this.tick();
		} catch (e) {
			console.error("会議の自動オープンで失敗", e);
		}
	}

	/** 1 回分の判定。開いた予定を返す（テストとドライラン用） */
	tick(): Event[] {
		const s = readSettings(this.o.managerDir);
		if (!s.meetingOpen) return [];
		const now = this.o.now?.() ?? new Date();
		const today = localDate(now);
		if (this.ledger.opened.some((x) => x.day < today)) {
			this.ledger = prune(this.ledger, today);
			this.save();
		}

		const plan = readDayPlan(this.o.managerDir, today);
		const candidates = pickToOpen(plan, now, s);
		const stale = staleness(plan.fetched, readJob(this.o.managerDir), now);
		if (stale) {
			const min = now.getHours() * 60 + now.getMinutes();
			const workday = now.getDay() !== 0 && now.getDay() !== 6;
			const inWork = workday && min >= s.workStart && min < s.workEnd;
			if (this.ledger.staleWarned !== today && (candidates.length || inWork)) {
				this.ledger.staleWarned = today;
				this.save();
				this.o.toast(`予定が古いので会議を自動で開けない（${stale}）`, true);
			}
			return [];
		}

		const opened: Event[] = [];
		for (const e of candidates) {
			const key = eventKey(today, e);
			if (this.ledger.opened.some((x) => x.key === key)) continue;
			// 先に記録してから開く（open が失敗しても繰り返さない）
			this.ledger.opened.push({ key, day: today, at: now.toISOString() });
			this.save();
			(this.o.open ?? openUrl)(e.meet);
			this.o.toast(`会議を開いた: ${e.start} ${e.title}（${meetingKind(e.meet)}）`, false);
			opened.push(e);
		}
		return opened;
	}

	private load(): Ledger {
		try {
			const v = JSON.parse(readFileSync(this.ledgerPath, "utf-8"));
			return { opened: Array.isArray(v.opened) ? v.opened : [], staleWarned: v.staleWarned ?? "" };
		} catch {
			return { opened: [], staleWarned: "" };
		}
	}

	private save() {
		try {
			mkdirSync(dirname(this.ledgerPath), { recursive: true });
			writeFileSync(this.ledgerPath, JSON.stringify(this.ledger, null, 2));
		} catch (e) {
			console.error("meeting-open.json を書けなかった", e);
		}
	}
}

export function readJob(managerDir: string): CalendarJob | null {
	const p = join(managerDir, "jobs", "calendar.md");
	if (!existsSync(p)) return null;
	try {
		return parseNote(readFileSync(p, "utf-8")).fm;
	} catch {
		return null;
	}
}

/** macOS の open で既定のブラウザ / Teams に渡す。アプリ自身は前に出さない */
function openUrl(url: string) {
	Bun.spawn(["/usr/bin/open", url], { stdout: "ignore", stderr: "ignore" });
}
