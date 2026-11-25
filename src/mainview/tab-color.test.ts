import { describe, expect, test } from "bun:test";
import { FIXED_HUE, TASK_HUES, tabColor, tabHue } from "./tab-color";

describe("tab-color", () => {
	test("固定タブは固定色", () => {
		expect(tabHue("main", "main")).toBe(FIXED_HUE.main);
		expect(tabHue("system", "x")).toBe(FIXED_HUE.system);
		expect(tabHue("self", "y")).toBe(FIXED_HUE.self);
	});
	test("sub mgr は同じ id なら同じ色（決定的）", () => {
		expect(tabColor("task", "tasks/設計.md")).toBe(tabColor("task", "tasks/設計.md"));
	});
	test("sub mgr の色相は固定タブから 25 度以上離れる", () => {
		for (const h of TASK_HUES)
			for (const f of Object.values(FIXED_HUE)) {
				const d = Math.abs(h - f);
				expect(Math.min(d, 360 - d)).toBeGreaterThanOrEqual(25);
			}
	});
	test("色は id だけで決まる（ほかのタブの有無に依らない）", () => {
		const a = tabHue("task", "tasks/a.md");
		tabHue("task", "tasks/b.md");
		expect(tabHue("task", "tasks/a.md")).toBe(a);
	});
	test("いろいろな id が複数の色に散る", () => {
		const hues = new Set(Array.from({ length: 40 }, (_, i) => tabHue("task", `tasks/t${i}.md`)));
		expect(hues.size).toBeGreaterThan(4);
	});
});
