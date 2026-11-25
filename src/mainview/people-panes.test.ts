import { describe, expect, test } from "bun:test";
import { closeDetail, deselect, detailVisible, initialPanes, parseOrgsOpen, select, toggleOrgs } from "./people-panes";

describe("詳細パネル", () => {
	test("未選択では出さない", () => {
		expect(detailVisible(initialPanes())).toBe(false);
	});
	test("選択すると出て、選択を外すと消える", () => {
		const s = select(initialPanes());
		expect(detailVisible(s)).toBe(true);
		expect(detailVisible(deselect(s))).toBe(false);
	});
	test("人が閉じたら選択中でも閉じたまま。選び直すと開く", () => {
		const c = closeDetail(select(initialPanes()));
		expect(c.hasSel).toBe(true);
		expect(detailVisible(c)).toBe(false);
		expect(detailVisible(select(c))).toBe(true);
	});
	test("閉じたあと選択を外して選び直しても開く", () => {
		const c = deselect(closeDetail(select(initialPanes())));
		expect(c.detailClosed).toBe(false);
		expect(detailVisible(select(c))).toBe(true);
	});
});

describe("組織ツリー", () => {
	test("開閉は詳細の状態に影響しない", () => {
		const s = toggleOrgs(select(initialPanes()));
		expect(s.orgsOpen).toBe(false);
		expect(detailVisible(s)).toBe(true);
		expect(toggleOrgs(s).orgsOpen).toBe(true);
	});
	test("保存値: 0 だけ閉じる。空・壊れた値は開く", () => {
		expect(parseOrgsOpen("0")).toBe(false);
		for (const v of [null, undefined, "", "1", "x", "{"]) expect(parseOrgsOpen(v)).toBe(true);
	});
});
