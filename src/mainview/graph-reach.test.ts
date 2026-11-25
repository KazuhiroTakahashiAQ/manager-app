import { describe, expect, test } from "bun:test";
import { descendants, reach, type ReachEdge } from "./graph-reach";

const chain: ReachEdge[] = [
	{ a: "root", b: "child", down: "ab" },
	{ a: "child", b: "grand", down: "ab" },
	{ a: "grand", b: "great", down: "ab" },
	{ a: "root", b: "side" }, // 階層ではない（兼務・works_with）
];

describe("descendants", () => {
	test("孫・ひ孫まで", () => {
		expect([...descendants("root", chain)].sort()).toEqual(["child", "grand", "great"]);
		expect([...descendants("child", chain)].sort()).toEqual(["grand", "great"]);
	});
	test("down のないエッジはたどらない", () => {
		expect(descendants("root", chain).has("side")).toBe(false);
	});
	test("ba は b が上", () => {
		expect([...descendants("boss", [{ a: "sub", b: "boss", down: "ba" }])]).toEqual(["sub"]);
	});
	test("循環しても止まる", () => {
		const cyc: ReachEdge[] = [
			{ a: "a", b: "b", down: "ab" },
			{ a: "b", b: "c", down: "ab" },
			{ a: "c", b: "a", down: "ab" },
		];
		expect([...descendants("a", cyc)].sort()).toEqual(["b", "c"]);
	});
});

describe("reach", () => {
	test("本人・隣接・全子孫が光り、子孫へのエッジも光る", () => {
		const r = reach("root", chain);
		expect([...r.nodes].sort()).toEqual(["child", "grand", "great", "root", "side"]);
		expect(r.edges.size).toBe(4);
	});
	test("祖先側は従来どおり隣接だけ", () => {
		const r = reach("grand", chain);
		expect([...r.nodes].sort()).toEqual(["child", "grand", "great"]);
		expect(r.edges.has(chain[0]!)).toBe(false); // root-child は光らない
		expect(r.edges.has(chain[1]!)).toBe(true);
		expect(r.edges.has(chain[2]!)).toBe(true);
	});
});
