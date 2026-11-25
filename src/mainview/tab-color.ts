// 縦タブの色。色の定義はここに集約する（CSS・index.ts には色をハードコードしない）。
// モダンダーク: oklch の明度・彩度を固定し、色相だけ変える。
// 固定タブ（mgr 青 / システム オレンジ / 自己改善 紫）は固定色。sub mgr は 12 色の空きスロットを
// 開いた順に割り当てる（同時に開いているタブで重複しない。13 個目以降だけ重なる）。
// 割り当ては呼び出し側が保存し、次回は saved として渡す（再起動しても同じ色）。

export const TAB_L = 0.74;
export const TAB_C = 0.12;

/** 固定タブの色相（oklch） */
export const FIXED_HUE = { main: 250, system: 58, self: 298 } as const;

/** 24 度刻みの 15 色相のうち、固定タブの 3 つを除いた 12 色相（oklch）。固定タブと 24 度以上離れる */
const HUES = [10, 34, 82, 106, 130, 154, 178, 202, 226, 274, 322, 346] as const;
/** 続けて開いたタブが似た色にならないよう、スロットを 5 つ飛ばしで並べる（5 と 12 は互いに素） */
export const SLOT_COUNT = HUES.length;
export const SLOT_HUES: readonly number[] = HUES.map((_, i) => HUES[(i * 5) % HUES.length]!);

/** FNV-1a（32bit）。新しいタブの割り当ての起点にだけ使う */
export function hashId(id: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

/**
 * sub mgr の id（開いた順）→ スロット番号。saved にある有効なスロットは、重複しない限りそのまま使う。
 * 新しいタブは、ハッシュを起点に次の空きスロット。全部埋まっていれば使用数が最少のスロット。
 */
export function assignSlots(ids: readonly string[], saved: Readonly<Record<string, number>> = {}): Record<string, number> {
	const out: Record<string, number> = {};
	const used = new Array<number>(SLOT_COUNT).fill(0);
	const fresh: string[] = [];
	for (const id of ids) {
		const s = saved[id];
		if (Number.isInteger(s) && s! >= 0 && s! < SLOT_COUNT && used[s!] === 0) {
			out[id] = s!;
			used[s!]++;
		} else fresh.push(id);
	}
	for (const id of fresh) {
		const start = hashId(id) % SLOT_COUNT;
		let best = start;
		for (let k = 0; k < SLOT_COUNT; k++) {
			const s = (start + k) % SLOT_COUNT;
			if (used[s]! < used[best]!) best = s;
		}
		out[id] = best;
		used[best]!++;
	}
	return out;
}

export function slotHue(slot: number): number {
	return SLOT_HUES[((slot % SLOT_COUNT) + SLOT_COUNT) % SLOT_COUNT]!;
}

const css = (hue: number) => `oklch(${TAB_L} ${TAB_C} ${hue})`;

/** 固定タブの色 */
export function fixedColor(kind: "main" | "system" | "self"): string {
	return css(FIXED_HUE[kind]);
}
/** sub mgr の色 */
export function slotColor(slot: number): string {
	return css(slotHue(slot));
}
