// WBS の進捗線（イナズマ線）。DOM に触れない部分だけ（テストできるように）

export type ProgressInput = {
	/** タスクノートの frontmatter `progress`（0〜100 のおおよその値。"40" "40%" も可）。空なら自動 */
	explicit?: string;
	childrenDone: number;
	childrenTotal: number;
	stepsDone: number;
	stepsTotal: number;
	done: boolean;
};

/** 進捗 0〜1。完了 > 記録した `progress` > 子の完了割合 > 手順のチェック割合 > 0 の順に採る */
export function progressRatio(i: ProgressInput): number {
	if (i.done) return 1;
	const m = /^(\d+(?:\.\d+)?)\s*%?$/.exec((i.explicit ?? "").trim());
	if (m) return Math.min(Math.max(Number(m[1]) / 100, 0), 1);
	if (i.childrenTotal > 0) return i.childrenDone / i.childrenTotal;
	if (i.stepsTotal > 0) return i.stepsDone / i.stepsTotal;
	return 0;
}

export type LineInput = {
	/** 表の左端から数えた今日の列（0 始まり） */
	todayIdx: number;
	/** 着手日・期限の列。決まっていなければ null（予定が来ていない） */
	startIdx: number | null;
	dueIdx: number | null;
	ratio: number;
	/** 表の日数 */
	n: number;
};

/**
 * 進捗線が通る位置（日の列を単位にした小数。0〜n）。
 * - 予定（着手と期限）がない、または着手前で進捗 0 → 今日の列の中央（当日のライン）
 * - 予定がある → 帯（着手日の左端〜期限の右端）の ratio の位置。今日より左なら遅れ、右なら先行
 */
export function linePosition(i: LineInput): number {
	const today = i.todayIdx + 0.5;
	const clamp = (x: number) => Math.min(Math.max(x, 0), i.n);
	if (i.startIdx === null || i.dueIdx === null || i.dueIdx < i.startIdx) return clamp(today);
	if (i.ratio <= 0 && i.startIdx > i.todayIdx) return clamp(today);
	return clamp(i.startIdx + i.ratio * (i.dueIdx - i.startIdx + 1));
}

/** 今日の縦線より左（遅れ）・右（先行）・同じ位置。tol px までは同じ位置とみなす */
export type Side = "behind" | "ahead" | "";
export function sideOf(x: number, todayX: number, tol = 1): Side {
	return x < todayX - tol ? "behind" : x > todayX + tol ? "ahead" : "";
}

export type Pt = { x: number; y: number };

/**
 * 進捗線の SVG の中身。pts は「ヘッダー下端の今日 → 各行の目印（上から順）→ 下端の今日」。
 * 線分は中点で、頂点（両端を除く）は位置で色分けする。色を消すときは CSS（.mono）で黒一色にする
 */
export function lineSvg(pts: Pt[], todayX: number): string {
	const r = (v: number) => Math.round(v * 10) / 10;
	let out = "";
	for (let i = 0; i < pts.length - 1; i++) {
		const a = pts[i]!;
		const b = pts[i + 1]!;
		out += `<polyline class="seg ${sideOf((a.x + b.x) / 2, todayX)}" points="${r(a.x)},${r(a.y)} ${r(b.x)},${r(b.y)}"/>`;
	}
	for (const p of pts.slice(1, -1)) out += `<circle class="${sideOf(p.x, todayX)}" cx="${r(p.x)}" cy="${r(p.y)}" r="3.5"/>`;
	return out;
}

/** 表示の切り替え（localStorage の wbsProgressLine）。既定は線も色分けもオン。読めない・壊れていても既定で動く */
export type LineOpts = { line: boolean; color: boolean };
export function parseLineOpts(raw: string | null): LineOpts {
	const def: LineOpts = { line: true, color: true };
	if (!raw) return def;
	try {
		const v = JSON.parse(raw) as Partial<LineOpts> | null;
		if (!v || typeof v !== "object") return def;
		return { line: v.line !== false, color: v.color !== false };
	} catch {
		return def;
	}
}
