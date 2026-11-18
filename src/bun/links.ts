// claude のセッション記録（jsonl）から、出てきたファイルパスと URL を拾う。
// 画面の出力は制御文字で読みにくいので、記録のほうを読む。読むのは追記された分だけ。
//   - ツールの入力: Read / Write / Edit / NotebookEdit の file_path、WebFetch の url
//   - 返事の本文: パス（実在するものだけ）、URL、[タイトル](URL)、[[ウィキリンク]]

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import type { LinkInfo } from "../shared/types";

const MAX_LINKS = 12;
const MAX_READ = 2 * 1024 * 1024;

type Source = { id: string; file: string };
type State = { offset: number; rest: string; links: Map<string, LinkInfo> };

const VIA: Record<string, LinkInfo["via"]> = {
	Read: "読んだ",
	Write: "書いた",
	Edit: "直した",
	MultiEdit: "直した",
	NotebookEdit: "直した",
	WebFetch: "開いた",
};

export class LinkTracker {
	private states = new Map<string, State>();

	constructor(
		private cwd: string,
		private vaultRoot: string,
	) {}

	/** 各ソースの新しい行を読み、id ごとのリンク（新しい順）を返す */
	scan(sources: Source[]): Record<string, LinkInfo[]> {
		const out: Record<string, LinkInfo[]> = {};
		for (const src of sources) {
			const key = `${src.id}|${src.file}`;
			let st = this.states.get(key);
			if (!st) {
				st = { offset: 0, rest: "", links: new Map() };
				this.states.set(key, st);
			}
			this.read(src.file, st);
			out[src.id] = [...st.links.values()].sort((a, b) => b.at - a.at).slice(0, MAX_LINKS);
		}
		return out;
	}

