import { expect, test } from "bun:test";
import type { FileEntry } from "../shared/types";
import { formatDate, formatSize, kindLabel, sortEntries } from "./file-format";

const e = (name: string, dir: boolean, size = 0, mtime = 0): FileEntry => ({ name, path: `/x/${name}`, dir, size, mtime });
const names = (l: FileEntry[]) => l.map((x) => x.name);

test("種類の表示名", () => {
	expect(kindLabel(e("a", true))).toBe("フォルダ");
	expect(kindLabel(e("a.md", false))).toBe("Markdown");
	expect(kindLabel(e("a.xyz", false))).toBe("XYZ ファイル");
	expect(kindLabel(e("Makefile", false))).toBe("ファイル");
	expect(kindLabel(e(".env", false))).toBe("ファイル");
});
test("サイズと日時", () => {
	expect(formatSize(10)).toBe("10 B");
	expect(formatSize(2048)).toBe("2 KB");
	expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
	expect(formatDate(new Date(2026, 0, 2, 3, 4).getTime())).toBe("2026/01/02 03:04");
});
test("フォルダが常に先。列で並べ、降順でもフォルダは先", () => {
	const l = [e("b.md", false, 5, 20), e("d", true, 0, 1), e("a.txt", false, 9, 10), e("c", true, 0, 2)];
	expect(names(sortEntries(l, { key: "name", asc: true }))).toEqual(["c", "d", "a.txt", "b.md"]);
	expect(names(sortEntries(l, { key: "name", asc: false }))).toEqual(["d", "c", "b.md", "a.txt"]);
	expect(names(sortEntries(l, { key: "size", asc: false }))).toEqual(["d", "c", "a.txt", "b.md"]);
	expect(names(sortEntries(l, { key: "mtime", asc: true }))).toEqual(["d", "c", "a.txt", "b.md"]);
});
