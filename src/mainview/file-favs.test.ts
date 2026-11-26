import { expect, test } from "bun:test";
import { DEFAULT_FAVS, expandTilde, isFav, parseFavs, serializeFavs, tildeForm, toggleFav } from "./file-favs";

const home = "/Users/a";

test("初回（保存なし）は既定を種まきする", () => {
	expect(parseFavs(null)).toEqual(DEFAULT_FAVS);
	expect(DEFAULT_FAVS).toContain("~/.claude");
});
test("人が全部外して保存したら、既定は復活しない", () => {
	let p = parseFavs(null);
	for (const d of [...p]) p = toggleFav(p, expandTilde(d, home), home);
	expect(p).toEqual([]);
	expect(parseFavs(serializeFavs(p))).toEqual([]);
});
test("1 つ外した結果が残る", () => {
	const p = toggleFav(DEFAULT_FAVS, "/Users/a/Desktop", home);
	expect(parseFavs(serializeFavs(p))).not.toContain("~/Desktop");
	expect(parseFavs(serializeFavs(p))).toContain("~/Downloads");
});
test("壊れた・形の違う保存値は既定に戻る", () => {
	for (const raw of ["", "{", "null", "[]", '{"v":2,"paths":[]}', '{"v":1,"paths":[1]}', '{"v":1}']) {
		expect(parseFavs(raw)).toEqual(DEFAULT_FAVS);
	}
});
test("~ の展開・戻し・登録判定・追加", () => {
	expect(expandTilde("~/Documents/", home)).toBe("/Users/a/Documents");
	expect(expandTilde("~", home)).toBe("/Users/a");
	expect(expandTilde("/opt", home)).toBe("/opt");
	expect(tildeForm("/Users/a/x", home)).toBe("~/x");
	expect(tildeForm("/opt/x", home)).toBe("/opt/x");
	expect(isFav(["~/x"], "/Users/a/x", home)).toBe(true);
	expect(toggleFav([], "/Users/a/new", home)).toEqual(["~/new"]);
});
