import { describe, expect, test } from "bun:test";
import { TERM_MIN, VTABS_DEFAULT, VTABS_MAX, VTABS_MIN, clampVtabsW, parseVtabsW, tipPosition, vtabsWFromPointer } from "./vtabs";

describe("parseVtabsW", () => {
	test("保存値を復元、範囲外は丸める、不正は既定", () => {
		expect(parseVtabsW("260")).toBe(260);
		expect(parseVtabsW("10")).toBe(VTABS_MIN);
		expect(parseVtabsW("9999")).toBe(VTABS_MAX);
		expect(parseVtabsW(null)).toBe(VTABS_DEFAULT);
		expect(parseVtabsW("")).toBe(VTABS_DEFAULT);
		expect(parseVtabsW("abc")).toBe(VTABS_DEFAULT);
	});
});

describe("clampVtabsW", () => {
	test("ドックが狭いときはターミナル本体の最小幅を残す", () => {
		expect(clampVtabsW(480, 600)).toBe(600 - TERM_MIN);
		expect(clampVtabsW(480, 1000)).toBe(480);
	});
	test("極端に狭くても下限を割らない", () => {
		expect(clampVtabsW(300, 300)).toBe(VTABS_MIN);
	});
});

describe("vtabsWFromPointer", () => {
	test("左端がポインタに来る", () => {
		expect(vtabsWFromPointer(1200, 1400, 900)).toBe(200);
		expect(vtabsWFromPointer(0, 1400, 900)).toBe(480);
		expect(vtabsWFromPointer(1399, 1400, 900)).toBe(VTABS_MIN);
	});
});

describe("tipPosition", () => {
	const view = { w: 1000, h: 700 };
	test("対象の左に出す", () => {
		expect(tipPosition({ left: 800, right: 1000, top: 100 }, { w: 200, h: 50 }, view)).toEqual({ left: 592, top: 100 });
	});
	test("下にはみ出すなら押し上げる", () => {
		expect(tipPosition({ left: 800, right: 1000, top: 690 }, { w: 200, h: 50 }, view).top).toBe(646);
	});
	test("左に入らなければ右に出し、画面内に収める", () => {
		const p = tipPosition({ left: 100, right: 300, top: 10 }, { w: 400, h: 50 }, view);
		expect(p.left).toBeGreaterThanOrEqual(4);
		expect(p.left + 400).toBeLessThanOrEqual(996);
	});
});
