// Manager/ の md を読むだけのモジュール。書き込みは一切しない（書くのは manager = Claude Code）。
// state/ は機械用なので、読むのは先読み（state/plan/）と活動の記録（state/activity/）の最後の 1 行だけ。

import { readdirSync, readFileSync, statSync, watch, existsSync } from "fs";
import { join, relative, resolve, sep, dirname } from "path";
import type { ActivitySpan, Doc, Frontmatter, Item, Lookahead, OrgNote, PersonNote, PjNote, VaultState } from "../shared/types";
import { parseOrg, parsePerson, parsePj } from "./people";
import { readDayPlan } from "./calendar";

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/;

/** docs/schema.md のフラットな frontmatter を読む。リストやブロック値は読み飛ばす。 */
export function parseNote(text: string): { fm: Frontmatter; body: string } {
	const src = text.startsWith("﻿") ? text.slice(1) : text;
	const lines = src.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return { fm: {}, body: src };
	const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
	if (end < 0) return { fm: {}, body: src };
	const fm: Frontmatter = {};
	for (const line of lines.slice(1, end)) {
		const m = KEY_LINE.exec(line);
		if (!m) continue;
		fm[m[1]] = cleanValue(m[2]);
	}
	return { fm, body: lines.slice(end + 1).join("\n") };
}

