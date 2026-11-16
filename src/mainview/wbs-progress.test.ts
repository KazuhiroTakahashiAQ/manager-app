import { describe, expect, test } from "bun:test";
import { linePosition, lineSvg, parseLineOpts, progressRatio } from "./wbs-progress";

const base = { childrenDone: 0, childrenTotal: 0, stepsDone: 0, stepsTotal: 0, done: false };

describe("progressRatio", () => {
	test("完了は 1", () => expect(progressRatio({ ...base, explicit: "10", done: true })).toBe(1));
	test("記録した progress を最優先（% 付き・小数・範囲外も可）", () => {
		expect(progressRatio({ ...base, explicit: "40", childrenDone: 1, childrenTotal: 2 })).toBeCloseTo(0.4);
		expect(progressRatio({ ...base, explicit: " 25% " })).toBeCloseTo(0.25);
		expect(progressRatio({ ...base, explicit: "150" })).toBe(1);
		expect(progressRatio({ ...base, explicit: "0" , stepsDone: 1, stepsTotal: 2 })).toBe(0);
	});
	test("空・不正値は自動（子 > 手順 > 0）", () => {
		expect(progressRatio({ ...base, explicit: "", childrenDone: 1, childrenTotal: 4, stepsDone: 3, stepsTotal: 4 })).toBeCloseTo(0.25);
		expect(progressRatio({ ...base, explicit: "半分", stepsDone: 1, stepsTotal: 4 })).toBeCloseTo(0.25);
		expect(progressRatio(base)).toBe(0);
	});
});

describe("linePosition", () => {
	const n = 17;
	const today = 2; // 今日は 3 列目
	test("予定がない（start か due が空）は当日のライン", () => {
		expect(linePosition({ todayIdx: today, startIdx: null, dueIdx: 8, ratio: 0.5, n })).toBe(2.5);
		expect(linePosition({ todayIdx: today, startIdx: 3, dueIdx: null, ratio: 0.5, n })).toBe(2.5);
	});
	test("着手前で進捗 0 は当日のライン", () => {
		expect(linePosition({ todayIdx: today, startIdx: 5, dueIdx: 9, ratio: 0, n })).toBe(2.5);
	});
	test("帯の ratio の位置（今日より左なら遅れ、右なら先行）", () => {
		// 帯は列 0〜3（4 日）。50% は 2.0
		expect(linePosition({ todayIdx: today, startIdx: 0, dueIdx: 3, ratio: 0.5, n })).toBe(2);
		expect(linePosition({ todayIdx: today, startIdx: 0, dueIdx: 3, ratio: 0, n })).toBe(0); // 着手済みで 0 は遅れ
		expect(linePosition({ todayIdx: today, startIdx: 0, dueIdx: 9, ratio: 0.9, n })).toBe(9);
	});
	test("表の外へは出ない", () => {
		expect(linePosition({ todayIdx: today, startIdx: -5, dueIdx: -1, ratio: 0.2, n })).toBe(0);
		expect(linePosition({ todayIdx: today, startIdx: 10, dueIdx: 40, ratio: 0.9, n })).toBe(17);
	});
	test("期限が着手より前なら当日のライン", () => {
		expect(linePosition({ todayIdx: today, startIdx: 6, dueIdx: 3, ratio: 0.5, n })).toBe(2.5);
	});
});

describe("lineSvg", () => {
	test("線分は中点、頂点は位置で遅れ・先行を分ける（両端の今日には丸を打たない）", () => {
		const svg = lineSvg(
			[
				{ x: 50, y: 0 },
				{ x: 20, y: 10 },
				{ x: 80, y: 20 },
				{ x: 50.5, y: 30 },
				{ x: 50, y: 40 },
			],
			50,
		);
		expect(svg.match(/<polyline/g)?.length).toBe(4);
		expect(svg.match(/<circle/g)?.length).toBe(3);
		expect(svg).toContain('<polyline class="seg behind" points="50,0 20,10"/>');
		expect(svg).toContain('<polyline class="seg " points="20,10 80,20"/>'); // 今日をまたぐ線分（中点が今日）は黒
		expect(svg).toContain('<polyline class="seg ahead" points="80,20 50.5,30"/>');
		expect(svg).toContain('<circle class="behind" cx="20" cy="10" r="3.5"/>');
		expect(svg).toContain('<circle class="ahead" cx="80" cy="20" r="3.5"/>');
		expect(svg).toContain('<circle class="" cx="50.5" cy="30" r="3.5"/>');
	});
	test("目印がなければ今日の縦線 1 本", () => {
		expect(lineSvg([{ x: 5, y: 0 }, { x: 5, y: 9 }], 5)).toBe('<polyline class="seg " points="5,0 5,9"/>');
	});
});

describe("parseLineOpts", () => {
	test("既定は両方オン。壊れた値でも既定", () => {
		expect(parseLineOpts(null)).toEqual({ line: true, color: true });
		expect(parseLineOpts("{")).toEqual({ line: true, color: true });
		expect(parseLineOpts("null")).toEqual({ line: true, color: true });
	});
	test("保存した値を読む", () => {
		expect(parseLineOpts('{"line":false,"color":true}')).toEqual({ line: false, color: true });
		expect(parseLineOpts('{"color":false}')).toEqual({ line: true, color: false });
	});
});
