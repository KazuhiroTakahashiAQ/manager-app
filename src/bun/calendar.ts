// 日本の祝日（holidays-jp API）と、今日の予定（calendar/upcoming.md）を読む。

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { DayPlan } from "../shared/types";

const HOLIDAYS_URL = "https://holidays-jp.github.io/api/v1/date.json";

/** 祝日 { "2026-11-23": "勤労感謝の日", ... }。1 日 1 回取り直し、取れなければ前回の控えを使う */
export class Holidays {
	private map: Record<string, string> = {};
	private fetchedDay = "";

	constructor(private cachePath: string) {
		try {
			const v = JSON.parse(readFileSync(cachePath, "utf-8"));
			this.map = v.map ?? {};
			this.fetchedDay = v.day ?? "";
		} catch {
			// 初回
		}
	}

	get(): Record<string, string> {
		return this.map;
	}

	async refresh(today: string): Promise<boolean> {
		if (this.fetchedDay === today && Object.keys(this.map).length) return false;
		try {
			const res = await fetch(HOLIDAYS_URL, { signal: AbortSignal.timeout(8000) });
			if (!res.ok) return false;
			const v = (await res.json()) as Record<string, string>;
			if (!v || typeof v !== "object") return false;
			this.map = v;
			this.fetchedDay = today;
			writeFileSync(this.cachePath, JSON.stringify({ day: today, map: v }));
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * calendar/upcoming.md（ジョブ calendar が作る）から 1 日分の予定を読む。
 *   ## 11/10(火)
 *   - 終日 オフィス
 *   - 09:30-10:00 【社内】施工図自動作図Daily（未回答）
 */
export function readDayPlan(managerDir: string, date: string): DayPlan {
	const plan: DayPlan = { date, allDay: [], events: [], fetched: "" };
	const path = join(managerDir, "calendar", "upcoming.md");
	if (!existsSync(path)) return plan;
	const text = readFileSync(path, "utf-8");
	plan.fetched = /^fetched:\s*(\S+)/m.exec(text)?.[1] ?? "";
	const md = `${date.slice(5, 7)}/${date.slice(8, 10)}`;
	const lines = text.split("\n");
	const start = lines.findIndex((l) => l.startsWith(`## ${md}`));
	if (start < 0) return plan;
	let last: DayPlan["events"][number] | null = null;
	for (const l of lines.slice(start + 1)) {
		if (l.startsWith("## ")) break;
		// 予定の下の字下げ行: Meet / Teams / メモ / 録画 / 文字起こし / 添付 / 説明（Teams も会議のリンクとして meet に入れる）
		const sub = /^\s{2,}-\s+(Meet|Teams|メモ|録画|文字起こし|添付|説明):\s*(.+)$/.exec(l);
		if (sub && last) {
			const [, kind, rest] = sub as unknown as [string, string, string];
			if (kind === "Meet" || kind === "Teams") last.meet = rest.trim();
			else if (kind === "説明") last.note = rest.trim();
			else {
				const link = /^\[([^\]]*)\]\((\S+)\)$/.exec(rest.trim());
				if (link) last.links.push({ kind, title: link[1]!, url: link[2]! });
			}
			continue;
		}
		const m = /^-\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})\s+(.+)$/.exec(l.trim());
		if (m) {
			const title = m[3]!.trim();
			const status = /（(未回答|辞退|仮承諾|未定)）/.exec(title)?.[1] ?? "";
			last = {
				start: m[1]!.padStart(5, "0"),
				end: m[2]!.padStart(5, "0"),
				title: title.replace(/（(未回答|辞退|仮承諾|未定)）/, "").trim(),
				status,
				meet: "",
				links: [],
				note: "",
			};
			plan.events.push(last);
			continue;
		}
		last = null;
		const a = /^-\s+終日\s+(.+)$/.exec(l.trim());
		if (a) plan.allDay.push(a[1]!.trim());
	}
	return plan;
}
