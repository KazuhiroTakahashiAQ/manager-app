// File タブのアイコン。Claude Mod の filepicker（~/Documents/github/Claude/Claude.Mod/filepicker、MIT）と同じ流儀:
// nvim-web-devicons（MIT、Copyright (c) 2023 nvim-tree）から生成した表（devicons.ts。LICENSE.nvim-web-devicons）を
// ファイル名全体 → ドット区切りの長い語尾の順に引く。Nerd Font のグリフ（このアプリのターミナルと同じ Nerd Font）で描く。
// 表に無ければ普通のファイル。暗すぎる色はダークテーマで読めるよう明るくする（filepicker の legible と同じ）。

import { DEVICONS_BY_EXT, DEVICONS_BY_NAME } from "./devicons";

export type Icon = { glyph: string; color: string };

const FOLDER_COLOR = "#c9a25a";
const FILE: Icon = { glyph: "", color: "#8b9488" };

function legible(hex: string): string {
	if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
	if ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 >= 0.35) return hex;
	const mix = (v: number) => Math.round(v + (255 - v) * 0.45).toString(16).padStart(2, "0");
	return `#${mix(r)}${mix(g)}${mix(b)}`;
}

const own = <T>(t: Record<string, T>, k: string): T | undefined => (Object.hasOwn(t, k) ? t[k] : undefined);
const pick = (e: readonly [string, string] | undefined): Icon | null => (e ? { glyph: e[0], color: legible(e[1]) } : null);

export function iconFor(name: string, dir: boolean, open = false): Icon {
	if (dir) return { glyph: open ? "" : "", color: FOLDER_COLOR };
	const lower = name.toLowerCase();
	const whole = pick(own(DEVICONS_BY_NAME, name) ?? own(DEVICONS_BY_NAME, lower));
	if (whole) return whole;
	const parts = name.split(".");
	for (let i = 1; i < parts.length; i++) {
		if (i === 1 && parts[0] === "") continue;
		const ending = parts.slice(i).join(".");
		const hit = pick(own(DEVICONS_BY_EXT, ending) ?? own(DEVICONS_BY_EXT, ending.toLowerCase()));
		if (hit) return hit;
	}
	return FILE;
}

/** 一覧・ツリー用の <span>（フォントは CSS .ft-gi） */
export function iconHtml(name: string, dir: boolean, open = false): string {
	const i = iconFor(name, dir, open);
	return `<span class="ft-gi" style="color:${i.color}" aria-hidden="true">${i.glyph}</span>`;
}
