import { describe, expect, test } from "bun:test";
import { overdueNote, parseAt, shouldSeedMessage } from "./catchup";

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();

describe("parseAt", () => {
	test("HH:MM は書いた日の時刻（昨日書いた 09:00 は昨日の 09:00 = 過ぎている）", () => {
		const now = new Date(2026, 10, 18, 8, 0);
		expect(parseAt("09:00", now, at(2026, 11, 17, 8, 0))).toBe(at(2026, 11, 17, 9, 0));
	});
	test("書いた時刻より前の HH:MM は翌日の意味", () => {
		const now = new Date(2026, 10, 17, 16, 0);
		expect(parseAt("09:00", now, at(2026, 11, 17, 15, 0))).toBe(at(2026, 11, 18, 9, 0));
	});
	test("base なしは今日、ISO はそのまま、読めなければ null", () => {
		const now = new Date(2026, 10, 18, 8, 0);
		expect(parseAt("15:00", now)).toBe(at(2026, 11, 18, 15, 0));
		expect(parseAt("2026-11-13T14:05:00+09:00", now)).toBe(Date.parse("2026-11-13T14:05:00+09:00"));
		expect(parseAt("あとで", now)).toBeNull();
	});
});

describe("overdueNote", () => {
	const t = at(2026, 11, 18, 9, 0);
	test("10 分未満の遅れは注記なし", () => expect(overdueNote(t, t + 9 * 60_000)).toBe(""));
	test("遅れた分を示す", () => {
		expect(overdueNote(t, t + 30 * 60_000)).toContain("30 分遅れて");
		expect(overdueNote(t, t + 5 * 3600_000)).toContain("約 5 時間遅れて");
	});
});

describe("shouldSeedMessage", () => {
	test("初回は seed", () => expect(shouldSeedMessage(100, null)).toBe(true));
	test("止まる前からあった未読は seed、止まっていた間に届いたものは seed しない", () => {
		expect(shouldSeedMessage(100, 200)).toBe(true);
		expect(shouldSeedMessage(300, 200)).toBe(false);
	});
});
