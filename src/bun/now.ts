// 「今」タブ用: state/ui/now.json（mgr が書く。ここでは読むだけ）と messages/ の問い合わせを読み、
// 問い合わせへの返信を messages/ の reply に書く。返信の宛先への配送は handoff（state/ui/handoff-*.json）で行う。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import type { Inquiry, NowFocus, NowView } from "../shared/types";
import { isUnanswered } from "../shared/now";
import { parseDest, type Dest } from "./handoff";
import { parseNote } from "./vault";

// ───────── 純関数 ─────────

/** now.json の task（`tasks/<名>.md` か素の名前）を `tasks/<名>.md` にする。使えない値は null */
export function taskRefToPath(task: unknown): string | null {
	if (typeof task !== "string") return null;
	let s = task.trim().replace(/^tasks\//, "").replace(/\.md$/, "");
	if (!s || s.includes("/") || s.includes("\\") || s.includes("\0") || s === "." || s === "..") return null;
	return `tasks/${s}.md`;
}

/** now.json の中身。task と reason だけ使う。読めなければ null */
export function parseNowJson(text: string): { task: string; reason: string } | null {
	try {
		const v = JSON.parse(text) as Record<string, unknown>;
		const task = taskRefToPath(v?.["task"]);
		if (!task) return null;
		return { task, reason: typeof v["reason"] === "string" ? v["reason"] : "" };
	} catch {
		return null;
	}
}

/** status: doing のうち due が最も近いもの（due なしは最後、同じなら名前順） */
export function pickDoing<T extends { path: string; fm: Record<string, string> }>(tasks: readonly T[]): T | null {
	const doing = tasks.filter((t) => (t.fm["status"] ?? "").trim() === "doing");
	doing.sort((a, b) => {
		const da = (a.fm["due"] ?? "").trim() || "9999-99-99";
		const db = (b.fm["due"] ?? "").trim() || "9999-99-99";
		return da === db ? a.path.localeCompare(b.path) : da.localeCompare(db);
	});
	return doing[0] ?? null;
}

/** frontmatter の options を読む。`[a, "b"]`（1 行）と `- a` の列の両方 */
export function parseOptions(text: string): string[] {
	const src = text.startsWith("﻿") ? text.slice(1) : text;
	const lines = src.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return [];
	const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
	const fmLines = lines.slice(1, end < 0 ? lines.length : end);
	const i = fmLines.findIndex((l) => /^options\s*:/.test(l));
	if (i < 0) return [];
	const rest = fmLines[i].replace(/^options\s*:/, "").trim();
	const unq = (s: string) => {
		const t = s.trim();
		return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
	};
	if (rest.startsWith("[")) {
		const inner = rest.replace(/\s#.*$/, "").replace(/^\[/, "").replace(/\]\s*$/, "");
		return splitFlow(inner).map(unq).filter(Boolean);
	}
	const out: string[] = [];
	for (const l of fmLines.slice(i + 1)) {
		const m = /^\s*-\s+(.*)$/.exec(l);
		if (!m) break;
		const v = unq(m[1]);
		if (v) out.push(v);
	}
	return out;
}

function splitFlow(s: string): string[] {
	const out: string[] = [];
	let cur = "";
	let q = "";
	for (const ch of s) {
		if (q) {
			cur += ch;
			if (ch === q) q = "";
		} else if (ch === '"' || ch === "'") {
			q = ch;
			cur += ch;
		} else if (ch === ",") {
			out.push(cur);
			cur = "";
		} else cur += ch;
	}
	out.push(cur);
	return out.map((x) => x.trim()).filter((x) => x !== "");
}

/** 本文の「## <見出し>」から次の「## 」の手前まで（HTML コメントは除く。前後の空行は詰める） */
export function sectionMd(body: string, heading: string): string {
	const lines = body.split("\n");
	const start = lines.findIndex((l) => new RegExp(`^##\\s*${heading}\\s*$`).test(l.trim()));
	if (start < 0) return "";
	const out: string[] = [];
	for (const l of lines.slice(start + 1)) {
		if (/^##\s/.test(l)) break;
		out.push(l);
	}
	return out
		.join("\n")
		.replace(/<!--[\s\S]*?-->/g, "")
		.trim();
}

/** frontmatter の key を text に書く（なければ閉じの --- の前に足す）。frontmatter がなければ text をそのまま返す */
export function setFrontmatter(text: string, key: string, value: string): string {
	const bom = text.startsWith("﻿") ? "﻿" : "";
	const lines = (bom ? text.slice(1) : text).split("\n");
	if (lines[0]?.trim() !== "---") return text;
	const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
	if (end < 0) return text;
	const line = `${key}: ${value}`;
	const i = lines.findIndex((l, n) => n > 0 && n < end && new RegExp(`^${key}\\s*:`).test(l));
	if (i >= 0) lines[i] = line;
	else lines.splice(end, 0, line);
	return bom + lines.join("\n");
}

/** reply の値（1 行の YAML 文字列） */
export function replyValue(text: string): string {
	return JSON.stringify(text.replace(/\s*[\r\n]+\s*/g, " ").trim());
}

/** 返信を宛先に届けるときの本文 */
export function replyBrief(msgPath: string, title: string, text: string): string {
	return `[人から（今タブ）]\n問い合わせ「${title}」（${msgPath}）への返信: ${text.trim()}\n（messages ノートの reply にも書いてある。status は完了にした）`;
}

const MSG_RE = /^messages\/[^/\\]+\.md$/;
const titleOfMsg = (name: string) => name.replace(/\.md$/, "").replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, "");

// ───────── vault を読む ─────────

export function readNow(managerDir: string): NowView {
	return { focus: readFocus(managerDir), inquiries: readInquiries(managerDir) };
}

function readFocus(dir: string): NowFocus | null {
	let want: { task: string; reason: string } | null = null;
	let note = "";
	const nowPath = join(dir, "state", "ui", "now.json");
	if (existsSync(nowPath)) {
		try {
			want = parseNowJson(readFileSync(nowPath, "utf-8"));
		} catch {
			want = null;
		}
		if (!want) note = "state/ui/now.json を読めない（task がない・形が違う）";
	}
	if (want) {
		const f = loadTask(dir, want.task, want.reason, false, "");
		if (f) return f;
		note = `now.json のタスクが見つからない: ${want.task}`;
	}
	const tdir = join(dir, "tasks");
	if (!existsSync(tdir)) return null;
	const tasks = readdirSync(tdir)
		.filter((f) => f.endsWith(".md") && !f.startsWith("."))
		.map((f) => {
			try {
				return { path: `tasks/${f}`, fm: parseNote(readFileSync(join(tdir, f), "utf-8")).fm };
			} catch {
				return null;
			}
		})
		.filter((x): x is { path: string; fm: Record<string, string> } => x !== null);
	const pick = pickDoing(tasks);
	return pick ? loadTask(dir, pick.path, "", true, note) : null;
}

function loadTask(dir: string, path: string, reason: string, provisional: boolean, note: string): NowFocus | null {
	const abs = join(dir, path);
	if (!existsSync(abs)) return null;
	try {
		const { fm, body } = parseNote(readFileSync(abs, "utf-8"));
		const name = path.replace(/^tasks\//, "").replace(/\.md$/, "");
		const research = existsSync(join(dir, "research", `${name}.md`)) ? `research/${name}.md` : null;
		return {
			taskPath: path,
			title: fm["title"] || name,
			status: fm["status"] ?? "",
			nextAction: fm["next_action"] ?? "",
			due: fm["due"] ?? "",
			waitingFor: fm["waiting_for"] ?? "",
			goalMd: sectionMd(body, "完了条件"),
			stepsMd: sectionMd(body, "手順"),
			research,
			reason,
			provisional,
			note,
		};
	} catch {
		return null;
	}
}

function readInquiries(dir: string): Inquiry[] {
	const mdir = join(dir, "messages");
	if (!existsSync(mdir)) return [];
	const out: Inquiry[] = [];
	for (const f of readdirSync(mdir).filter((x) => x.endsWith(".md") && !x.startsWith("."))) {
		try {
			const text = readFileSync(join(mdir, f), "utf-8");
			const { fm, body } = parseNote(text);
			if (!isUnanswered(fm)) continue;
			let reply = fm["reply"] ?? "";
			try {
				if (reply.startsWith('"')) reply = JSON.parse(reply) as string;
			} catch {
				// そのまま見せる
			}
			out.push({
				path: `messages/${f}`,
				title: titleOfMsg(f),
				from: fm["from"] ?? "",
				status: fm["status"] ?? "",
				priority: fm["priority"] ?? "",
				options: parseOptions(text),
				bodyMd: body.trim(),
				reply,
				created: fm["created"] ?? "",
			});
		} catch {
			// 読めないノートは飛ばす
		}
	}
	return out.sort((a, b) => b.path.localeCompare(a.path));
}

// ───────── 返信 ─────────

type ReplyResult = { ok: boolean; delivered: boolean; error?: string };

const stamp = (d: Date) => {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/**
 * 問い合わせの返信を reply に書く。from のセッションが開いている（isOpen）なら handoff を置いて status: 完了、
 * 閉じている・worker など宛先にできない from なら status: 対応中のまま reply に残す。
 */
export function replyInquiry(
	managerDir: string,
	msgPath: string,
	text: string,
	isOpen: (d: Dest) => boolean,
	now: Date = new Date(),
): ReplyResult {
	const body = text.trim();
	if (!MSG_RE.test(msgPath)) return { ok: false, delivered: false, error: "messages/ のノートではない" };
	if (!body) return { ok: false, delivered: false, error: "返信が空" };
	const abs = join(managerDir, msgPath);
	if (!existsSync(abs) || !statSync(abs).isFile()) return { ok: false, delivered: false, error: "ノートがない" };
	const src = readFileSync(abs, "utf-8");
	const { fm } = parseNote(src);
	if (!isUnanswered(fm)) return { ok: false, delivered: false, error: "すでに片付いている問い合わせ" };

	const dest = parseDest(fm["from"]);
	const delivered = dest !== null && isOpen(dest);
	let next = setFrontmatter(src, "reply", replyValue(body));
	next = setFrontmatter(next, "status", delivered ? "完了" : "対応中");
	const tmp = `${abs}.tmp`;
	writeFileSync(tmp, next);
	renameSync(tmp, abs);

	if (delivered) {
		const dir = join(managerDir, "state", "ui");
		mkdirSync(dir, { recursive: true });
		const title = titleOfMsg(msgPath.split("/").pop()!);
		const file = join(dir, `handoff-${stamp(now)}-reply.json`);
		writeFileSync(
			`${file}.tmp`,
			JSON.stringify({ to: fm["from"].trim(), from: "人（今タブ）", brief: replyBrief(msgPath, title, body) }, null, 1),
		);
		renameSync(`${file}.tmp`, file);
	}
	return { ok: true, delivered };
}
