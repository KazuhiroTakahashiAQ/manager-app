// 各ターミナルのセッションが呼んだサブエージェント（ワーカー）の実行状況を読む。
// Claude Code は ~/.claude/projects/<cwd>/<session-id>/subagents/agent-<id>.jsonl と .meta.json に記録する。
//
// 状態の決め方（上から順に見る）:
// - 止めた / 失敗: 親セッションの <session-id>.jsonl に入る queue-operation の task-notification が
//   <status>killed</status> / <status>failed</status>（task-id = agentId）か、meta の stoppedByUser
// - 完了: meta の finished: true（SubagentHandback で終わる worker は最後が tool_use なので stop_reason では見ない）
// - 作業中: 上のどれでもなく、jsonl が 5 分以内に更新されている
// - 止まっている: 5 分以上更新がない
// 終わったあとに jsonl が進んでいれば（SendMessage で再開された）作業中に戻す。

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { WorkerInfo } from "../shared/types";

const STALL_MS = 5 * 60 * 1000;
const KEEP_MS = 12 * 60 * 60 * 1000;
/** 終わった印のあと、これより後に jsonl が書かれていたら再開とみなす */
const RESUME_MS = 10_000;
const CHUNK = 4 * 1024 * 1024;

export function projectDir(cwd: string): string {
	return join(homedir(), ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

/** 親セッションに届いた task-notification（task-id ごとに最新の 1 件） */
export type Notice = { status: string; at: number };

/** 判定に使う材料（テストしやすいようにファイルから切り離す） */
export type WorkerFacts = {
	now: number;
	/** jsonl の最終更新（jsonl がまだなければ meta の更新時刻） */
	updatedAt: number;
	/** meta.json の更新時刻（finished / stoppedByUser を書いた時刻とみなす） */
	metaAt: number;
	finished: boolean;
	stoppedByUser: boolean;
	notice?: Notice;
};

export function judgeState(f: WorkerFacts): { state: WorkerInfo["state"]; endedAt: number } {
	const after = (at: number) => f.updatedAt <= at + RESUME_MS;
	const n = f.notice;
	if (n && (n.status === "killed" || n.status === "failed") && after(n.at)) return { state: n.status, endedAt: n.at };
	if (f.stoppedByUser && after(f.metaAt)) return { state: "killed", endedAt: f.metaAt };
	if (f.finished && after(f.metaAt)) return { state: "done", endedAt: f.metaAt };
	if (n && n.status === "completed" && after(n.at)) return { state: "done", endedAt: n.at };
	if (f.now - f.updatedAt < STALL_MS) return { state: "running", endedAt: 0 };
	return { state: "stalled", endedAt: f.updatedAt };
}

/** 親 jsonl の行から task-notification を拾って notes に足す（同じ task-id は後のものが勝つ） */
export function parseNotifications(lines: string[], notes: Map<string, Notice>): void {
	for (const line of lines) {
		if (!line.includes('"queue-operation"') || !line.includes("<task-notification>")) continue;
		let ev: any;
		try {
			ev = JSON.parse(line);
		} catch {
			continue;
		}
		if (ev.type !== "queue-operation" || ev.operation !== "enqueue" || typeof ev.content !== "string") continue;
		const id = /<task-id>([^<]+)<\/task-id>/.exec(ev.content)?.[1];
		const status = /<status>([^<]+)<\/status>/.exec(ev.content)?.[1];
		if (!id || !status) continue;
		notes.set(id, { status, at: Date.parse(ev.timestamp) || 0 });
	}
}

/** 親 jsonl の読み位置。前回の続きだけ読む */
type ParentState = { offset: number; carry: Buffer; notes: Map<string, Notice> };
const parents = new Map<string, ParentState>();

export function readParentNotices(path: string, cache: Map<string, ParentState> = parents): Map<string, Notice> {
	let st = cache.get(path);
	if (!st) {
		st = { offset: 0, carry: Buffer.alloc(0), notes: new Map() };
		cache.set(path, st);
	}
	if (!existsSync(path)) return st.notes;
	const size = statSync(path).size;
	if (size < st.offset) {
		// 作り直された
		st.offset = 0;
		st.carry = Buffer.alloc(0);
		st.notes.clear();
	}
	if (size === st.offset) return st.notes;
	const fd = openSync(path, "r");
	try {
		while (st.offset < size) {
			const len = Math.min(CHUNK, size - st.offset);
			const buf = Buffer.alloc(len);
			const got = readSync(fd, buf, 0, len, st.offset);
			if (got <= 0) break;
			st.offset += got;
			const data = st.carry.length ? Buffer.concat([st.carry, buf.subarray(0, got)]) : buf.subarray(0, got);
			// 改行までを読み、途中の行（と途中のマルチバイト文字）は次に回す
			const cut = data.lastIndexOf(0x0a);
			if (cut < 0) {
				st.carry = Buffer.from(data);
				continue;
			}
			st.carry = Buffer.from(data.subarray(cut + 1));
			parseNotifications(data.subarray(0, cut).toString("utf-8").split("\n"), st.notes);
		}
	} finally {
		closeSync(fd);
	}
	return st.notes;
}

/** sessions: [terminal id, session id] */
export function readWorkers(cwd: string, sessions: [string, string][]): WorkerInfo[] {
	const now = Date.now();
	const out: WorkerInfo[] = [];
	for (const [termId, sessionId] of sessions) {
		const dir = join(projectDir(cwd), sessionId, "subagents");
		if (!existsSync(dir)) continue;
		// meta.json が出た時点で起動とみなす（jsonl はまだないことがある）
		const ids = new Set<string>();
		for (const f of readdirSync(dir)) {
			const m = /^agent-(.+?)(\.meta\.json|\.jsonl)$/.exec(f);
			if (m) ids.add(m[1]!);
		}
		if (!ids.size) continue;
		const notes = readParentNotices(join(projectDir(cwd), `${sessionId}.jsonl`));
		for (const id of ids) {
			const w = readOne(dir, id, termId, now, notes.get(id));
			if (w && now - w.updatedAt <= KEEP_MS) out.push(w);
		}
	}
	return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function readOne(dir: string, id: string, termId: string, now: number, notice: Notice | undefined): WorkerInfo | null {
	const logPath = join(dir, `agent-${id}.jsonl`);
	const metaPath = join(dir, `agent-${id}.meta.json`);
	const log = statOrNull(logPath);
	const metaSt = statOrNull(metaPath);
	if (!log && !metaSt) return null;
	let meta: { agentType?: string; description?: string; finished?: boolean; stoppedByUser?: boolean } = {};
	if (metaSt) {
		try {
			meta = JSON.parse(readFileSync(metaPath, "utf-8"));
		} catch {
			// 書き換えの途中
		}
	}
	const updatedAt = log?.mtimeMs ?? metaSt!.mtimeMs;
	const { state, endedAt } = judgeState({
		now,
		updatedAt,
		metaAt: metaSt?.mtimeMs ?? 0,
		finished: meta.finished === true,
		stoppedByUser: meta.stoppedByUser === true,
		notice,
	});
	return {
		id,
		termId,
		type: meta.agentType ?? "agent",
		description: meta.description ?? "",
		state,
		lastTool: log ? lastTool(logPath, log.size) : "",
		startedAt: log ? log.birthtimeMs || log.ctimeMs : metaSt!.birthtimeMs || metaSt!.ctimeMs,
		updatedAt,
		endedAt,
	};
}

function statOrNull(path: string) {
	try {
		return statSync(path);
	} catch {
		return null;
	}
}

/** 末尾の数 KB から、直近のツール名を拾う */
function lastTool(path: string, size: number): string {
	const len = Math.min(size, 32 * 1024);
	const buf = Buffer.alloc(len);
	const fd = openSync(path, "r");
	try {
		readSync(fd, buf, 0, len, size - len);
	} finally {
		closeSync(fd);
	}
	const lines = buf.toString("utf-8").split("\n").filter(Boolean).reverse();
	for (const l of lines) {
		let ev: any;
		try {
			ev = JSON.parse(l);
		} catch {
			continue; // 切れた先頭行
		}
		if (ev.type !== "assistant") continue;
		const tool = (ev.message?.content ?? []).filter((b: any) => b.type === "tool_use").pop()?.name;
		if (tool) return tool;
	}
	return "";
}
