import { describe, expect, test } from "bun:test";
import { classifyChange, debounce, projectRootFrom } from "./dev-reload";

describe("projectRootFrom", () => {
	const roots = new Set(["/r/manager-app", "/other"]);
	const isRoot = (d: string) => roots.has(d);

	test("dev のアプリの cwd（build/ の下）からルートを取る", () => {
		expect(projectRootFrom("/r/manager-app/build/dev-macos-arm64/manager-dev.app/Contents/MacOS", {}, isRoot)).toBe("/r/manager-app");
	});

	test("build/ の下でなければ INIT_CWD・PWD を見る", () => {
		expect(projectRootFrom("/Applications/x.app/Contents/MacOS", { INIT_CWD: "/nope", PWD: "/other" }, isRoot)).toBe("/other");
	});

	test("MANAGER_APP_ROOT を最優先する", () => {
		expect(projectRootFrom("/r/manager-app/build/dev/x", { MANAGER_APP_ROOT: "/other" }, isRoot)).toBe("/other");
	});

	test("どれもルートでなければ null", () => {
		expect(projectRootFrom("/a/b", { PWD: "/c" }, isRoot)).toBeNull();
	});
});

describe("classifyChange", () => {
	test("index.html / index.css は写すだけ", () => {
		expect(classifyChange("mainview/index.html")).toBe("copy");
		expect(classifyChange("mainview/index.css")).toBe("copy");
	});

	test("画面と共有の ts はバンドルし直す", () => {
		expect(classifyChange("mainview/index.ts")).toBe("bundle");
		expect(classifyChange("mainview/sub/x.tsx")).toBe("bundle");
		expect(classifyChange("shared/types.ts")).toBe("bundle");
	});

	test("テスト・隠しファイル・bun 側・その他は無視", () => {
		expect(classifyChange("mainview/layout.test.ts")).toBeNull();
		expect(classifyChange("mainview/.index.ts.swp")).toBeNull();
		expect(classifyChange("bun/index.ts")).toBeNull();
		expect(classifyChange("mainview/notes.md")).toBeNull();
		expect(classifyChange("mainview/other.css")).toBeNull();
	});
});

describe("debounce", () => {
	test("続けて呼んでも最後の 1 回だけ動く", async () => {
		let n = 0;
		const f = debounce(() => n++, 10);
		f();
		f();
		f();
		expect(n).toBe(0);
		await Bun.sleep(30);
		expect(n).toBe(1);
	});
});
