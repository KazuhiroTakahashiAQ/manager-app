import { describe, expect, test } from "bun:test";
import {
	RUN_ACTIVE_MS,
	isRunActive,
	noteBusy,
	parseBusyAt,
	parseRunFold,
	reconcileRunFold,
	serializeBusyAt,
	serializeRunFold,
	setRunOpen,
	type RunFold,
} from "./runs-fold";

const NOW = 1_800_000_000_000;
const sig = (o: Partial<Parameters<typeof isRunActive>[0]> = {}) => ({ running: true, busy: false, lastBusyAt: 0, workerRunning: false, ...o });

describe("isRunActive", () => {
	test("出力中なら会話中", () => expect(isRunActive(sig({ busy: true }), NOW)).toBe(true));
	test("最後の出力から閾値内なら会話中、過ぎたら途切れた", () => {
		expect(isRunActive(sig({ lastBusyAt: NOW - RUN_ACTIVE_MS + 1000 }), NOW)).toBe(true);
		expect(isRunActive(sig({ lastBusyAt: NOW - RUN_ACTIVE_MS }), NOW)).toBe(false);
	});
	test("出力の記録がなければ途切れた", () => expect(isRunActive(sig(), NOW)).toBe(false));
	test("claude が止まっていれば、最近の出力があっても途切れた", () =>
		expect(isRunActive(sig({ running: false, lastBusyAt: NOW - 1000 }), NOW)).toBe(false));
	test("worker が作業中なら会話中", () => expect(isRunActive(sig({ running: false, workerRunning: true }), NOW)).toBe(true));
});

describe("noteBusy", () => {
	test("出力中と、出力中から止まった瞬間に時刻を入れる", () => {
		let r = noteBusy(new Map(), new Set(), [{ id: "a", active: true }, { id: "b", active: false }], 100);
		expect([...r.lastBusyAt]).toEqual([["a", 100]]);
		expect([...r.busy]).toEqual(["a"]);
		// 長い出力が終わった知らせ（a が false に）。終わった時刻で上書きする
		r = noteBusy(r.lastBusyAt, r.busy, [{ id: "a", active: false }, { id: "b", active: false }], 500);
		expect(r.lastBusyAt.get("a")).toBe(500);
		expect(r.busy.size).toBe(0);
		// 止まったままなら動かさない
		r = noteBusy(r.lastBusyAt, r.busy, [{ id: "a", active: false }], 900);
		expect(r.lastBusyAt.get("a")).toBe(500);
	});
});

const m = (o: Record<string, [boolean, boolean]>) => new Map(Object.entries(o).map(([k, [open, wasActive]]) => [k, { open, wasActive }]));
const opens = (x: Map<string, RunFold>) => Object.fromEntries([...x].map(([k, f]) => [k, f.open]));

describe("reconcileRunFold", () => {
	test("初めて見る項目は、会話中なら開き、そうでなければ畳む", () => {
		const r = reconcileRunFold(new Map(), [{ key: "a", active: true }, { key: "b", active: false }]);
		expect(opens(r)).toEqual({ a: true, b: false });
	});
	test("判定が変わった瞬間に合わせて開閉する", () => {
		const r = reconcileRunFold(m({ a: [true, true], b: [false, false] }), [{ key: "a", active: false }, { key: "b", active: true }]);
		expect(opens(r)).toEqual({ a: false, b: true });
	});
	test("手で開閉したものは、判定が変わるまで自動で戻さない", () => {
		let r = reconcileRunFold(new Map(), [{ key: "a", active: false }, { key: "b", active: true }]);
		r = setRunOpen(r, "a", true); // 途切れたものを手で開く
		r = setRunOpen(r, "b", false); // 会話中のものを手で畳む
		// 再描画が何度来ても保つ
		r = reconcileRunFold(r, [{ key: "a", active: false }, { key: "b", active: true }]);
		r = reconcileRunFold(r, [{ key: "a", active: false }, { key: "b", active: true }]);
		expect(opens(r)).toEqual({ a: true, b: false });
		// 判定が変わったら自動に戻る
		r = reconcileRunFold(r, [{ key: "a", active: true }, { key: "b", active: false }]);
		r = reconcileRunFold(r, [{ key: "a", active: false }, { key: "b", active: true }]);
		expect(opens(r)).toEqual({ a: false, b: true });
	});
	test("いまの項目だけ残す", () => {
		const r = reconcileRunFold(m({ gone: [true, true] }), [{ key: "a", active: false }]);
		expect([...r.keys()]).toEqual(["a"]);
	});
	test("知らない項目の手動指定は無視する", () => expect(setRunOpen(new Map(), "x", true).size).toBe(0));
});

describe("保存", () => {
	test("開閉の往復", () => {
		const x = m({ b: [false, true], a: [true, false] });
		expect(parseRunFold(serializeRunFold(x))).toEqual(x);
		expect(serializeRunFold(x)).toBe('{"a":[true,false],"b":[false,true]}');
	});
	test("壊れた値は空、型の違う要素は捨てる", () => {
		expect(parseRunFold(null).size).toBe(0);
		expect(parseRunFold("{").size).toBe(0);
		expect(parseRunFold("[1]").size).toBe(0);
		expect(opens(parseRunFold('{"a":[true,true],"b":"x","c":[1,0]}'))).toEqual({ a: true });
	});
	test("出力の時刻はいまあるセッションだけ保存する", () => {
		const s = serializeBusyAt(new Map([["a", 1], ["gone", 2]]), ["a"]);
		expect(s).toBe('{"a":1}');
		expect([...parseBusyAt(s)]).toEqual([["a", 1]]);
		expect(parseBusyAt("oops").size).toBe(0);
		expect(parseBusyAt('{"a":"1"}').size).toBe(0);
	});
});
