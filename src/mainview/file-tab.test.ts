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
