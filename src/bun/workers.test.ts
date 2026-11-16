import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { judgeState, parseNotifications, readParentNotices, type Notice, type WorkerFacts } from "./workers";

const NOW = 1_800_000_000_000;
const base: WorkerFacts = { now: NOW, updatedAt: NOW - 1000, metaAt: 0, finished: false, stoppedByUser: false };

const note = (id: string, status: string, at: string) =>
	JSON.stringify({
		type: "queue-operation",
		operation: "enqueue",
		timestamp: at,
		content: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>Agent "x"</summary>\n</task-notification>`,
	});

describe("judgeState", () => {
	test("更新が新しければ作業中", () => {
		expect(judgeState(base)).toEqual({ state: "running", endedAt: 0 });
	});

	test("5 分更新がなければ止まっている", () => {
		const updatedAt = NOW - 6 * 60 * 1000;
		expect(judgeState({ ...base, updatedAt })).toEqual({ state: "stalled", endedAt: updatedAt });
	});

	test("meta の finished は最後が tool_use でも完了", () => {
		const metaAt = NOW - 30_000;
		expect(judgeState({ ...base, updatedAt: metaAt - 500, metaAt, finished: true })).toEqual({ state: "done", endedAt: metaAt });
	});

	test("完了のあと jsonl が進んでいれば（再開）作業中", () => {
		expect(judgeState({ ...base, updatedAt: NOW - 1000, metaAt: NOW - 60_000, finished: true }).state).toBe("running");
	});

	test("killed の通知は止めた、failed は失敗", () => {
		const at = NOW - 20_000;
		expect(judgeState({ ...base, updatedAt: at, notice: { status: "killed", at } })).toEqual({ state: "killed", endedAt: at });
		expect(judgeState({ ...base, updatedAt: at, notice: { status: "failed", at } }).state).toBe("failed");
	});

	test("meta の stoppedByUser は止めた", () => {
		const metaAt = NOW - 20_000;
		expect(judgeState({ ...base, updatedAt: metaAt, metaAt, stoppedByUser: true }).state).toBe("killed");
	});

	test("止めたあと再開されて完了すれば完了", () => {
		const facts: WorkerFacts = { ...base, updatedAt: NOW - 5000, metaAt: NOW - 5000, finished: true, notice: { status: "killed", at: NOW - 600_000 } };
		expect(judgeState(facts).state).toBe("done");
	});

	test("meta がなくても completed の通知で完了", () => {
		const at = NOW - 90_000;
		expect(judgeState({ ...base, updatedAt: at - 1000, notice: { status: "completed", at } }).state).toBe("done");
	});
});

describe("parseNotifications", () => {
	test("queue-operation の enqueue だけを拾い、同じ id は後が勝つ", () => {
		const notes = new Map<string, Notice>();
		parseNotifications(
			[
				note("a1", "killed", "2026-11-11T04:00:42.661Z"),
				JSON.stringify({ type: "queue-operation", operation: "remove", timestamp: "2026-11-11T04:00:48Z", content: "<task-notification><task-id>a2</task-id><status>killed</status>" }),
				JSON.stringify({ type: "user", message: { content: "<task-notification><task-id>a3</task-id><status>failed</status>" } }),
				"{壊れた行",
				note("a1", "completed", "2026-11-11T04:10:00.000Z"),
			],
			notes,
		);
		expect([...notes.keys()]).toEqual(["a1"]);
		expect(notes.get("a1")).toEqual({ status: "completed", at: Date.parse("2026-11-11T04:10:00.000Z") });
	});
});

describe("readParentNotices", () => {
	test("前回の続きだけ読み、途中の行は次に回す", () => {
		const dir = mkdtempSync(join(tmpdir(), "workers-test-"));
		try {
			const path = join(dir, "s.jsonl");
			const cache = new Map();
			const first = note("a1", "killed", "2026-11-11T04:00:00Z");
			const second = note("a2", "completed", "2026-11-11T05:00:00Z");
			writeFileSync(path, `${first}\n${second.slice(0, 40)}`);
			expect([...readParentNotices(path, cache).keys()]).toEqual(["a1"]);
			appendFileSync(path, `${second.slice(40)}\n`);
			const notes = readParentNotices(path, cache);
			expect(notes.get("a2")?.status).toBe("completed");
			expect(notes.get("a1")?.status).toBe("killed");
			// 作り直されたら読み直す
			writeFileSync(path, `${note("a3", "failed", "2026-11-11T06:00:00Z")}\n`);
			expect([...readParentNotices(path, cache).keys()]).toEqual(["a3"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
