// ダッシュボードの色分け（小分類）に使うクラス名。色は index.css の --seg-* / --sub-* が決める。

/** 「今日決めること」の行の種類。期限 / 急ぎ / その他のメッセージ。着手の準備の行は ready-* が別に示す */
export function rowKindClass(kind: string, prep: boolean): string {
	if (prep) return "";
	if (kind === "期限") return "k-due";
	if (kind.endsWith("急ぎ")) return "k-urgent";
	return "k-msg";
}

/** 実行状況のセッションの役割（mgr / システム / sub mgr）の枠のクラス */
export function runKindClass(kind: string): string {
	return /^[a-z]+$/.test(kind) ? `rk-${kind}` : "";
}
