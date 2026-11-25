import { describe, expect, test } from "bun:test";
import { canSendReply, NOW_TAB, nowBadge, shouldRefreshNow } from "./now-tab";
import { docLabel, dynamicDocTabs } from "./doc-tabs";
import { decodeReloadState, encodeReloadState } from "./reload-state";

describe("now-tab", () => {
	test("nowBadge", () => {
		expect(nowBadge(0)).toBe("");
		expect(nowBadge(3)).toBe("3");
		expect(nowBadge(12)).toBe("9+");
	});
	test("shouldRefreshNow は今を見ている最中だけ", () => {
		expect(shouldRefreshNow(NOW_TAB, true)).toBe(true);
		expect(shouldRefreshNow(NOW_TAB, false)).toBe(false);
		expect(shouldRefreshNow("a.md", true)).toBe(false);
		expect(shouldRefreshNow(null, true)).toBe(false);
	});
	test("canSendReply", () => {
		expect(canSendReply("  \n")).toBe(false);
		expect(canSendReply(" はい ")).toBe(true);
	});
	test("固定タブは動的タブに出さず、ラベルは今", () => {
		const tabs = [{ path: "a.md" }, { path: NOW_TAB }];
		expect(dynamicDocTabs(tabs).map((t) => t.path)).toEqual(["a.md"]);
		expect(docLabel(NOW_TAB)).toBe("今");
	});
	test("リロードの控えに今タブが含まれても戻せる", () => {
		const now = Date.now();
		const raw = encodeReloadState({ term: "main", docs: [{ path: NOW_TAB, label: "今", scroll: 40 }], current: NOW_TAB, at: now });
		const s = decodeReloadState(raw, now + 1000);
		expect(s?.current).toBe(NOW_TAB);
		expect(s?.docs[0]?.scroll).toBe(40);
	});
});
