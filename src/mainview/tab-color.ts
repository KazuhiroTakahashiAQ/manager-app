// 縦タブの色。固定タブ（mgr / システム / 自己改善）は固定色、sub mgr は id（タスクのパス）のハッシュで決まる。
// 同じ id なら再起動しても同じ色。タブが増減しても他のタブの色は変わらない（id だけで決まる）。

/** 固定タブの色相 */
export const FIXED_HUE = { main: 205, system: 30, self: 285 } as const;
/** sub mgr の色相。固定タブの色相から 25 度以上離す */
export const TASK_HUES = [55, 90, 125, 155, 180, 245, 320, 350] as const;

/** FNV-1a（32bit）。決定的でよい */
export function hashId(id: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

export function tabHue(kind: string, id: string): number {
	if (kind === "main" || kind === "system" || kind === "self") return FIXED_HUE[kind];
	return TASK_HUES[hashId(id) % TASK_HUES.length]!;
}

/** ダーク背景で見える明度・彩度 */
export function tabColor(kind: string, id: string): string {
	return `hsl(${tabHue(kind, id)} 65% 66%)`;
}