	private read(file: string, st: State) {
		if (!existsSync(file)) return;
		const size = statSync(file).size;
		if (size < st.offset) {
			st.offset = 0; // 作り直された
			st.rest = "";
			st.links.clear();
		}
		if (size === st.offset) return;
		// 初回に大きな記録を全部読まないよう、末尾だけにする
		if (st.offset === 0 && size > MAX_READ) st.offset = size - MAX_READ;
		const len = size - st.offset;
		const buf = Buffer.alloc(len);
		const fd = openSync(file, "r");
		try {
			readSync(fd, buf, 0, len, st.offset);
		} finally {
			closeSync(fd);
		}
		st.offset = size;
		const text = st.rest + buf.toString("utf-8");
		const lines = text.split("\n");
		st.rest = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			let ev: any;
			try {
				ev = JSON.parse(line);
			} catch {
				continue;
			}
			if (ev.type !== "assistant") continue;
			const at = Date.parse(ev.timestamp ?? "") || Date.now();
			for (const block of ev.message?.content ?? []) {
				if (block.type === "tool_use") this.fromTool(block, at, st);
				else if (block.type === "text" && typeof block.text === "string") this.fromText(block.text, at, st);
			}
		}
	}

	private add(st: State, link: LinkInfo) {
		const prev = st.links.get(link.target);
		// 書いた・直した は 読んだ・言及 より強い
		const rank = (v: LinkInfo["via"]) => ["言及", "読んだ", "開いた", "直した", "書いた"].indexOf(v);
		if (prev && rank(prev.via) > rank(link.via)) link = { ...link, via: prev.via };
		if (prev && !link.title) link = { ...link, title: prev.title };
		st.links.set(link.target, link);
	}

	private fromTool(block: any, at: number, st: State) {
		const via = VIA[block.name];
		if (!via) return;
		const input = block.input ?? {};
		if (block.name === "WebFetch" && typeof input.url === "string") {
			if (isRealUrl(input.url)) this.add(st, { kind: "url", target: input.url, label: urlLabel(input.url), title: "", via, at });
			return;
		}
		const p = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : "";
		const abs = this.resolvePath(p, via !== "読んだ");
		if (abs) this.add(st, { kind: "file", target: abs, label: fileLabel(abs), title: mdTitle(abs), via, at });
	}

	private fromText(text: string, at: number, st: State) {
		// [タイトル](URL)
		const titled = new Map<string, string>();
		for (const m of text.matchAll(/\[([^\]\n]{1,120})\]\((https?:\/\/[^)\s]+)\)/g)) titled.set(m[2]!, m[1]!);
		for (const m of text.matchAll(/https?:\/\/[^\s)\]>"'`、。」）]+/g)) {
			const url = m[0].replace(/[.,;:]+$/, "");
			if (!isRealUrl(url)) continue;
			this.add(st, { kind: "url", target: url, label: urlLabel(url), title: titled.get(url) ?? "", via: "言及", at });
		}
		// [[ウィキリンク]]
		for (const m of text.matchAll(/\[\[([^\]|#\n]+)(?:[#|][^\]]*)?\]\]/g)) {
			const abs = this.resolvePath(m[1]!.endsWith(".md") ? m[1]! : `${m[1]}.md`, false);
			if (abs) this.add(st, { kind: "file", target: abs, label: fileLabel(abs), title: mdTitle(abs), via: "言及", at });
		}
		// パス（拡張子つき）。URL の中は除く
		const noUrl = text.replace(/https?:\/\/\S+/g, " ");
		for (const m of noUrl.matchAll(/(?:~\/|\/)?(?:[\w.\-ぁ-んァ-ヶー一-龠０-９]+\/)+[\w.\-ぁ-んァ-ヶー一-龠０-９]+\.[A-Za-z0-9]{1,8}/g)) {
			const abs = this.resolvePath(m[0], false);
			if (abs) this.add(st, { kind: "file", target: abs, label: fileLabel(abs), title: mdTitle(abs), via: "言及", at });
		}
	}

	/** Manager/ 相対・vault 相対・~/・絶対を解決する。mustExist=false でも、存在しないものは捨てる */
	private resolvePath(p: string, _written: boolean): string | null {
		if (!p) return null;
		const raw = p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
		const candidates = isAbsolute(raw) ? [raw] : [resolve(this.cwd, raw), resolve(this.vaultRoot, raw)];
		for (const c of candidates) {
			if (/\/\.claude\/projects\/|\/tool-results\/|\/node_modules\/|\/\.git\//.test(c)) continue;
			try {
				if (existsSync(c) && statSync(c).isFile()) return c;
			} catch {
				// 読めないパス
			}
		}
		return null;
	}
}

/** 同名が多いファイルは親フォルダを付ける */
function fileLabel(abs: string): string {
	const name = basename(abs);
	return /^(SKILL|README|CLAUDE|index|AGENTS)\.[a-z]+$/i.test(name) ? `${basename(dirname(abs))}/${name}` : name;
}

/** md の見出し（frontmatter の title / name、なければ最初の # 見出し） */
const titleCache = new Map<string, { mtime: number; title: string }>();
function mdTitle(abs: string): string {
	if (!/\.md$/i.test(abs)) return "";
	try {
		const mtime = statSync(abs).mtimeMs;
		const hit = titleCache.get(abs);
		if (hit && hit.mtime === mtime) return hit.title;
		const head = readFileSync(abs, "utf-8").slice(0, 4000);
		const fm = /^---\n([\s\S]*?)\n---/.exec(head)?.[1] ?? "";
		const t =
			/^title:\s*(.+)$/m.exec(fm)?.[1] ??
			/^name:\s*(.+)$/m.exec(fm)?.[1] ??
			/^#\s+(.+)$/m.exec(head.slice(fm ? fm.length + 8 : 0))?.[1] ??
			"";
		const title = t.replace(/^["']|["']$/g, "").trim().slice(0, 60);
		titleCache.set(abs, { mtime, title });
		return title;
	} catch {
		return "";
	}
}

function isRealUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return /^https?:$/.test(u.protocol) && /\.[a-z]{2,}$/i.test(u.hostname);
	} catch {
		return false;
	}
}

/** URL の見出し。よく使うサービスは名前で、ほかはホストと末尾 */
function urlLabel(url: string): string {
	try {
		const u = new URL(url);
		const h = u.hostname;
		if (h === "docs.google.com") return `Google ${/\/spreadsheets\//.test(u.pathname) ? "スプレッドシート" : /\/presentation\//.test(u.pathname) ? "スライド" : "ドキュメント"}`;
		if (h === "drive.google.com") return "Google ドライブ";
		if (h === "meet.google.com") return "Google Meet";
		if (h === "mail.google.com") return "Gmail";
		if (h.endsWith("slack.com")) return "Slack";
		if (h === "github.com") return `GitHub ${u.pathname.split("/").slice(1, 3).join("/")}`;
		const tail = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
		return tail ? `${h} › ${tail.slice(0, 40)}` : h;
	} catch {
		return url.slice(0, 60);
	}
}
