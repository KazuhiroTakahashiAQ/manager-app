import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { clearWaitingFile, detectPtyWaiting, parseWaitingFile, plainTail, ptyWaiting, readWaitingFile, waitingPath } from "./waiting";

describe("parseWaitingFile", () => {
	test("種類を読む", () => {
		expect(parseWaitingFile('{"session":"s1","kind":"permission"}', "s1")).toBe("permission");
		expect(parseWaitingFile('{"kind":"question"}', "s1")).toBe("question");
		expect(parseWaitingFile('{"session":"","kind":"plan"}', "s1")).toBe("plan");
	});
	test("別セッションの残り・壊れた中身・未知の種類は null", () => {
		expect(parseWaitingFile('{"session":"old","kind":"permission"}', "s1")).toBeNull();
		expect(parseWaitingFile("{", "s1")).toBeNull();
		expect(parseWaitingFile('{"kind":"idle"}', "s1")).toBeNull();
		expect(parseWaitingFile("null", "s1")).toBeNull();
	});
});

describe("pty の判定", () => {
	test("許可確認・選択・plan の目印", () => {
		expect(detectPtyWaiting("Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel")).toBe("permission");
		expect(detectPtyWaiting("Enter to select · ↑/↓ to navigate · Esc to cancel")).toBe("question");
		expect(detectPtyWaiting("Would you like to proceed?\n❯ 1. Yes, auto-accept edits")).toBe("plan");
		expect(detectPtyWaiting("作業が終わりました。次は何をしますか")).toBeNull();
	});
	test("制御文字を落とす", () => {
		expect(plainTail("\x1b[1mDo you want\x1b[0m \x1b]0;t\x07to proceed")).toBe("Do you want to proceed");
	});
	test("応答済み（出力後に人が入力）・描画直後は判定しない", () => {
		const tail = "Do you want to proceed?";
		expect(ptyWaiting(tail, 1000, 500, 2000)).toBe("permission");
		expect(ptyWaiting(tail, 1000, 1500, 2000)).toBeNull();
		expect(ptyWaiting(tail, 1900, 0, 2000)).toBeNull();
	});
});

describe("印ファイル", () => {
	test("読む・消す", () => {
		const cwd = mkdtempSync(join(tmpdir(), "wait-"));
		mkdirSync(join(cwd, "state", "ui"), { recursive: true });
		expect(readWaitingFile(cwd, "task:tasks/a.md", "s1")).toBeNull();
		writeFileSync(waitingPath(cwd, "task:tasks/a.md"), '{"thread":"task:tasks/a.md","session":"s1","kind":"question","at":1}');
		expect(waitingPath(cwd, "task:tasks/a.md").endsWith("waiting-task_tasks_a_md.json")).toBe(true);
		expect(readWaitingFile(cwd, "task:tasks/a.md", "s1")).toBe("question");
		expect(readWaitingFile(cwd, "task:tasks/a.md", "other")).toBeNull();
		clearWaitingFile(cwd, "task:tasks/a.md");
		expect(readWaitingFile(cwd, "task:tasks/a.md", "s1")).toBeNull();
	});
});
