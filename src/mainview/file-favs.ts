// File タブのお気に入り（サイドバー）。~ 表記で保存し、表示のときに展開する。
// 初回だけ既定を種まきし、人が外したものは戻さない（保存済みの値があればそのまま使う）。壊れた値は既定に戻す。

export const FAV_KEY = "fileFavs";
export const DEFAULT_FAVS = ["~/Downloads", "~/Documents", "~/Desktop", "~/.claude", "~/Documents/work", "~/Documents/github"];

/** 保存値（JSON 文字列 or null）→ お気に入り。形が違う・壊れているときは既定 */
export function parseFavs(raw: string | null): string[] {
	if (raw == null) return [...DEFAULT_FAVS];
	try {
		const v = JSON.parse(raw) as { v?: unknown; paths?: unknown };
		if (v && v.v === 1 && Array.isArray(v.paths) && v.paths.every((p) => typeof p === "string")) {
			return [...new Set((v.paths as string[]).map((p) => p.trim()).filter(Boolean))];
		}
	} catch {
		/* 既定に戻す */
	}
	return [...DEFAULT_FAVS];
}

export const serializeFavs = (paths: string[]) => JSON.stringify({ v: 1, paths });

/** ~ / ~/x → 絶対（home が分からなければそのまま）。末尾の / は落とす */
export function expandTilde(p: string, home: string): string {
	const s = p === "~" || p.startsWith("~/") ? (home ? home + p.slice(1) : p) : p;
	return s.length > 1 ? s.replace(/\/+$/, "") : s;
}

/** 絶対 → ~ 表記（ホーム配下のとき） */
export function tildeForm(abs: string, home: string): string {
	if (home && abs === home) return "~";
	if (home && abs.startsWith(`${home}/`)) return `~${abs.slice(home.length)}`;
	return abs;
}

export function isFav(paths: string[], abs: string, home: string): boolean {
	return paths.some((p) => expandTilde(p, home) === abs);
}

/** 登録していれば外し、なければ末尾に足す（abs は絶対パス） */
export function toggleFav(paths: string[], abs: string, home: string): string[] {
	return isFav(paths, abs, home) ? paths.filter((p) => expandTilde(p, home) !== abs) : [...paths, tildeForm(abs, home)];
}
