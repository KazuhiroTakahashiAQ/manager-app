// bun test src/bun  （会議の自動オープン: 開く予定の選び方、予定の古さ、二重オープン防止）
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { DayPlan } from "../shared/types";
import { readDayPlan } from "./calendar";
import { isMeetingUrl, latestSlot, MeetingOpener, pickToOpen, prune, staleness } from "./meeting-open";

const MEET = "https://meet.google.com/abc-defg-hij";
const TEAMS = "https://teams.microsoft.com/meet/489802622412770?p=xyz";
const s = { meetingOpenBefore: 5, meetingOpenUnanswered: true };
const at = (hhmm: string, date = "2026-11-13") => {
	const [h, m] = hhmm.split(":").map(Number);
	const [y, mo, d] = date.split("-").map(Number);
	return new Date(y!, mo! - 1, d!, h!, m!);
};
const ev = (start: string, meet: string, status = "", title = `会議${start}`) => ({ start, end: "23:59", title, status, meet, links: [], note: "" });
const plan = (events: DayPlan["events"]): DayPlan => ({ date: "2026-11-13", allDay: [], events, fetched: "" });

describe("isMeetingUrl", () => {
	test("Meet と Teams だけ", () => {
		expect(isMeetingUrl(MEET)).toBe(true);
		expect(isMeetingUrl(TEAMS)).toBe(true);
		expect(isMeetingUrl("https://teams.live.com/meet/9xyz")).toBe(true);
		expect(isMeetingUrl("https://zoom.us/j/123")).toBe(false);
		expect(isMeetingUrl("http://meet.google.com/abc")).toBe(false);
		expect(isMeetingUrl("")).toBe(false);
	});
});

describe("pickToOpen", () => {
	test("開始のちょうど 5 分前は開く、5 分より前は開かない", () => {
		const p = plan([ev("10:00", MEET)]);
		expect(pickToOpen(p, at("09:55"), s)).toHaveLength(1);
		expect(pickToOpen(p, new Date(at("09:55").getTime() - 1000), s)).toHaveLength(0);
	});
	test("開始を過ぎた予定・開始ちょうどは開かない（起動直後に過去の会議を開かない）", () => {
		const p = plan([ev("10:00", MEET)]);
		expect(pickToOpen(p, at("10:00"), s)).toHaveLength(0);
		expect(pickToOpen(p, at("10:03"), s)).toHaveLength(0);
	});
	test("辞退は開かない。未回答は設定しだい", () => {
		const p = plan([ev("10:00", MEET, "辞退"), ev("10:01", TEAMS, "未回答"), ev("10:02", MEET, "仮承諾")]);
		expect(pickToOpen(p, at("09:58"), s).map((e) => e.start)).toEqual(["10:01", "10:02"]);
		expect(pickToOpen(p, at("09:58"), { ...s, meetingOpenUnanswered: false }).map((e) => e.start)).toEqual(["10:02"]);
	});
	test("リンクなし・Zoom は開かない", () => {
		const p = plan([ev("10:00", ""), ev("10:00", "https://zoom.us/j/1")]);
		expect(pickToOpen(p, at("09:58"), s)).toHaveLength(0);
	});
	test("分数の設定どおり", () => {
		const p = plan([ev("10:00", MEET)]);
		expect(pickToOpen(p, at("09:51"), { ...s, meetingOpenBefore: 10 })).toHaveLength(1);
	});
});

describe("staleness", () => {
	const job = { time: "09:00,12:00,15:00,18:00,21:00", days: "平日", last_status: "ok", last_run: "2026-11-13T09:00" };
	test("ジョブがエラーで、その回より前の取得なら古い", () => {
		expect(staleness("2026-11-11T21:00", { ...job, last_status: "error" }, at("09:20"))).toContain("エラー");
	});
	test("エラーでも、失敗した回より後に手で取り直していれば古くない", () => {
		expect(staleness("2026-11-13T09:10", { ...job, last_status: "error" }, at("09:20"))).toBe("");
	});
	test("金曜 21:00 の取得は、月曜 08:55 の時点では新しい", () => {
		expect(staleness("2026-11-13T21:00", job, at("08:55", "2026-11-16"))).toBe("");
	});
	test("取得の回が抜けたら（猶予 30 分を過ぎて）古い", () => {
		expect(staleness("2026-11-13T09:00", job, at("12:20"))).toBe("");
		expect(staleness("2026-11-13T09:00", job, at("12:31"))).toContain("12:00");
	});
	test("ジョブが読めないときは 6 時間で古い", () => {
		expect(staleness("2026-11-13T03:00", null, at("08:59"))).toBe("");
		expect(staleness("2026-11-13T03:00", null, at("09:01"))).not.toBe("");
	});
	test("取得日時がなければ古い", () => {
		expect(staleness("", job, at("10:00"))).not.toBe("");
	});
	test("latestSlot は土日を飛ばす", () => {
		expect(latestSlot(job, at("10:00", "2026-11-15"))?.toString()).toBe(at("21:00", "2026-11-13").toString());
	});
});

