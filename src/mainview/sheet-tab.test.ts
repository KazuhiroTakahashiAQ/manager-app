import { describe, expect, test } from "bun:test";
import { isSheetHub, SHEET_TAB, shouldRefreshSheet, sheetHtml } from "./sheet-tab";
import { dynamicDocTabs } from "./readme-tab";

describe("sheet-tab", () => {
	test("isSheetHub", () => {
		expect(isSheetHub({ app: "sheet-preview" })).toBe(true);
		expect(isSheetHub({ app: "other" })).toBe(false);
		expect(isSheetHub(null)).toBe(false);
	});
	test("shouldRefreshSheet", () => {
		expect(shouldRefreshSheet(SHEET_TAB, true)).toBe(true);
		expect(shouldRefreshSheet(SHEET_TAB, false)).toBe(false);
		expect(shouldRefreshSheet("app:now", true)).toBe(false);
	});
	test("sheetHtml は未起動なら iframe を出さない", () => {
		expect(sheetHtml(false)).not.toContain("<iframe");
		expect(sheetHtml(false)).toContain("再確認");
		expect(sheetHtml(true)).toContain("allow-same-origin");
	});
	test("固定タブは dynamicDocTabs から除く", () => {
		expect(dynamicDocTabs([{ path: SHEET_TAB }, { path: "tasks/a.md" }])).toEqual([{ path: "tasks/a.md" }]);
	});
});
