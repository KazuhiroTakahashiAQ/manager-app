// File タブの一覧の表示用（純粋関数）。列 = 名前 / 更新日時 / 種類 / サイズ。

import type { FileEntry } from "../shared/types";

export type SortKey = "name" | "mtime" | "kind" | "size";
export type Sort = { key: SortKey; asc: boolean };

const KINDS: Record<string, string> = {
	md: "Markdown", txt: "テキスト", json: "JSON", yaml: "YAML", yml: "YAML", csv: "CSV", tsv: "TSV", log: "ログ",
	ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", py: "Python", sh: "シェル", html: "HTML", css: "CSS",
	png: "PNG 画像", jpg: "JPEG 画像", jpeg: "JPEG 画像", gif: "GIF 画像", svg: "SVG 画像", webp: "WebP 画像", heic: "HEIC 画像",
	pdf: "PDF", doc: "Word", docx: "Word", xls: "Excel", xlsx: "Excel", ppt: "PowerPoint", pptx: "PowerPoint",
	zip: "ZIP", gz: "圧縮", tar: "アーカイブ", dmg: "ディスクイメージ", mp4: "動画", mov: "動画", mp3: "音声", wav: "音声",
	drawio: "draw.io", base: "Obsidian Base", canvas: "Obsidian Canvas",
};

export function extOf(name: string): string {
	const i = name.lastIndexOf(".");
	return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : "";
}

/** 種類の表示名（フォルダ / 拡張子から / 「XYZ ファイル」/ ファイル） */
export function kindLabel(e: Pick<FileEntry, "name" | "dir">): string {
	if (e.dir) return "フォルダ";
	const x = extOf(e.name);
	return x ? (KINDS[x] ?? `${x.toUpperCase()} ファイル`) : "ファイル";
}

export function formatSize(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function formatDate(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** フォルダは常に先。その中を列で並べ、同順位は名前順 */
export function sortEntries(list: FileEntry[], s: Sort): FileEntry[] {
	const byName = (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name, "ja", { numeric: true });
	const cmp = (a: FileEntry, b: FileEntry): number => {
		if (s.key === "mtime") return a.mtime - b.mtime;
		if (s.key === "size") return a.size - b.size;
		if (s.key === "kind") return kindLabel(a).localeCompare(kindLabel(b), "ja");
		return byName(a, b);
	};
	return [...list].sort((a, b) => Number(b.dir) - Number(a.dir) || (cmp(a, b) || byName(a, b)) * (s.asc ? 1 : -1));
}
