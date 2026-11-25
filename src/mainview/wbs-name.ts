/** WBS 表の表示用ロジック（DOM に触れない。単体テストできる形） */

const SEPS = ["_", "＿", " / ", "/", " › ", "›", "："];

/** 子の表示名。ファイル名が「親名_子名」の規約なら親名の接頭辞を取る。取った結果が空なら元のまま */
export function childLabel(name: string, parent: string): string {
	if (!parent || !name.startsWith(parent)) return name;
	const rest = name.slice(parent.length);
	for (const sep of SEPS) {
		if (rest.startsWith(sep)) {
			const out = rest.slice(sep.length).trim();
			return out || name;
		}
	}
	return name;
}

export const NAME_W_KEY = "wbsNameW";
export const NAME_W_DEFAULT = 380;
export const NAME_W_MIN = 160;
export const NAME_W_MAX = 900;

export function clampNameW(w: number): number {
	if (!Number.isFinite(w)) return NAME_W_DEFAULT;
	return Math.min(NAME_W_MAX, Math.max(NAME_W_MIN, Math.round(w)));
}

/** 保存値（文字列）から幅を復元。なければ既定 */
export function parseNameW(raw: string | null): number {
	if (raw == null || raw.trim() === "") return NAME_W_DEFAULT;
	return clampNameW(Number(raw));
}
