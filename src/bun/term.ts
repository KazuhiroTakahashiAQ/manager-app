// ターミナル 1 つ = claude の対話セッション 1 つ。PTY で普通の claude をそのまま動かす。
// スラッシュコマンド・skill・許可の確認など、CLI の機能はすべてそのまま使える。

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { TermKind, WaitKind } from "../shared/types";
import { clearWaitingFile, detectPtyWaiting, plainTail, ptyWaiting, readWaitingFile } from "./waiting";

export type TermRecord = {
	id: string;
	kind: TermKind;
	title: string;
	taskPath: string | null;
	/** claude のセッション ID。新規は --session-id で、2 回目以降は --resume で使う */
	sessionId: string;
	/** main を日替わりにするための日付 */
	day: string;
	lastActive: number;
};

type Env = {
	cwd: string;
	claudePath: string;
	systemPrompt: (rec: TermRecord) => string;
	/** 起動時に足す env（自動 compact の閾値など。起動のたびに設定を読み直す） */
	extraEnv?: () => Record<string, string>;
	data: (t: Term, chunk: string) => void;
	changed: (t: Term) => void;
};

const MAX_BUFFER = 512 * 1024;

/** 役職ごとのモデル（mgr / sub mgr は sonnet） */
export function modelOf(_kind: TermKind): string {
	return "sonnet";
}

export class Term {
	private proc: PtyProcess | null = null;
	private decoder = new TextDecoder();
	private pending = "";
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	/** claude を立ち上げた時刻（定期の compact の間隔の起点） */
	startedAt = 0;
	private generation = 0;
	/** アプリが最後に発言を送った時刻（声かけ・引き継ぎ・compact が続けて割り込まないように） */
	private appSentAt = 0;
	/** 画面を開き直したときに描き直すための出力の控え */
	buffer = "";
	cols = 100;
	rows = 30;
	lastOutput = 0;
	unread = false;
	/** 人が最後にキーを打った時刻と、入力欄に打ちかけの文字があるか（声かけが割り込まないように） */
	userInputAt = 0;
	private inputDirty = false;

	constructor(
		public rec: TermRecord,
		private env: Env,
	) {}

	get id() {
		return this.rec.id;
	}
	get running() {
		return this.proc !== null;
	}

	/** claude を立ち上げる。initialPrompt は最初の発言として渡す（引き継ぎ用）。 */
	start(initialPrompt?: string) {
		if (this.proc) return;
		const gen = ++this.generation;
		const resume = sessionExists(this.env.cwd, this.rec.sessionId);
		const args = [
			this.env.claudePath,
			"--model",
			modelOf(this.rec.kind),
			"--append-system-prompt",
			this.env.systemPrompt(this.rec),
			...(resume ? ["--resume", this.rec.sessionId] : ["--session-id", this.rec.sessionId]),
		];
		if (initialPrompt) args.push(initialPrompt);

		clearWaitingFile(this.env.cwd, this.id);
		this.startedAt = Date.now();
		if (initialPrompt) this.appSentAt = this.startedAt;
		let extra: Record<string, string> = {};
		try {
			extra = this.env.extraEnv?.() ?? {};
		} catch (e) {
			console.error("起動時の env を作れなかった", e);
		}
		// Bun.spawn の terminal（PTY）は devkit の型定義にまだないので、ここだけ型を当てる
		this.proc = (Bun.spawn as unknown as SpawnPty)(args, {
			cwd: this.env.cwd,
			env: {
				...cleanEnv(),
				...extra,
				TERM: "xterm-256color",
				COLORTERM: "truecolor",
				LANG: process.env["LANG"] || "ja_JP.UTF-8",
				MANAGER_UI: "1",
				MANAGER_THREAD: this.rec.id,
			},
			terminal: {
				cols: this.cols,
				rows: this.rows,
				data: (_t: unknown, bytes: Uint8Array) => gen === this.generation && this.onBytes(bytes),
			},
		});
		this.rec.lastActive = Date.now();
		this.env.changed(this);

		this.proc.exited.then((code) => {
			if (gen !== this.generation) return;
			this.proc = null;
			clearWaitingFile(this.env.cwd, this.id);
			// 再開できなかった（セッションが消えた等）→ 新しいセッションで立ち上げ直す
			if (resume && code !== 0 && Date.now() - this.startedAt < 8000) {
				this.say("前の会話を再開できなかったので、新しい会話で始める");
				this.rec.sessionId = crypto.randomUUID();
				this.start(initialPrompt);
				return;
			}
			this.say("claude が終了した。Enter で再開する");
			this.env.changed(this);
		});
	}

