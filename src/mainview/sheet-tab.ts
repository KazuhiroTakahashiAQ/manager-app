// 「シート」タブ（sheet-preview のハブ http://localhost:8765/ を iframe で出す読み取りタブ）。
// ハブの起動はしない。未起動なら案内と「再確認」ボタンを出す。

export const SHEET_TAB = "app:sheet";
export const SHEET_LABEL = "シート";
export const SHEET_HUB = "http://localhost:8765/";
export const SHEET_PING = "http://127.0.0.1:8765/api/ping";
export const SHEET_START_CMD = "node ~/Documents/work/Claude.Harness/skills/sheet-preview/scripts/serve.ts";

/** ping の応答がシートのハブか */
export function isSheetHub(body: unknown): boolean {
	return typeof body === "object" && body !== null && (body as { app?: unknown }).app === "sheet-preview";
}

/** 画面が再び見えたときにシートを再確認するか（シートを見ている最中だけ） */
export function shouldRefreshSheet(currentPath: string | null | undefined, visible: boolean): boolean {
	return visible && currentPath === SHEET_TAB;
}

/** タブの中身（hub が生きているときだけ iframe。sandbox は動作に必要な最小。same-origin は POST の Origin 検査に必要） */
export function sheetHtml(alive: boolean): string {
	if (!alive) {
		return `<div class="sheet-down"><p>ハブ未起動。<code>${SHEET_START_CMD}</code> で起動</p><button type="button" class="quiet" data-sheet-recheck>再確認</button></div>`;
	}
	return `<iframe class="sheet-frame" title="シート" src="${SHEET_HUB}" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"></iframe>`;
}
