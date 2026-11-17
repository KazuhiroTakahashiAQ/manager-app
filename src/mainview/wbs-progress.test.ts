import { describe, expect, test } from "bun:test";
import { linePosition, lineSvg, ownLinePosition, parseLineOpts, progressRatio, rolledUpPosition, type PosNode } from "./wbs-progress";

const leaf = (own: number | null, closed = false): PosNode => ({ own, closed, children: [] });
const parent = (own: number | null, ...children: PosNode[]): PosNode => ({ own, closed: false, children });

describe("ownLinePosition", () => {
	test("予定がない・期限が着手より前は null（当日のラインに逃がさない）", () => {
		expect(ownLinePosition({ todayIdx: 2, startIdx: null, dueIdx: 8, ratio: 0.5, n: 17 })).toBeNull();
		expect(ownLinePosition({ todayIdx: 2, startIdx: 6, dueIdx: 3, ratio: 0.5, n: 17 })).toBeNull();
	});
	test("予定があれば linePosition と同じ", () => {
		expect(ownLinePosition({ todayIdx: 2, startIdx: 0, dueIdx: 3, ratio: 0.5, n: 17 })).toBe(2);
		expect(ownLinePosition({ todayIdx: 2, startIdx: 5, dueIdx: 9, ratio: 0, n: 17 })).toBe(2.5); // 着手前は当日
	});
});

describe("rolledUpPosition（親は子の最遅）", () => {
	test("子なしは自身の位置（従来どおり）", () => {
		expect(rolledUpPosition(leaf(4))).toBe(4);
		expect(rolledUpPosition(leaf(null))).toBeNull();
	});
	test("子 1 つなら、親の自身の進捗に関係なくその子の位置", () => {
		expect(rolledUpPosition(parent(9, leaf(1.5)))).toBe(1.5);
		expect(rolledUpPosition(parent(0, leaf(6)))).toBe(6); // 親が子より遅れて見えない
	});
	test("複数の子・遅れと先行の混在は最も遅れている（最も左の）子", () => {
		expect(rolledUpPosition(parent(5, leaf(3), leaf(1), leaf(2)))).toBe(1);
		expect(rolledUpPosition(parent(2.5, leaf(6), leaf(0.5), leaf(8)))).toBe(0.5);
	});
	test("孫は再帰して末端の最遅を採る（中間の親自身の位置は使わない）", () => {
		const mid = parent(7, leaf(5), leaf(4));
		expect(rolledUpPosition(parent(9, mid, leaf(6)))).toBe(4);
		expect(rolledUpPosition(parent(9, parent(0.5, leaf(6)), leaf(7)))).toBe(6);
	});
	test("線の位置が取れない子・閉じた子は除き、取れる子だけで決める", () => {
		expect(rolledUpPosition(parent(9, leaf(null), leaf(3)))).toBe(3);
		expect(rolledUpPosition(parent(9, leaf(0, true), leaf(3)))).toBe(3); // 完了した子は線を通さない
		expect(rolledUpPosition(parent(9, { own: 0, closed: true, children: [leaf(1)] }, leaf(3)))).toBe(3); // 閉じた子は子孫ごと除く
	});
	test("取れる子が 1 つもなければ親自身の位置", () => {
		expect(rolledUpPosition(parent(4, leaf(null), leaf(2, true)))).toBe(4);
		expect(rolledUpPosition(parent(4, parent(null, leaf(null))))).toBe(4);
		expect(rolledUpPosition(parent(null, leaf(null)))).toBeNull();
	});
	test("子を持つ中間の親は、子が取れなければ自身の位置で効く", () => {
		expect(rolledUpPosition(parent(9, parent(3, leaf(null)), leaf(5)))).toBe(3);
	});
	test("循環しても止まる", () => {
		const a: PosNode = { own: 4, closed: false, children: [] };
		const b: PosNode = { own: 2, closed: false, children: [a] };
		a.children.push(b);
		expect(rolledUpPosition(a)).toBe(2);
	});
});

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
	test("子の最遅に合わせた親の頂点は rollup を付ける", () => {
		const svg = lineSvg([{ x: 5, y: 0 }, { x: 2, y: 5, rollup: true }, { x: 5, y: 9 }], 5);
		expect(svg).toContain('<circle class="behind rollup" cx="2" cy="5" r="3.5"/>');
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
