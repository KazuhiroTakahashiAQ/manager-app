import { expect, test } from "bun:test";
import { iconFor } from "./file-icons";

test("フォルダは開閉で別グリフ、ファイルは名前 → 語尾の順に引く", () => {
	expect(iconFor("src", true).glyph).toBe("");
	expect(iconFor("src", true, true).glyph).toBe("");
	const ts = iconFor("a.ts", false);
	expect(ts.glyph).not.toBe(iconFor("a.unknownext", false).glyph);
	expect(iconFor("a.test.ts", false).glyph).toBeTruthy();
	expect(iconFor("Makefile.unknownext", false).glyph).toBe("");
	expect(iconFor("noext", false).glyph).toBe("");
	expect(iconFor("constructor", false).glyph).toBe(""); // prototype 由来を拾わない
});
test("暗い色は明るくする", () => {
	const c = iconFor(".ds_store", false).color; // 元は #41535b（暗い）
	expect(c).not.toBe("#41535b");
});
