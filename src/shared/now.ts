// 「今」タブの判定（bun と画面で共有する純関数）。

/** 問い合わせの返信待ちの状態 */
const OPEN_STATUSES = ["未読", "対応中"];

/** messages のノートが人への問い合わせ（from あり）で、まだ片付いていないか */
export function isUnanswered(fm: Record<string, string>): boolean {
	return (fm["from"] ?? "").trim() !== "" && OPEN_STATUSES.includes((fm["status"] ?? "").trim());
}

export function unansweredCount(messages: readonly { fm: Record<string, string> }[]): number {
	return messages.filter((m) => isUnanswered(m.fm)).length;
}
