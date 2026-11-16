// 壁打ち相手「Clawd くん」の会話。~/work/buddy/（祖先に CLAUDE.md がない場所）で claude を 1 本持ち続け、
// stream-json で発言を送り、返事をストリームで受ける。アプリを開くたびに新しい会話にする（--resume しない）。
// - 書けるのは Manager/state/buddy/feedback-*.json と Manager/ideas/*.md だけ（buddy-files.ts の権限）。
// - 非対話なので許可の確認は出せない。dontAsk で、許可していないものはすべて断られる。
// - 10 日ごとに過去 30 日の会話を haiku で要約し、~/work/buddy/memory.md に書く（CLAUDE.md が @memory.md で読む）。

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { BuddyLine, BuddyState } from "../shared/types";
import { buddyRules, ensureBuddyFiles } from "./buddy-files";
import { runHaiku } from "./haiku";
import { cleanEnv } from "./term";
import { localDate } from "./vault";

type BuddyOptions = {
	managerDir: string;
	buddyDir: string;
	claudePath: string;
	/** 要約の作業場（vault 外） */
	dataDir: string;
	state: (s: BuddyState) => void;
	/** 返事の途中（ここまでの全文） */
	delta: (text: string) => void;
	reply: (text: string) => void;
};

type Proc = { stdin: { write(s: string): number; flush(): void; end(): void }; stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void };

const MAX_HISTORY = 20;

export class Buddy {
	state: BuddyState = "stopped";
	history: BuddyLine[] = [];
	private proc: Proc | null = null;
	private current = "";
	private disposed = false;
	private failures = 0;
	private queue: string[] = [];

	constructor(private o: BuddyOptions) {
		this.start();
		// 要約は起動の少しあとと、1 日 1 回
		setTimeout(() => void this.refreshMemory(), 90_000);
		setInterval(() => void this.refreshMemory(), 24 * 60 * 60 * 1000);
	}

	send(text: string) {
		const t = text.trim();
		if (!t) return;
		this.push({ role: "user", text: t });
		if (!this.proc) {
			this.queue.push(t);
			this.start();
			return;
		}
		this.write(t);
	}

	dispose() {
		this.disposed = true;
		this.proc?.kill();
		this.proc = null;
	}

	// ───────── 会話 ─────────

	private start() {
		if (this.proc || this.disposed) return;
		try {
			ensureBuddyFiles(this.o.managerDir, this.o.buddyDir);
		} catch (e) {
			console.error("~/work/buddy を用意できなかった", e);
		}
		const r = buddyRules(this.o.managerDir, this.o.buddyDir);
		const args = [
			this.o.claudePath,
			"-p",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--model",
			"haiku",
			"--session-id",
			crypto.randomUUID(),
			"--setting-sources",
			"project,local",
			"--tools",
			"Read,Write",
			"--permission-mode",
			"dontAsk",
			"--strict-mcp-config",
			"--disable-slash-commands",
			"--add-dir",
			...r.addDirs,
			"--allowedTools",
			...r.allow,
			"--disallowedTools",
			...r.deny,
		];
		this.setState("starting");
		this.current = "";
		const proc = Bun.spawn(args, {
			cwd: this.o.buddyDir,
			env: { ...cleanEnv(), LANG: process.env["LANG"] || "ja_JP.UTF-8", MANAGER_UI: "1" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
		}) as unknown as Proc;
		this.proc = proc;
		void this.read(proc);
		proc.exited.then((code) => {
			if (this.proc !== proc) return;
			this.proc = null;
			this.setState("stopped");
			if (this.disposed) return;
			// 落ちたら少し待って新しい会話で立ち上げ直す（続けて落ちるなら間をあける）
			this.failures++;
			console.error(`Clawd くんの claude が終了した（${code}）`);
			if (this.failures <= 5) setTimeout(() => this.start(), Math.min(60_000, 3_000 * this.failures));
		});
		this.setState("idle");
		for (const t of this.queue.splice(0)) this.write(t);
	}

	private write(text: string) {
		const now = new Date();
		const stamp = `${localDate(now)} ${now.toTimeString().slice(0, 5)}`;
		const line = JSON.stringify({ type: "user", message: { role: "user", content: `[いま ${stamp}]\n${text}` } });
		try {
			this.proc!.stdin.write(`${line}\n`);
			this.proc!.stdin.flush();
			this.current = "";
			this.setState("replying");
		} catch (e) {
			console.error("Clawd くんに送れなかった", e);
		}
	}

	private async read(proc: Proc) {
		const reader = proc.stdout.getReader();
		const dec = new TextDecoder();
		let buf = "";
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				let i: number;
				while ((i = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, i).trim();
					buf = buf.slice(i + 1);
					if (line) this.onEvent(line);
				}
			}
		} catch {
			// 終了
		}
	}

	private onEvent(line: string) {
		let v: StreamEvent;
		try {
			v = JSON.parse(line) as StreamEvent;
		} catch {
			return;
		}
		if (v.type === "stream_event") {
			const ev = v.event;
			if (ev?.type === "message_start" && this.current && !this.current.endsWith("\n")) this.current += "\n";
			if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
				this.current += ev.delta.text;
				this.o.delta(this.current);
			}
			return;
		}
		if (v.type === "result") {
			const text = (this.current || (typeof v.result === "string" ? v.result : "")).trim() || "……んむむ、うまく言えないなー";
			this.current = "";
			this.failures = 0;
			this.push({ role: "clawd", text });
			this.o.reply(text);
			this.setState("idle");
		}
	}

	private push(l: BuddyLine) {
		this.history.push(l);
		if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
	}

	private setState(s: BuddyState) {
		if (this.state === s) return;
		this.state = s;
		this.o.state(s);
	}

	// ───────── 10 日ごとの要約 ─────────

	private async refreshMemory() {
		try {
			const path = join(this.o.buddyDir, "memory.md");
			if (existsSync(path) && Date.now() - statSync(path).mtimeMs < 10 * 86_400_000) return;
			const talk = collectTalk(this.o.buddyDir, 30);
			if (!talk.text) return;
			const out = await runHaiku({
				claudePath: this.o.claudePath,
				cwd: join(this.o.dataDir, "summarize"),
				system: "会話の記録を要約する。指示された見出しの Markdown だけを返す。前置きを書かない。",
				prompt: [
					"人と壁打ち相手（Clawd くん）の過去の会話から、人の近況を要約する。Clawd くんが次に話すとき、友達として覚えておく材料にする。",
					"見出しは次の 4 つ。各 2〜5 行の箇条書き。具体的すぎる個人情報（人名・連絡先・健康の詳細・お金）は書かない。",
					"## 最近の気分の傾向",
					"## よく出る話題",
					"## 詰まりやすいこと",
					"## 覚えておくとよいこと",
					"",
					"会話の記録（古い順。人: が人、Clawd: が壁打ち相手）:",
					talk.text,
				].join("\n"),
			});
			if (!out?.trim()) return;
			const body = out.trim().replace(/^```(?:markdown)?\n?|```$/g, "").trim();
			writeFileSync(path, `---\nperiod: ${talk.from}〜${talk.to}\nupdated: ${localDate()}\n---\n# 人の近況（Clawd くんのメモ）\n\n${body}\n`);
		} catch (e) {
			console.error("Clawd くんの要約に失敗", e);
		}
	}
}

