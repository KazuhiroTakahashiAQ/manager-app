// ノートのタブの表示名と、固定タブ（今・シート）を除いた並び。

import { NOW_LABEL, NOW_TAB } from "./now-tab";
import { SHEET_LABEL, SHEET_TAB } from "./sheet-tab";

/** ノートのタブの表示名 */
export function docLabel(path: string): string {
	if (path === NOW_TAB) return NOW_LABEL;
	if (path === SHEET_TAB) return SHEET_LABEL;
	return path.split("/").pop()!.replace(/\.md$/, "");
}

/** 並びの後ろに出す「開いたノート」のタブ。今・シートは固定タブで別に出すので除く */
export function dynamicDocTabs<T extends { path: string }>(tabs: readonly T[]): T[] {
	return tabs.filter((t) => t.path !== NOW_TAB && t.path !== SHEET_TAB);
}
