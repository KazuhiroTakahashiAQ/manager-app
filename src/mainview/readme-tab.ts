// 「README」タブ（アプリ自身の README.md を読み取り専用で出す）。
// 実体は bun 側 RPC readReadme（開くたびに読み直す）。タブは常にダッシュボードの隣に出す。

import { NOW_LABEL, NOW_TAB } from "./now-tab";

export const README_TAB = "app:readme";
export const README_LABEL = "README";

/** ノートのタブの表示名 */
export function docLabel(path: string): string {
	if (path === README_TAB) return README_LABEL;
	if (path === NOW_TAB) return NOW_LABEL;
	return path.split("/").pop()!.replace(/\.md$/, "");
}

/** 並びの後ろに出す「開いたノート」のタブ。今・README は固定タブで別に出すので除く */
export function dynamicDocTabs<T extends { path: string }>(tabs: readonly T[]): T[] {
	return tabs.filter((t) => t.path !== README_TAB && t.path !== NOW_TAB);
}

/** 画面が再び見えたときに README を読み直すか（README を見ている最中だけ） */
export function shouldRefreshReadme(currentPath: string | null | undefined, visible: boolean): boolean {
	return visible && currentPath === README_TAB;
}
