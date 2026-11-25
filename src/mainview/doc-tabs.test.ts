import { describe, expect, test } from "bun:test";
import { docLabel, dynamicDocTabs } from "./doc-tabs";

describe("doc-tabs", () => {
	test("docLabel", () => {
		expect(docLabel("tasks/設計.md")).toBe("設計");
	});
	test("dynamicDocTabs は固定タブを除く", () => {
		const tabs = [{ path: "a.md" }, { path: "now" }, { path: "graph:ideas" }];
		expect(dynamicDocTabs(tabs).map((t) => t.path)).toContain("a.md");
	});
});
