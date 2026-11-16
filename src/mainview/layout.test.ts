import { describe, expect, test } from "bun:test";
import { RATIO_MAX, RATIO_MIN, clampRatio, gridFlex, ratioFromPointer } from "./layout";

const fr = (s: string) => Number(s.replace(/fr$/, ""));

describe("gridFlex", () => {
	test("合計は 100fr、どちらも 1fr 以上（片方が最小値で固定されても余りが空白にならない）", () => {
		for (const r of [0, 0.2, 0.3, 0.5, 0.7, 0.85, 1, 0.123456]) {
			const { board, dock } = gridFlex(r);
			expect(fr(board) + fr(dock)).toBeCloseTo(100, 6);
			expect(fr(board)).toBeGreaterThanOrEqual(1);
			expect(fr(dock)).toBeGreaterThanOrEqual(1);
		}
	});
	test("7:3", () => {
		expect(gridFlex(0.7)).toEqual({ board: "70fr", dock: "30fr" });
	});
	test("範囲外・NaN は丸める", () => {
		expect(gridFlex(0.05)).toEqual({ board: `${RATIO_MIN * 100}fr`, dock: `${100 - RATIO_MIN * 100}fr` });
		expect(clampRatio(Number.NaN)).toBe(0.7);
		expect(clampRatio(2)).toBe(RATIO_MAX);
	});
});

describe("ratioFromPointer", () => {
	const min = { board: 360, dock: 280 };
	// 盤面とターミナルの範囲 8..1432（幅 1424）、境界 8px → 2 つの領域の合計 1416
	const start = 8;
	const end = 1432;
	const gutter = 8;
	const avail = end - start - gutter;

	test("境界の中心がポインタに来る", () => {
		const x = start + 700 + gutter / 2;
		expect(ratioFromPointer(x, start, end, gutter, min)).toBeCloseTo(700 / avail, 6);
	});
	test("盤面の最小値より左には行かない（ターミナルの右に空白を作らない）", () => {
		const r = ratioFromPointer(0, start, end, gutter, min);
		expect(r * avail).toBeGreaterThanOrEqual(min.board - 1e-6);
	});
	test("ターミナルの最小値より右には行かない", () => {
		const r = ratioFromPointer(5000, start, end, gutter, min);
		expect((1 - r) * avail).toBeGreaterThanOrEqual(min.dock - 1e-6);
		expect(r).toBeLessThanOrEqual(RATIO_MAX);
	});
	test("狭すぎる窓では最小値の比にする", () => {
		expect(ratioFromPointer(100, 0, 500, 8, min)).toBeCloseTo(clampRatio(360 / 640), 6);
	});
});
