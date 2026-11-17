import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readReadme, readmePath } from "./readme";

const dirs: string[] = [];
const mk = () => {
	const d = mkdtempSync(join(tmpdir(), "readme-"));
	dirs.push(d);
	writeFileSync(join(d, "electrobun.config.ts"), "");
	return d;
};
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("readmePath", () => {
	test("MANAGER_APP_ROOT を使う", () => {
		const d = mk();
		writeFileSync(join(d, "README.md"), "x");
		expect(readmePath("/nowhere", { MANAGER_APP_ROOT: d })).toBe(join(d, "README.md"));
	});
	test("build の手前を探す", () => {
		const d = mk();
		writeFileSync(join(d, "README.md"), "x");
		mkdirSync(join(d, "build", "dev", "a"), { recursive: true });
		expect(readmePath(join(d, "build", "dev", "a"), {})).toBe(join(d, "README.md"));
	});
	test("どこにもなければ null", () => {
		expect(readmePath("/nowhere", {}, () => false, "/h")).toBeNull();
	});
	test("root が見つからなければホームの既定へ", () => {
		const want = "/h/Documents/work/manager-app/README.md";
		expect(readmePath("/nowhere", {}, (p) => p === want, "/h")).toBe(want);
	});
});

describe("readReadme", () => {
	test("読むたびに最新の内容になる", () => {
		const d = mk();
		const env = { MANAGER_APP_ROOT: d };
		writeFileSync(join(d, "README.md"), "# one");
		expect(readReadme("/nowhere", env)?.body).toBe("# one");
		writeFileSync(join(d, "README.md"), "# two");
		const doc = readReadme("/nowhere", env)!;
		expect(doc.body).toBe("# two");
		expect(doc.path).toBe("app:readme");
		expect(doc.fm).toEqual({});
	});
});
