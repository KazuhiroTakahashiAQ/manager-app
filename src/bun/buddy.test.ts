import { expect, test } from "bun:test";
import { defaultBuddyDir } from "./buddy";

const has = (...ok: string[]) => (p: string) => ok.includes(p);

test("BUDDY_DIR が最優先", () => {
	expect(defaultBuddyDir("/x", { BUDDY_DIR: "/b" }, () => false, "/h")).toBe("/b");
});

test("リポジトリ直下の buddy/（build の手前を root とみなす）", () => {
	const cwd = "/r/build/dev-macos-arm64/manager.app/Contents/MacOS";
	expect(defaultBuddyDir(cwd, {}, has("/r/electrobun.config.ts", "/r/buddy"), "/h")).toBe("/r/buddy");
});

test("root が見つからなければ ~/Documents/work/manager-app/buddy", () => {
	expect(defaultBuddyDir("/x", {}, () => false, "/h")).toBe("/h/Documents/work/manager-app/buddy");
});
