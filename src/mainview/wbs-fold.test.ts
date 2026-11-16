import { describe, expect, test } from "bun:test";
import { descendantCounts, hiddenFlags, parseCollapsed, serializeCollapsed, type FoldRow } from "./wbs-fold";

// A
//   A1
//     A1a
//   A2
// B
//   B1
// C
const rows: FoldRow[] = [
	{ key: "A", depth: 0 },
	{ key: "A1", depth: 1 },
	{ key: "A1a", depth: 2 },
	{ key: "A2", depth: 1 },
	{ key: "B", depth: 0 },
	{ key: "B1", depth: 1 },
	{ key: "C", depth: 0 },
];
const visible = (collapsed: string[]) => rows.filter((_, i) => !hiddenFlags(rows, new Set(collapsed))[i]).map((r) => r.key);

describe("descendantCounts", () => {
	test("孫以降も数える", () => {
		expect(descendantCounts(rows)).toEqual([3, 1, 0, 0, 1, 0, 0]);
	});
	test("空", () => {
		expect(descendantCounts([])).toEqual([]);
	});
});

describe("hiddenFlags", () => {
	test("何も畳まなければ全部見える", () => {
		expect(visible([])).toEqual(["A", "A1", "A1a", "A2", "B", "B1", "C"]);
	});
	test("親を畳むと子も孫も隠れ、次の兄弟は見える", () => {
		expect(visible(["A"])).toEqual(["A", "B", "B1", "C"]);
	});
	test("中間の親だけ畳むと孫だけ隠れる", () => {
		expect(visible(["A1"])).toEqual(["A", "A1", "A2", "B", "B1", "C"]);
	});
	test("畳んだ親の下で畳まれた子があっても、親を開けば子の状態に戻る", () => {
		expect(visible(["A", "A1"])).toEqual(["A", "B", "B1", "C"]);
		expect(visible(["A1"])).toEqual(["A", "A1", "A2", "B", "B1", "C"]);
	});
	test("子のない行のキーが入っていても何も隠さない", () => {
		expect(visible(["C", "A2"])).toEqual(["A", "A1", "A1a", "A2", "B", "B1", "C"]);
	});
});

describe("保存", () => {
	test("壊れた値・型違いは空にする", () => {
		expect([...parseCollapsed(null)]).toEqual([]);
		expect([...parseCollapsed("{bad")]).toEqual([]);
		expect([...parseCollapsed('{"a":1}')]).toEqual([]);
		expect([...parseCollapsed('["a", 1, "b"]')]).toEqual(["a", "b"]);
	});
	test("いまある親だけ残す", () => {
		expect(serializeCollapsed(new Set(["tasks/x.md", "tasks/gone.md"]), ["tasks/x.md", "tasks/y.md"])).toBe('["tasks/x.md"]');
	});
});