/** ~/.claude/projects/<作業場>/*.jsonl のうち days 日以内に更新されたものから、人の発言と返事の文だけを拾う（新しい順に上限まで） */
function collectTalk(buddyDir: string, days: number): { text: string; from: string; to: string } {
	const dir = join(homedir(), ".claude", "projects", buddyDir.replace(/[^A-Za-z0-9]/g, "-"));
	if (!existsSync(dir)) return { text: "", from: "", to: "" };
	const since = Date.now() - days * 86_400_000;
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => ({ f: join(dir, f), m: statSync(join(dir, f)).mtimeMs }))
		.filter((x) => x.m >= since)
		.sort((a, b) => a.m - b.m);
	const lines: { at: string; who: string; text: string }[] = [];
	for (const { f } of files) {
		let prev = "";
		for (const raw of readFileSync(f, "utf-8").split("\n")) {
			if (!raw.trim()) continue;
			let v: { type?: string; isMeta?: boolean; timestamp?: string; message?: { content?: unknown } };
			try {
				v = JSON.parse(raw);
			} catch {
				continue;
			}
			if ((v.type !== "user" && v.type !== "assistant") || v.isMeta) continue;
			const c = v.message?.content;
			let text = "";
			if (typeof c === "string") text = c;
			else if (Array.isArray(c)) text = c.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
			text = text.replace(/^\[いま [^\]]*\]\n?/, "").trim();
			if (!text || text === prev) continue;
			prev = text;
			lines.push({ at: (v.timestamp ?? "").slice(0, 10), who: v.type === "user" ? "人" : "Clawd", text: text.slice(0, 600) });
		}
	}
	// 新しい順に 30000 字まで
	const LIMIT = 30_000;
	const picked: typeof lines = [];
	let total = 0;
	for (let i = lines.length - 1; i >= 0 && total < LIMIT; i--) {
		picked.unshift(lines[i]!);
		total += lines[i]!.text.length + 8;
	}
	if (!picked.length) return { text: "", from: "", to: "" };
	let day = "";
	const out: string[] = [];
	for (const l of picked) {
		if (l.at && l.at !== day) {
			day = l.at;
			out.push(`\n[${day}]`);
		}
		out.push(`${l.who}: ${l.text}`);
	}
	return { text: out.join("\n").trim(), from: picked[0]!.at || localDate(new Date(since)), to: picked[picked.length - 1]!.at || localDate() };
}

type StreamEvent = {
	type: string;
	event?: { type?: string; delta?: { type?: string; text?: string } };
	result?: unknown;
};

/** 既定の作業場 */
export function defaultBuddyDir(): string {
	return process.env["BUDDY_DIR"] ?? join(homedir(), "work", "buddy");
}