describe("prune", () => {
	test("前日までの記録を消す", () => {
		const l = { opened: [{ key: "a", day: "2026-11-12", at: "" }, { key: "b", day: "2026-11-13", at: "" }], staleWarned: "2026-11-12" };
		expect(prune(l, "2026-11-13").opened.map((o) => o.key)).toEqual(["b"]);
	});
});

describe("MeetingOpener（一時ディレクトリの Manager）", () => {
	let dir: string;
	const upcoming = (fetched: string) =>
		[
			"---",
			"type: calendar",
			`fetched: ${fetched}`,
			"---",
			"## 11/13(金)",
			"- 終日 オフィス",
			"- 10:00-11:00 自動作図_分科会（未回答）",
			`  - Teams: ${TEAMS}`,
			"- 10:02-10:30 社内レビュー（辞退）",
			`  - Meet: ${MEET}`,
			"- 10:03-10:30 対面の打合せ @会議室A",
			"",
		].join("\n");
	const writeJob = (status: string) =>
		writeFileSync(
			join(dir, "jobs", "calendar.md"),
			`---\ntype: job\ntime: "09:00,12:00,15:00,18:00,21:00"\ndays: 平日\nlast_run: 2026-11-13T09:00\nlast_status: ${status}\n---\n`,
		);

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "meeting-open-"));
		for (const d of ["calendar", "jobs", "settings"]) mkdirSync(join(dir, d));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("Teams 行を読み、5 分前に 1 回だけ開く（再起動しても開かない）", () => {
		writeFileSync(join(dir, "calendar", "upcoming.md"), upcoming("2026-11-13T09:00"));
		writeJob("ok");
		expect(readDayPlan(dir, "2026-11-13").events[0]?.meet).toBe(TEAMS);

		let now = at("09:54");
		const opened: string[] = [];
		const toasts: string[] = [];
		const make = () => new MeetingOpener({ managerDir: dir, open: (u) => opened.push(u), toast: (t) => toasts.push(t), now: () => now });
		const a = make();
		expect(a.tick()).toHaveLength(0);
		now = at("09:55");
		expect(a.tick()).toHaveLength(1);
		expect(a.tick()).toHaveLength(0);
		expect(make().tick()).toHaveLength(0);
		expect(opened).toEqual([TEAMS]);
		expect(toasts).toEqual(["会議を開いた: 10:00 自動作図_分科会（Teams）"]);
		const ledger = JSON.parse(readFileSync(join(dir, "state", "ui", "meeting-open.json"), "utf-8"));
		expect(ledger.opened).toHaveLength(1);
	});

	test("予定が古ければ開かず、知らせは 1 日 1 回", () => {
		writeFileSync(join(dir, "calendar", "upcoming.md"), upcoming("2026-11-11T21:00"));
		writeJob("error");
		const opened: string[] = [];
		const toasts: string[] = [];
		const o = new MeetingOpener({ managerDir: dir, open: (u) => opened.push(u), toast: (t) => toasts.push(t), now: () => at("09:56") });
		o.tick();
		o.tick();
		expect(opened).toHaveLength(0);
		expect(toasts).toHaveLength(1);
		expect(toasts[0]).toStartWith("予定が古いので会議を自動で開けない");
	});

	test("meeting_open: false なら何もしない", () => {
		writeFileSync(join(dir, "calendar", "upcoming.md"), upcoming("2026-11-13T09:00"));
		writeJob("ok");
		writeFileSync(join(dir, "settings", "manager-app.md"), "---\nmeeting_open: false\n---\n");
		const opened: string[] = [];
		new MeetingOpener({ managerDir: dir, open: (u) => opened.push(u), toast: () => {}, now: () => at("09:56") }).tick();
		expect(opened).toHaveLength(0);
	});
});