	write(data: string, fromUser = false) {
		if (fromUser) {
			this.userInputAt = Date.now();
			if (/[\r\x03]/.test(data)) this.inputDirty = false;
			else if (!data.startsWith("\x1b") || data.startsWith("\x1b[200~")) this.inputDirty = true;
		}
		if (!this.proc) {
			if (data.includes("\r")) this.start();
			return;
		}
		this.proc.terminal?.write(data);
		this.rec.lastActive = Date.now();
	}

	/** アプリからの発言を入力欄に貼り付ける（submit で送信も）。claude は bracketed paste を有効にしている */
	paste(text: string, submit = false) {
		this.appSentAt = Date.now();
		this.write(`\x1b[200~${text}\x1b[201~`);
		if (submit) setTimeout(() => this.write("\r"), 80);
	}

	/**
	 * アプリから発言を送ってよいか（声かけ・セッション間メッセージ・定期の compact で共通）。
	 * claude が止まっていて（出力が 15 秒ない）、人が打ちかけでなく（最後のキーから 30 秒）、
	 * アプリが直前（15 秒以内）に送っておらず、許可の確認や選択肢の画面が出ていないとき。
	 */
	readyForNudge(): boolean {
		if (!this.proc) return false;
		const now = Date.now();
		if (now - this.lastOutput < 15_000 || now - this.userInputAt < 30_000 || this.inputDirty) return false;
		if (now - this.appSentAt < 15_000) return false;
		// pty の目印は、人の入力の有無に関わらず見る（流し込みは誤入力になりうるので保守的に）
		return this.waiting() === null && detectPtyWaiting(plainTail(this.buffer)) === null;
	}

	/**
	 * 人の判断待ち（許可確認・質問・plan の承認）か。hook の印（state/ui/waiting-<id>.json）を主に、pty の画面の末尾を補助に見る。
	 * 待っている間は声かけ・引き継ぎ・compact を流し込まない（人の入力を奪う・誤入力になる）。
	 */
	waiting(): WaitKind | null {
		if (!this.proc) return null;
		const fromHook = readWaitingFile(this.env.cwd, this.id, this.rec.sessionId);
		if (fromHook) return fromHook;
		return ptyWaiting(plainTail(this.buffer), this.lastOutput, this.userInputAt, Date.now());
	}

	resize(cols: number, rows: number) {
		if (cols < 20 || rows < 5) return;
		this.cols = cols;
		this.rows = rows;
		this.proc?.terminal?.resize(cols, rows);
	}

	kill() {
		if (!this.proc) return;
		this.generation++;
		this.proc.kill();
		this.proc = null;
		clearWaitingFile(this.env.cwd, this.id);
		this.env.changed(this);
	}

	private onBytes(bytes: Uint8Array) {
		this.pending += this.decoder.decode(bytes, { stream: true });
		this.lastOutput = Date.now();
		// 細かい出力をまとめて送る（RPC の往復を減らす）
		if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 16);
	}

	private flush() {
		this.flushTimer = null;
		const chunk = this.pending;
		this.pending = "";
		if (!chunk) return;
		this.buffer += chunk;
		if (this.buffer.length > MAX_BUFFER) this.buffer = this.buffer.slice(-MAX_BUFFER);
		this.env.data(this, chunk);
	}

	/** アプリからの一言（薄い色で出す） */
	private say(text: string) {
		const line = `\r\n\x1b[2m[manager-app] ${text}\x1b[0m\r\n`;
		this.buffer += line;
		this.env.data(this, line);
	}
}

type PtyProcess = {
	terminal?: { write(data: string): number; resize(cols: number, rows: number): void };
	exited: Promise<number>;
	kill(): void;
};
type SpawnPty = (
	args: string[],
	opts: {
		cwd: string;
		env: Record<string, string | undefined>;
		terminal: { cols: number; rows: number; data: (t: unknown, bytes: Uint8Array) => void };
	},
) => PtyProcess;

/**
 * 親の Claude Code セッションから受け継いだ印を外す。残っていると子セッション扱いになり、
 * 会話が保存されず --resume できない（Claude Code の中からアプリを起動したとき）。
 */
const INHERITED = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|AI_AGENT|CLAUDE_CODE_(ENTRYPOINT|EXECPATH|SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|VERSION|MESSAGING_SOCKET|MESSAGING_TOKEN|SSE_PORT))$/;
export function cleanEnv(): Record<string, string | undefined> {
	return Object.fromEntries(Object.entries(process.env).filter(([k]) => !INHERITED.test(k)));
}

/** ~/.claude/projects/<cwd を英数字以外 - にしたもの>/<id>.jsonl があれば再開できる */
function sessionExists(cwd: string, id: string): boolean {
	const dir = cwd.replace(/[^A-Za-z0-9]/g, "-");
	return existsSync(join(homedir(), ".claude", "projects", dir, `${id}.jsonl`));
}
