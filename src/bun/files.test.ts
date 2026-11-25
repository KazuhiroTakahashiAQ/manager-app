import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { claudeCwd, listDir, parseLsofCwd, QuickLook, resolveInput } from "./files";

const dirs: string[] = [];
const mk = () => {
	const d = mkdtempSync(join(tmpdir(), "files-"));
	dirs.push(d);
	mkdirSync(join(d, "sub"));
	mkdirSync(join(d, ".git"));
	writeFileSync(join(d, "b.md"), "x");
	writeFileSync(join(d, "a.txt"), "xx");
	writeFileSync(join(d, ".env"), "");
	writeFileSync(join(d, "sub", "c.md"), "");
	return d;
};
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("listDir", () => {
	test("ディレクトリが先、名前順。隠しは既定で出さない", () => {
		const d = mk();
		const r = listDir(d, false);
		expect(r.ok).toBe(true);
		expect(r.entries.map((e) => e.name)).toEqual(["sub", "a.txt", "b.md"]);
		expect(r.entries[0]!.dir).toBe(true);
	});
	test("hidden なら隠しも出す", () => {
		const r = listDir(mk(), true);
		expect(r.entries.map((e) => e.name)).toEqual([".git", "sub", ".env", "a.txt", "b.md"]);
	});
	test("parent と、存在しないパス", () => {
		const d = mk();
		expect(listDir(join(d, "sub"), false).parent).toBe(d);
		expect(listDir("/", false).parent).toBeNull();
		expect(listDir(join(d, "nope"), false).ok).toBe(false);
	});
});

describe("resolveInput", () => {
	test("絶対・相対（cwd 起点）・.. を正規化する", () => {
		const d = mk();
		expect(resolveInput(join(d, "b.md"), "/")).toEqual({ ok: true, path: join(d, "b.md"), dir: false });
		expect(resolveInput("sub/c.md", d)).toEqual({ ok: true, path: join(d, "sub", "c.md"), dir: false });
		expect(resolveInput("../sub", join(d, "sub"))).toEqual({ ok: true, path: join(d, "sub"), dir: true });
	});
	test("~ はホーム", () => {
		const d = mk();
		expect(resolveInput("~/sub", "/", d)).toEqual({ ok: true, path: join(d, "sub"), dir: true });
	});
	test("存在しない・空はエラー", () => {
		const d = mk();
		expect(resolveInput("nope", d).ok).toBe(false);
		expect(resolveInput("  ", d).ok).toBe(false);
	});
});

describe("claudeCwd", () => {
	test("lsof の出力を読む", () => {
		expect(parseLsofCwd("p123\nfcwd\nn/Users/x/proj\n")).toBe("/Users/x/proj");
		expect(parseLsofCwd("")).toBeNull();
	});
	test("取れれば live、pid なし・失敗・消えていればフォールバック", async () => {
		const ok = () => Promise.resolve("p1\nfcwd\nn/a/b\n");
		expect(await claudeCwd(1, "/fb", ok, () => true)).toEqual({ cwd: "/a/b", live: true });
		expect(await claudeCwd(null, "/fb", ok, () => true)).toEqual({ cwd: "/fb", live: false });
		expect(await claudeCwd(1, "/fb", () => Promise.reject(new Error("x")), () => true)).toEqual({ cwd: "/fb", live: false });
		expect(await claudeCwd(1, "/fb", ok, () => false)).toEqual({ cwd: "/fb", live: false });
	});
});

describe("QuickLook", () => {
	test("開く → もう一度で kill、自分で閉じられたら状態が戻る", async () => {
		const d = mk();
		const killed: number[] = [];
		let done!: () => void;
		const run = () => ({ kill: () => void killed.push(1), exited: new Promise<number>((r) => (done = () => r(0))) });
		const ql = new QuickLook(run);
		expect(ql.toggle(join(d, "b.md"))).toBe(true);
		expect(ql.toggle(join(d, "b.md"))).toBe(false);
		expect(killed.length).toBe(1);
		expect(ql.toggle(join(d, "b.md"))).toBe(true);
		done();
		await Promise.resolve();
		await Promise.resolve();
		expect(ql.open).toBe(false);
		expect(ql.toggle("/no/such/file")).toBe(false);
	});
});
