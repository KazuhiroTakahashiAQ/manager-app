// 開発時のリロード（WebView だけ読み込み直す）で、開いていた画面を戻すための控え。
// sessionStorage に置く: ページの再読み込みでは残り、アプリを起動し直すと消える。
// 折りたたみ・分割位置などは従来どおり localStorage 側で残っている。

export const RELOAD_KEY = "reloadState";
/** これより古い控えは使わない（リロードの直前に書いたものだけを使う） */
export const RELOAD_MAX_AGE_MS = 60_000;

export type SavedDocTab = { path: string; label: string; scroll: number };
export type ReloadState = {
	/** 前に出していたターミナル（mgr / sub mgr の id） */
	term: string;
	/** 開いていたノートのタブ */
	docs: SavedDocTab[];
	/** 前に出していたノート（null ならダッシュボード） */
	current: string | null;
	at: number;
};

export function encodeReloadState(s: ReloadState): string {
	return JSON.stringify(s);
}

/** 壊れている・古い・形が違う控えは null（起動時の既定の画面にする） */
export function decodeReloadState(raw: string | null, now: number, maxAgeMs = RELOAD_MAX_AGE_MS): ReloadState | null {
	if (!raw) return null;
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!v || typeof v !== "object") return null;
	const o = v as Record<string, unknown>;
	if (typeof o["at"] !== "number" || now - o["at"] > maxAgeMs || o["at"] - now > maxAgeMs) return null;
	if (typeof o["term"] !== "string" || !Array.isArray(o["docs"])) return null;
	const docs: SavedDocTab[] = [];
	for (const d of o["docs"]) {
		if (!d || typeof d !== "object") continue;
		const t = d as Record<string, unknown>;
		if (typeof t["path"] !== "string" || !t["path"] || typeof t["label"] !== "string") continue;
		if (docs.some((x) => x.path === t["path"])) continue;
		const scroll = typeof t["scroll"] === "number" && Number.isFinite(t["scroll"]) && t["scroll"] > 0 ? t["scroll"] : 0;
		docs.push({ path: t["path"], label: t["label"], scroll });
	}
	const cur = o["current"];
	const current = typeof cur === "string" && docs.some((d) => d.path === cur) ? cur : null;
	return { term: o["term"], docs, current, at: o["at"] };
}

/** 戻すターミナル。控えのターミナルが今もあればそれ、なければ fallback */
export function pickTerm(saved: string | null | undefined, ids: readonly string[], fallback = "main"): string {
	return saved && ids.includes(saved) ? saved : fallback;
}
