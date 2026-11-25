import { describe, expect, test } from "bun:test";
import { closeBrief, daysSince, decideClose, type CloseTask, type CloseTerm } from "./closer";

const today = "2026-11-25";
const term = (name: string, o: Partial<CloseTerm> = {}): CloseTerm => ({
	id: `task:tasks/${name}.md`,
	kind: "task",
	title: name,
	taskPath: `tasks/${name}.md`,
	running: true,
	ready: true,
	waiting: false,
	...o,
});
const task = (name: string, fm: Record<string, string> = {}): CloseTask => ({
	name,
	path: `tasks/${name}.md`,
	fm: { status: "done", updated: "2026-11-24", next_action: "なし（完了）", ...fm },
});
const run = (o: Partial<Parameters<typeof decideClose>[0]>) => decideClose({ terms: [], tasks: [], messages: [], handoffs: [], today, ...o });

describe("decideClose", () => {
	test("done / dropped は閉じる。doing は閉じない", () => {
		const d = run({
			terms: [term("a"), term("b"), term("c")],
			tasks: [task("a"), task("b", { status: "dropped" }), task("c", { status: "doing" })],
		});
		expect(d.close.map((x) => x.title)).toEqual(["a", "b"]);
		expect(d.hold).toEqual([]);
	});
	test("ノートが読めないタブは触らない", () => {
		expect(run({ terms: [term("x")] }).close).toEqual([]);
	});
	test("固定タブは対象外", () => {
		const fixed: CloseTerm[] = (["main", "system", "self"] as const).map((k) => ({ id: k, kind: k, title: k, taskPath: null, running: true, ready: true, waiting: false }));
		expect(run({ terms: fixed }).close).toEqual([]);
	});
	test("子が開いている親は閉じない。子がみな完了なら閉じる", () => {
		const parent = task("親");
		const kid = (s: string) => task("子", { parent: "親", status: s });
		expect(run({ terms: [term("親")], tasks: [parent, kid("doing")] }).close).toEqual([]);
		expect(run({ terms: [term("親")], tasks: [parent, kid("done")] }).close.length).toBe(1);
	});
	test("入力中・出力中・判断待ちは次に回す", () => {
		const d = run({ terms: [term("a", { ready: false }), term("b", { waiting: true, ready: false })], tasks: [task("a"), task("b")] });
		expect(d.close).toEqual([]);
		expect(d.defer.map((x) => x.reason)).toEqual(["入力中・出力中", "判断待ち"]);
	});
	test("claude が止まっているタブは、ready でなくても閉じる", () => {
		expect(run({ terms: [term("a", { running: false, ready: false })], tasks: [task("a")] }).close.length).toBe(1);
	});
	test("updated が古い・next_action が空は hold", () => {
		const d = run({ terms: [term("a"), term("b")], tasks: [task("a", { updated: "2026-10-01" }), task("b", { next_action: "" })] });
		expect(d.close).toEqual([]);
		expect(d.hold.length).toBe(2);
	});
	test("未処理の handoff・messages があれば hold", () => {
		const d = run({
			terms: [term("a"), term("b"), term("c")],
			tasks: [task("a"), task("b"), task("c")],
			handoffs: [{ to: "tasks/a.md", from: "mgr" }, { to: "main", from: "b" }],
			messages: [{ path: "messages/m.md", fm: { status: "未読", task: "c" } }],
		});
		expect(d.close).toEqual([]);
		expect(d.hold.map((x) => x.title)).toEqual(["a", "b", "c"]);
	});
	test("完了済みの message は無視", () => {
		const d = run({ terms: [term("a")], tasks: [task("a")], messages: [{ path: "m", fm: { status: "完了", task: "a" } }] });
		expect(d.close.length).toBe(1);
	});
});

test("daysSince", () => {
	expect(daysSince("2026-11-24", today)).toBe(1);
	expect(daysSince("", today)).toBeNull();
});

test("closeBrief", () => {
	expect(closeBrief([], [])).toBeNull();
	expect(closeBrief(["a", "b"], [])).toBe("完了済みの sub mgr を自動で閉じた: a、b");
	expect(closeBrief([], [{ title: "c", reason: "r" }])).toContain("c（r）");
});
