import { expect, test } from "bun:test";
import { crumbs } from "./file-tab";

test("パンくずは / から順に", () => {
	expect(crumbs("/")).toEqual([{ name: "/", path: "/" }]);
	expect(crumbs("/a/b")).toEqual([
		{ name: "/", path: "/" },
		{ name: "a", path: "/a" },
		{ name: "b", path: "/a/b" },
	]);
});

import { ancestorsToOpen, treeRoots } from "./file-tab";

test("ツリーの根は重複を除く（cwd がホーム直下など）", () => {
	expect(treeRoots("/Users/a/proj", "/Users/a").map((r) => r.path)).toEqual(["/Users/a/proj", "/Users/a", "/"]);
	expect(treeRoots("/Users/a", "/Users/a").map((r) => r.path)).toEqual(["/Users/a", "/"]);
});
test("表示中フォルダの祖先を、最も深い根の下で開く", () => {
	const roots = treeRoots("/Users/a/proj", "/Users/a");
	expect(ancestorsToOpen("/Users/a/proj/x/y", roots)).toEqual({ root: roots[0]!, open: ["/Users/a/proj", "/Users/a/proj/x"] });
	expect(ancestorsToOpen("/Users/a/docs", roots)).toEqual({ root: roots[1]!, open: ["/Users/a"] });
	expect(ancestorsToOpen("/opt/homebrew", roots)).toEqual({ root: roots[2]!, open: ["/", "/opt"] });
	expect(ancestorsToOpen("/Users/a/proj", roots)?.open).toEqual(["/Users/a/proj"]);
});
