// 「今」タブ（ダッシュボード / 今 / README の並び）。集中用の画面で、一覧は出さない。
// 中身は bun 側 RPC now（開くたびに読み直す）。未回答の問い合わせ件数はタブのバッジにだけ出す。

export const NOW_TAB = "app:now";
export const NOW_LABEL = "今";

/** タブのバッジ（0 件なら出さない） */
export function nowBadge(count: number): string {
	if (count <= 0) return "";
	return count > 9 ? "9+" : String(count);
}

/** 画面が再び見えたときに「今」を読み直すか（今を見ている最中だけ） */
export function shouldRefreshNow(currentPath: string | null | undefined, visible: boolean): boolean {
	return visible && currentPath === NOW_TAB;
}

/** 返信欄の入力が送れる形か（空白だけは送らない） */
export function canSendReply(text: string): boolean {
	return text.trim() !== "";
}
