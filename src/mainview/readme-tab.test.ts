import { describe, expect, test } from "bun:test";
import { docLabel, dynamicDocTabs, README_TAB, shouldRefreshReadme } from "./readme-tab";

describe("readme-tab", () => {
	test("docLabel", () => {
		expect(docLabel(README_TAB)).toBe("README");
		expect(docLabel("tasks/設計.md")).toBe("設計");
	});
	test("dynamicDocTabs は README を除く", () => {
		const tabs = [{ path: "a.md" }, { path: README_TAB }, { path: "graph:ideas" }];
		expect(dynamicDocTabs(tabs).map((t) => t.path)).toEqual(["a.md", "graph:ideas"]);
	});
	test("shouldRefreshReadme", () => {
		expect(shouldRefreshReadme(README_TAB, true)).toBe(true);
		expect(shouldRefreshReadme(README_TAB, false)).toBe(false);
		expect(shouldRefreshReadme("a.md", true)).toBe(false);
		expect(shouldRefreshReadme(null, true)).toBe(false);
	});
});
