// Manager/settings/manager-app.md の設定。なければ既定値。声かけ（pulse）と活動の記録（activity）で共有する。

import { readFileSync } from "fs";
import { join } from "path";
import { parseNote } from "./vault";

export type AppSettings = {
	/** 声かけ */
	enabled: boolean;
	workStart: number;
	workEnd: number;
	meetingBefore: number;
	meetingAfter: number;
	middayAt: number;
	idleMin: number;
	eodAt: number;
	maxPerDay: number;
	minGap: number;
	/** 活動の記録 */
	activity: boolean;
	activityIntervalMin: number;
	classifyEveryMin: number;
	offTaskMin: number;
	offTaskRepeatMin: number;
	stuckMin: number;
	/** アプリが前面でないとき macOS の通知も出す */
	notify: boolean;
	/** claude 自身の自動 compact（起動時の env。0 なら設定しない） */
	autocompactPct: number;
	autocompactWindow: number;
	/** アプリが止まっているセッションに送る /compact */
	compact: boolean;
	compactMin: number;
	compactTokens: number;
	compactMaxPerDay: number;
	/** 会議の自動オープン（開始の何分前に Meet / Teams のリンクを開くか、未回答も開くか） */
	meetingOpen: boolean;
	meetingOpenBefore: number;
	meetingOpenUnanswered: boolean;
};

export function readSettings(managerDir: string): AppSettings {
	let fm: Record<string, string> = {};
	try {
		fm = parseNote(readFileSync(join(managerDir, "settings", "manager-app.md"), "utf-8")).fm;
	} catch {
		// 既定値
	}
	const num = (k: string, d: number) => (fm[k] && !Number.isNaN(Number(fm[k])) ?Number(fm[k]) : d);
	const time = (k: string, d: string) => toMin(/^\d{1,2}:\d{2}$/.test(fm[k] ?? "") ? fm[k]! : d);
	return {
		enabled: fm["nudge"] !== "false",
		workStart: time("work_start", "09:00"),
		workEnd: time("work_end", "19:00"),
		meetingBefore: num("meeting_before_min", 10),
		meetingAfter: num("meeting_after_min", 10),
		middayAt: time("midday_time", "13:30"),
		idleMin: num("idle_min", 90),
		eodAt: time("eod_time", "18:00"),
		maxPerDay: num("max_per_day", 12),
		minGap: num("min_gap_min", 20),
		activity: fm["activity"] !== "false",
		activityIntervalMin: Math.max(1, num("activity_interval_min", 5)),
		classifyEveryMin: Math.max(5, num("classify_every_min", 15)),
		offTaskMin: num("off_task_min", 30),
		offTaskRepeatMin: num("off_task_repeat_min", 60),
		stuckMin: num("stuck_min", 90),
		notify: fm["notify"] !== "false",
		autocompactPct: num("autocompact_pct", 60),
		autocompactWindow: num("autocompact_window", 200000),
		compact: fm["compact"] !== "false",
		compactMin: Math.max(5, num("compact_min", 45)),
		compactTokens: Math.max(10000, num("compact_tokens", 90000)),
		compactMaxPerDay: num("compact_max_per_day", 6),
		meetingOpen: fm["meeting_open"] !== "false",
		meetingOpenBefore: Math.min(60, Math.max(1, num("meeting_open_before_min", 5))),
		meetingOpenUnanswered: fm["meeting_open_unanswered"] !== "false",
	};
}

/** 平日・祝日以外の勤務時間内か */
export function inWorkHours(now: Date, s: AppSettings, holidays: Record<string, string>, today: string): boolean {
	const dow = now.getDay();
	if (dow === 0 || dow === 6 || holidays[today]) return false;
	const min = now.getHours() * 60 + now.getMinutes();
	return min >= s.workStart && min < s.workEnd;
}

export function toMin(hhmm: string): number {
	const [h, m] = hhmm.split(":").map(Number);
	return (h ?? 0) * 60 + (m ?? 0);
}
