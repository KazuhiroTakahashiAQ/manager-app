import { describe, expect, test } from "bun:test";
import { rowKindClass, runKindClass } from "./seg";

describe("seg", () => {
	test("rowKindClass", () => {
		expect(rowKindClass("期限", false)).toBe("k-due");
		expect(rowKindClass("確認・急ぎ", false)).toBe("k-urgent");
		expect(rowKindClass("確認", false)).toBe("k-msg");
		expect(rowKindClass("未定義", true)).toBe("");
	});
	test("runKindClass", () => {
		expect(runKindClass("task")).toBe("rk-task");
		expect(runKindClass("main")).toBe("rk-main");
		expect(runKindClass("x y")).toBe("");
	});
});
