// 盤面とターミナルの割り付け（境界のドラッグ）の計算。DOM に触らない純関数だけを置く。

/** 盤面の割合（盤面 / (盤面 + ターミナル)）の上下限 */
export const RATIO_MIN = 0.2;
export const RATIO_MAX = 0.85;

/** 各領域の最小の大きさ（px）。index.css の grid-template の minmax の最小値と合わせる */
export const MIN_SIZE = {
	right: { board: 360, dock: 440 },
	bottom: { board: 200, dock: 160 },
} as const;

/**
 * grid の fr の値。合計を 100 にする。
 * 0.7fr / 0.3fr のように合計が 1 ちょうどだと、片方が minmax の最小値に当たって固定されたとき、
 * 残る fr の合計が 1 未満になり、余った幅が誰にも配られず右端（下端）に空白が残る（CSS Grid の仕様）。
 * どちらの値も 1 以上にしておけば、残った側が余りを全部もらう。
 */
export function gridFlex(ratio: number): { board: string; dock: string } {
	const r = clampRatio(ratio);
	const board = Math.round(r * 10000) / 100;
	const dock = Math.round((100 - board) * 100) / 100;
	return { board: `${board}fr`, dock: `${dock}fr` };
}

export function clampRatio(ratio: number): number {
	if (!Number.isFinite(ratio)) return 0.7;
	return Math.min(Math.max(ratio, RATIO_MIN), RATIO_MAX);
}

/**
 * ポインタの位置から盤面の割合を出す。
 * start / end は 2 つの領域と境界を合わせた範囲（.app の padding の内側）、gutter は境界の太さ。
 * どちらの領域も最小値を割らないように px で抑え、境界がポインタについてくるようにする。
 */
export function ratioFromPointer(
	pos: number,
	start: number,
	end: number,
	gutter: number,
	min: { board: number; dock: number },
): number {
	const avail = end - start - gutter;
	if (!(avail > 0)) return clampRatio(0.7);
	if (avail <= min.board + min.dock) return clampRatio(min.board / (min.board + min.dock));
	const board = Math.min(Math.max(pos - start - gutter / 2, min.board), avail - min.dock);
	return clampRatio(board / avail);
}
