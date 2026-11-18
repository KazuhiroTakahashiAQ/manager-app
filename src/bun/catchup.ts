// アプリが止まっていた間の取りこぼしを、再開時に拾うための純関数（pulse.ts が使う）。

/** "HH:MM"（file の日付の、その時刻）か ISO 日時 → ms。読めなければ null。
 *  HH:MM は書いた日（baseMs の日）の時刻とする。書いた時刻より前なら翌日の意味。baseMs がなければ now の日。 */
export function parseAt(at: string, now: Date, baseMs?: number): number | null {
	if (/^\d{1,2}:\d{2}$/.test(at)) {
		const base = baseMs !== undefined ? new Date(baseMs) : new Date(now);
		const d = new Date(base);
		const [h, m] = at.split(":").map(Number);
		d.setHours(h!, m!, 0, 0);
		if (baseMs !== undefined && d.getTime() < baseMs) d.setDate(d.getDate() + 1);
		return d.getTime();
	}
	const t = Date.parse(at);
	return Number.isNaN(t) ? null : t;
}

/** 予約の時刻から 10 分以上遅れて届くとき、本文に付ける注記（止まっていた間に過ぎた予約を、重複させず 1 回だけ届ける印）。遅れていなければ空 */
export function overdueNote(atMs: number, nowMs: number): string {
	const late = Math.floor((nowMs - atMs) / 60_000);
	if (late < 10) return "";
	const h = Math.floor(late / 60);
	return `（予約の時刻から ${h >= 1 ? `約 ${h} 時間` : `${late} 分`}遅れて届いた。アプリが止まっていた間に過ぎたもの。いま必要か確かめてから動く）`;
}

/** 起動時に「すでにある未読」として黙って済ませる（始業の声かけで扱う）か。止まっていた間に届いたものは拾うので false。
 *  lastAlive がない（初回）ときは従来どおり全部 seed する。 */
export function shouldSeedMessage(mtimeMs: number, lastAliveMs: number | null): boolean {
	return lastAliveMs === null || mtimeMs <= lastAliveMs;
}
