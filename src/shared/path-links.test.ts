import { expect, test } from "bun:test";
import { findPathCandidates } from "./path-links";

const paths = (s: string) => findPathCandidates(s).map((c) => c.path);

test("絶対・~・相対・拡張子つきを拾う", () => {
	expect(paths("見て /Users/x/a.md と ~/work/b.ts と ./c/d.py ../e と docs/f.md と README.md")).toEqual([
		"/Users/x/a.md",
		"~/work/b.ts",
		"./c/d.py",
		"../e",
		"docs/f.md",
		"README.md",
	]);
});
test("URL・バージョン・ただの単語は拾わない", () => {
	expect(paths("https://example.com/a/b.html v1.2.3 1.2.3 hello world")).toEqual([]);
});
test("行番号は分け、位置は path 部分だけ", () => {
	const [c] = findPathCandidates("at src/a.ts:12:3 ok");
	expect(c).toMatchObject({ path: "src/a.ts", line: 12, start: 3, end: 11 });
});
test("括弧・引用・末尾の句読点を外す", () => {
	expect(paths("(see `docs/a.md`). また \"b/c.txt\", d/e.")).toEqual(["docs/a.md", "b/c.txt", "d/e"]);
});
