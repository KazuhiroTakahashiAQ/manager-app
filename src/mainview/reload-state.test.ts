import { describe, expect, test } from "bun:test";
import { RELOAD_MAX_AGE_MS, decodeReloadState, encodeReloadState, pickTerm, type ReloadState } from "./reload-state";

const NOW = 1_800_000_000_000;
const base: ReloadState = {
	term: "t-abc",
	docs: [
		{ path: "tasks/a.md", label: "a", scroll: 120 },
		{ path: "graph:ideas", label: "アイデアのグラフ", scroll: 0 },
	],
	current: "tasks/a.md",
	at: NOW,
};

describe("reload-state", () => {
	test("書いた控えをそのまま戻せる", () => {
		expect(decodeReloadState(encodeReloadState(base), NOW + 500)).toEqual(base);
	});

	test("空・壊れた JSON・形が違うものは null", () => {
		expect(decodeReloadState(null, NOW)).toBeNull();
		expect(decodeReloadState("", NOW)).toBeNull();
		expect(decodeReloadState("{oops", NOW)).toBeNull();
		expect(decodeReloadState("[]", NOW)).toBeNull();
		expect(decodeReloadState(JSON.stringify({ ...base, term: 1 }), NOW)).toBeNull();
		expect(decodeReloadState(JSON.stringify({ ...base, docs: "x" }), NOW)).toBeNull();
	});

	test("古い控え（と未来の時刻）は使わない", () => {
		expect(decodeReloadState(encodeReloadState(base), NOW + RELOAD_MAX_AGE_MS + 1)).toBeNull();
		expect(decodeReloadState(encodeReloadState({ ...base, at: NOW + RELOAD_MAX_AGE_MS + 1 }), NOW)).toBeNull();
	});

	test("壊れたタブ・重複は落とし、スクロールは 0 以上の数にする", () => {
		const raw = JSON.stringify({
			...base,
			docs: [{ path: "a.md", label: "a", scroll: -5 }, { path: "a.md", label: "a2", scroll: 1 }, { path: "", label: "x" }, null, { path: "b.md", label: "b", scroll: "9" }],
			current: "a.md",
		});
		expect(decodeReloadState(raw, NOW)).toEqual({
			term: "t-abc",
			docs: [
				{ path: "a.md", label: "a", scroll: 0 },
				{ path: "b.md", label: "b", scroll: 0 },
			],
			current: "a.md",
			at: NOW,
		});
	});

	test("タブにないノートを current にしていたらダッシュボードに戻す", () => {
		expect(decodeReloadState(JSON.stringify({ ...base, current: "tasks/z.md" }), NOW)?.current).toBeNull();
	});

	test("pickTerm は今あるターミナルだけを選ぶ", () => {
		expect(pickTerm("t-abc", ["main", "t-abc"])).toBe("t-abc");
		expect(pickTerm("t-gone", ["main", "t-abc"])).toBe("main");
		expect(pickTerm(null, ["main"])).toBe("main");
		expect(pickTerm(undefined, [], "x")).toBe("x");
	});
});
