// 「シート」タブ（sheet-preview のハブ http://localhost:8765/ を iframe で出す読み取りタブ）。
// ハブの起動はアプリ起動時に bun 側（sheethub.ts）が行う。ここでは状態に応じて iframe か案内と「再確認」ボタンを出す。

export const SHEET_TAB = "app:sheet";
export const SHEET_LABEL = "シート";
export const SHEET_HUB = "http://localhost:8765/";
export const SHEET_PING = "http://127.0.0.1:8765/api/ping";
export const SHEET_START_CMD = "node ~/.claude/skills/sheet-preview/scripts/serve.ts";

/** ping の応答がシートのハブか */
export function isSheetHub(body: unknown): boolean {
	return typeof body === "object" && body !== null && (body as { app?: unknown }).app === "sheet-preview";
}

/** 画面が再び見えたときにシートを再確認するか（シートを見ている最中だけ） */
export function shouldRefreshSheet(currentPath: string | null | undefined, visible: boolean): boolean {
	return visible && currentPath === SHEET_TAB;
}

/** bun 側 sheethub.ts の状態 */
export type SheetState = "running" | "started" | "foreign" | "down" | "no-script" | "failed";

/** タブの中身（hub が生きているときだけ iframe。sandbox は動作に必要な最小。same-origin は POST の Origin 検査に必要） */
export function sheetHtml(state: SheetState | boolean): string {
	const s: SheetState = state === true ? "running" : state === false ? "down" : state;
	if (s === "running") {
		return `<iframe class="sheet-frame" title="シート" src="${SHEET_HUB}" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"></iframe>`;
	}
	const msg =
		s === "foreign"
			? "8765 が別プロセスで使用中（sheet-preview のハブではない）。そのプロセスを止めてから再確認"
			: s === "no-script"
				? `ハブ未起動（<code>${SHEET_START_CMD}</code> が見つからない）。sheet-preview skill を入れてから再確認`
				: `ハブ未起動。<code>${SHEET_START_CMD}</code> で起動`;
	return `<div class="sheet-down"><p>${msg}</p><button type="button" class="quiet" data-sheet-recheck>再確認</button></div>`;
}

/** シートタブの文字の拡大縮小（⌘- 縮小、⌘⇧- と ⌘= / ⌘+ 拡大、⌘0 既定）。該当しないキーは null */
export function sheetZoomStep(e: { code: string; shiftKey: boolean }): -1 | 1 | "reset" | null {
	if (e.code === "Minus") return e.shiftKey ? 1 : -1;
	if (e.code === "Equal") return 1;
	if (e.code === "Digit0") return "reset";
	return null;
}

/** ハブ（iframe）へ送るズーム指示。倍率の保存・表示はハブ側（template.html）が持つ */
export function sheetZoomMessage(step: -1 | 1 | "reset"): { type: "sheet-preview:zoom"; step: -1 | 1 | "reset" } {
	return { type: "sheet-preview:zoom", step };
}
