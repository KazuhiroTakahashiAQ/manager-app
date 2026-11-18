// 実行状況の各セッション（mgr / システム / sub mgr）を、会話が続いているかで自動で開く・畳む。
// DOM に触れない部分だけ（テストできるように）。見た目と保存の作りは wbs-fold.ts に揃える。

/** 最後の出力からこの時間内なら「会話が続いている」とみなす。閾値はここだけで決める */
export const RUN_ACTIVE_MS = 10 * 60_000;

/** 判定の材料。busy はいま出力中（hub の TermInfo.active、直近 1.5 秒の出力） */
type RunSignal = { running: boolean; busy: boolean; lastBusyAt: number; workerRunning: boolean };

/** 会話が続いているか: worker が作業中、または claude が動いていて出力中か最後の出力から RUN_ACTIVE_MS 以内 */
export function isRunActive(s: RunSignal, now: number, windowMs = RUN_ACTIVE_MS): boolean {
	if (s.workerRunning) return true;
	return s.running && (s.busy || (s.lastBusyAt > 0 && now - s.lastBusyAt < windowMs));
}

/**
 * 出力の記録を進める。出力中の間と、出力中から止まった瞬間（= 最後の出力の直後）に now を入れる。
 * hub は active が変わったときだけ知らせてくるので、立ち上がりだけでは長い出力の終わりを取りこぼす。
 */
export function noteBusy(
	lastBusyAt: ReadonlyMap<string, number>,
	prevBusy: ReadonlySet<string>,
	terms: readonly { id: string; active: boolean }[],
	now: number,
): { lastBusyAt: Map<string, number>; busy: Set<string> } {
	const last = new Map(lastBusyAt);
	for (const t of terms) if (t.active || prevBusy.has(t.id)) last.set(t.id, now);
	return { lastBusyAt: last, busy: new Set(terms.filter((t) => t.active).map((t) => t.id)) };
}

/** open は今の開閉、wasActive は最後に見たときの判定（自動はこれが変わった瞬間だけ効かせる） */
export type RunFold = { open: boolean; wasActive: boolean };

/**
 * 今の判定に合わせて開閉を決める。
 * - 初めて見る項目: 会話中なら開く、そうでなければ畳む。
 * - 判定が変わった瞬間（会話が始まった / 途切れた）: それに合わせて開く / 畳む。
 * - 判定が変わらない間: 前の開閉（人が手で変えたものを含む）をそのまま保つ。
 * いまの項目だけを返す（消えたセッションの分を溜めない）。
 */
export function reconcileRunFold(prev: ReadonlyMap<string, RunFold>, items: readonly { key: string; active: boolean }[]): Map<string, RunFold> {
	const out = new Map<string, RunFold>();
	for (const { key, active } of items) {
		const p = prev.get(key);
		out.set(key, !p || p.wasActive !== active ? { open: active, wasActive: active } : p);
	}
	return out;
}

/** 手で開閉する（判定は変えないので、次に判定が変わるまで自動では戻らない） */
export function setRunOpen(prev: ReadonlyMap<string, RunFold>, key: string, open: boolean): Map<string, RunFold> {
	const out = new Map(prev);
	const p = prev.get(key);
	if (p) out.set(key, { ...p, open });
	return out;
}

/** localStorage の値を読む。壊れていても空で始める */
export function parseRunFold(raw: string | null): Map<string, RunFold> {
	const out = new Map<string, RunFold>();
	try {
		const v: unknown = JSON.parse(raw ?? "{}");
		if (!v || typeof v !== "object" || Array.isArray(v)) return out;
		for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
			if (Array.isArray(x) && typeof x[0] === "boolean" && typeof x[1] === "boolean") out.set(k, { open: x[0], wasActive: x[1] });
		}
	} catch {
		// 壊れていれば空
	}
	return out;
}

export function serializeRunFold(m: ReadonlyMap<string, RunFold>): string {
	return JSON.stringify(Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b)).map(([k, f]) => [k, [f.open, f.wasActive]])));
}

/** 最後の出力の時刻（再読み込みしても会話中の判定を保つため）。壊れていても空で始める */
export function parseBusyAt(raw: string | null): Map<string, number> {
	const out = new Map<string, number>();
	try {
		const v: unknown = JSON.parse(raw ?? "{}");
		if (!v || typeof v !== "object" || Array.isArray(v)) return out;
		for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === "number" && Number.isFinite(x)) out.set(k, x);
	} catch {
		// 壊れていれば空
	}
	return out;
}

/** 保存する値。いまあるセッションだけ残す */
export function serializeBusyAt(m: ReadonlyMap<string, number>, keep: Iterable<string>): string {
	const ks = new Set(keep);
	return JSON.stringify(Object.fromEntries([...m].filter(([k]) => ks.has(k)).sort(([a], [b]) => a.localeCompare(b))));
}
