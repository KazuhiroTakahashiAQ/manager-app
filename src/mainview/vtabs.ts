import type { WaitKind } from "../shared/types";

// 縦タブの幅（左端のドラッグ）とツールチップの位置の計算。DOM に触らない純関数だけを置く。

export const VTABS_MIN = 120;
export const VTABS_MAX = 480;
export const VTABS_DEFAULT = 200;
/** ターミナル本体（縦タブの左）に残す最小幅。狭い窓で潰さない */
export const TERM_MIN = 240;

/** localStorage の値を幅にする。不正なら既定 */
export function parseVtabsW(raw: string | null): number {
	const n = raw === null || raw.trim() === "" ? Number.NaN : Number(raw);
	return Number.isFinite(n) ? clampVtabsW(n) : VTABS_DEFAULT;
}

/** 幅を範囲に収める。dockW（ドックの幅）が分かれば、ターミナル本体の最小幅を割らない上限も掛ける */
export function clampVtabsW(w: number, dockW?: number): number {
	if (!Number.isFinite(w)) return VTABS_DEFAULT;
	let max = VTABS_MAX;
	if (dockW !== undefined && Number.isFinite(dockW) && dockW > 0) max = Math.min(max, Math.max(VTABS_MIN, dockW - TERM_MIN));
	return Math.round(Math.min(Math.max(w, VTABS_MIN), max));
}

/** ポインタの x（縦タブの左端がここに来る）から幅を出す。dockRight はドックの右端 */
export function vtabsWFromPointer(pointerX: number, dockRight: number, dockW: number): number {
	return clampVtabsW(dockRight - pointerX, dockW);
}

/** ツールチップの位置。対象の左に出し、入らなければ右、縦は画面内に収める */
export function tipPosition(
	target: { left: number; right: number; top: number },
	tip: { w: number; h: number },
	view: { w: number; h: number },
	gap = 8,
	margin = 4,
): { left: number; top: number } {
	let left = target.left - gap - tip.w;
	if (left < margin) left = Math.min(target.right + gap, view.w - tip.w - margin);
	left = Math.max(margin, left);
	const top = Math.max(margin, Math.min(target.top, view.h - tip.h - margin));
	return { left, top };
}

/** 判断待ちの種類の表示名（タブのツールチップ） */
export const WAIT_LABEL: Record<WaitKind, string> = { permission: "許可確認", question: "質問", plan: "承認" };