function cleanValue(raw: string): string {
	let s = raw.trim();
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	const hash = s.search(/\s#/);
	if (hash >= 0) s = s.slice(0, hash).trim();
	return s;
}

/** 本文から一覧用の 1 行を取る。「## 要件」の直後を優先し、なければ最初の地の文。 */
function summarize(body: string): string {
	const lines = body.split("\n").map((l) => l.trim());
	const req = lines.findIndex((l) => /^##\s*要件/.test(l));
	const pool = req >= 0 ? lines.slice(req + 1) : lines;
	const line = pool.find((l) => l && !l.startsWith("#") && !l.startsWith("![[") && l !== "---");
	return (line ?? "").replace(/^[-*]\s+/, "").slice(0, 120);
}

/** 本文の「## <見出し>」から次の「## 」までの中身の行（空行・コメントを除く） */
function section(body: string, heading: string): string[] {
	const lines = body.split("\n");
	const start = lines.findIndex((l) => new RegExp(`^##\\s*${heading}\\s*$`).test(l.trim()));
	if (start < 0) return [];
	const out: string[] = [];
	for (const l of lines.slice(start + 1)) {
		if (/^##\s/.test(l)) break;
		const t = l.trim();
		if (t && !t.startsWith("<!--") && !/^[-*]\s*$/.test(t) && !/^[-*]\s+\[ \]\s*$/.test(t)) out.push(t);
	}
	return out;
}

/** タスクの準備状況（完了条件・手順が書かれているか、手順の進み具合） */
function taskPrep(body: string) {
	const goal = section(body, "完了条件");
	const steps = section(body, "手順");
	const checks = steps.filter((l) => /^[-*]\s+\[[ xX]\]/.test(l) || /^\d+[.)]\s/.test(l));
	return {
		goal: goal.length > 0,
		steps: steps.length > 0,
		stepsDone: steps.filter((l) => /^[-*]\s+\[[xX]\]/.test(l)).length,
		stepsTotal: checks.length,
	};
}

export class Vault {
	readonly root: string;
	readonly vaultRoot: string;
	/** 祝日の取り出し口（index.ts が Holidays につなぐ） */
	holidays: () => Record<string, string> = () => ({});

	constructor(managerDir: string) {
		this.root = resolve(managerDir);
		this.vaultRoot = dirname(this.root);
	}

	private item(abs: string): Item | null {
		try {
			const text = readFileSync(abs, "utf-8");
			const { fm, body } = parseNote(text);
			const rel = relative(this.root, abs);
			return {
				path: rel,
				name: rel.split(sep).pop()!.replace(/\.md$/, ""),
				fm,
				summary: summarize(body),
				mtime: statSync(abs).mtimeMs,
				prep: fm["type"] === "task" ? taskPrep(body) : undefined,
			};
		} catch {
			return null;
		}
	}

	private list(dir: string): Item[] {
		const abs = join(this.root, dir);
		if (!existsSync(abs)) return [];
		return readdirSync(abs)
			.filter((f) => f.endsWith(".md") && !f.startsWith("."))
			.map((f) => this.item(join(abs, f)))
			.filter((x): x is Item => x !== null);
	}

	/** memory/people/ の人物ノート（毎回ディスクから読む。起動時・監視イベント後の scan に含まれる） */
	people(): PersonNote[] {
		return this.listRaw("memory/people").map(({ rel, text, mtime }) => parsePerson(rel, text, mtime));
	}

	/** memory/org/ のうち type: org のノート */
	orgs(): OrgNote[] {
		return this.listRaw("memory/org")
			.map(({ rel, text, mtime }) => parseOrg(rel, text, mtime))
			.filter((x): x is OrgNote => x !== null);
	}

	/** memory/pj/ のうち type: pj のノート */
	projects(): PjNote[] {
		return this.listRaw("memory/pj")
			.map(({ rel, text, mtime }) => parsePj(rel, text, mtime))
			.filter((x): x is PjNote => x !== null);
	}

	private listRaw(dir: string): { rel: string; text: string; mtime: number }[] {
		const abs = join(this.root, dir);
		if (!existsSync(abs)) return [];
		const out: { rel: string; text: string; mtime: number }[] = [];
		for (const f of readdirSync(abs)) {
			if (!f.endsWith(".md") || f.startsWith(".")) continue;
			try {
				const p = join(abs, f);
				out.push({ rel: relative(this.root, p), text: readFileSync(p, "utf-8"), mtime: statSync(p).mtimeMs });
			} catch {}
		}
		return out;
	}

	scan(): VaultState {
		const today = localDate();
		const docs = ["inbox.md", "goals.md", "slack/index.md", "calendar/upcoming.md", "settings/manager-app.md"]
			.map((p) => join(this.root, p))
			.filter(existsSync)
			.map((p) => this.item(p))
			.filter((x): x is Item => x !== null);
		const inbox = docs.find((d) => d.path === "inbox.md");
		const inboxCount = inbox
			? readFileSync(join(this.root, "inbox.md"), "utf-8")
					.split("\n")
					.filter((l) => /^\s*-\s+\S/.test(l)).length
			: 0;
		return {
			managerDir: this.root,
			today,
			plan: readDayPlan(this.root, today),
			holidays: this.holidays(),
			tasks: this.list("tasks"),
			messages: this.list("messages").sort((a, b) => b.name.localeCompare(a.name)),
			briefs: this.list("memory/briefs").sort((a, b) => b.name.localeCompare(a.name)),
			jobs: this.list("jobs"),
			docs,
			ideas: this.list("ideas").sort((a, b) => b.name.localeCompare(a.name)),
			people: this.people(),
			orgs: this.orgs(),
			projects: this.projects(),
			agents: this.list(".claude/agents").sort((a, b) => a.name.localeCompare(b.name)),
			research: this.list("research"),
			lookahead: this.lookahead(),
			activity: this.lastActivity(today),
			inboxCount,
			retroPending: this.list("memory/retro").filter((r) => r.fm["status"] === "提案").length,
			scannedAt: Date.now(),
		};
	}

	/** state/plan/lookahead.json（夜のジョブが作り直す）。なければ・読めなければ null */
	lookahead(): Lookahead | null {
		try {
			const v = JSON.parse(readFileSync(join(this.root, "state", "plan", "lookahead.json"), "utf-8")) as Lookahead;
			return v && Array.isArray(v.tasks) ? v : null;
		} catch {
			return null;
		}
	}

	/** 今日の活動の記録の最後の 1 区間 */
	lastActivity(today: string): ActivitySpan | null {
		try {
			const lines = readFileSync(join(this.root, "state", "activity", `${today}.jsonl`), "utf-8").trim().split("\n");
			const last = lines[lines.length - 1];
			return last ? (JSON.parse(last) as ActivitySpan) : null;
		} catch {
			return null;
		}
	}

	/**
	 * パスかウィキリンクの対象を vault 内のファイルに解決する。
	 * Manager/ 相対 → vault ルート相対 → ファイル名一致（Manager/ 内）の順に探す。
	 */
	resolve(target: string): string | null {
		const clean = target.replace(/#.*$/, "").replace(/\|.*$/, "").trim();
		if (!clean) return null;
		const withExt = /\.[a-z0-9]+$/i.test(clean) ? clean : `${clean}.md`;
		const candidates = [
			join(this.root, withExt),
			join(this.vaultRoot, withExt),
			join(this.root, withExt.replace(/^Manager\//, "")),
		];
		for (const c of candidates) {
			const abs = resolve(c);
			if (this.inside(abs) && existsSync(abs) && statSync(abs).isFile()) return abs;
		}
		return null;
	}

	/** vault 外（シンボリックリンクの先を含む）は読まない。 */
	private inside(abs: string): boolean {
		const r = relative(this.vaultRoot, abs);
		return !r.startsWith("..") && !r.startsWith(sep);
	}

	read(target: string): Doc | null {
		const abs = this.resolve(target);
		if (!abs) return null;
		const text = readFileSync(abs, "utf-8");
		const { fm, body } = parseNote(text);
		return { path: relative(this.root, abs), fm, body, mtime: statSync(abs).mtimeMs };
	}

	/** Manager/ 配下の変更を間引いて通知する。logs/ と .git は無視。state/ は先読み（state/plan/*.json）だけ見る。 */
	watch(onChange: (paths: string[]) => void): () => void {
		let pending = new Set<string>();
		let timer: ReturnType<typeof setTimeout> | null = null;
		const w = watch(this.root, { recursive: true }, (_ev, file) => {
			if (!file) return;
			const f = String(file);
			if (/^state\/plan\/[^/]+\.json$/.test(f) || f === "state/ui/now.json") {
				// 先読みは機械用の JSON だが画面に出す
			} else if (/^(\.git|state|logs|\.obsidian|node_modules)(\/|$)/.test(f)) return;
			else if (!f.endsWith(".md") && !f.endsWith(".base")) return;
			pending.add(f);
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				const paths = [...pending];
				pending = new Set();
				onChange(paths);
			}, 250);
		});
		return () => w.close();
	}
}

export function localDate(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
