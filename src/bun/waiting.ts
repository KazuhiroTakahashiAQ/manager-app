// 判断待ち（人が決める・承認する・答える必要がある状態）の検出。ただの待機（idle）は含めない。
// 1. hook（vault の scripts/hooks/waiting.ts）が state/ui/waiting-<id>.json に書く印を読む（主）。
// 2. pty の画面の末尾から許可確認・選択 UI を判定する（hook が効かない古いセッションの補助）。
// 純関数だけを置く（term.ts / hub.ts が使う）。パターンはここにまとめる。

import type { WaitKind } from "../shared/types";

/** hook の印ファイルの中身を読む。session が違う（前のセッションの残り）・形が違うなら null */
export function parseWaitingFile(text: string, sessionId: string): WaitKind | null {
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch {
		return null;
	}
	if (!v || typeof v !== "object") return null;
	const o = v as Record<string, unknown>;
	if (typeof o["session"] === "string" && o["session"] !== "" && o["session"] !== sessionId) return null;
	const k = o["kind"];
	return k === "permission" || k === "question" || k === "plan" ? k : null;
}

/** 端末の制御文字を落として、末尾 n 文字だけ残す */
export function plainTail(buffer: string, n = 1500): string {
	return buffer
		.slice(-8000)
		.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b./g, "")
		.slice(-n);
}

// 画面の末尾に出る選択 UI の目印。許可確認（Do you want to …?）、plan の承認、質問の選択（Enter to select）
const PLAN_RE = /Would you like to proceed|Ready to code\?/;
const QUESTION_RE = /Enter to (select|confirm)|↑\/↓ to navigate/;
const PERMISSION_RE = /Do you want to|Esc to cancel/i;

/** 画面の末尾から判断待ちの種類を判定する。目印がなければ null */
export function detectPtyWaiting(tail: string): WaitKind | null {
	if (PLAN_RE.test(tail)) return "plan";
	if (QUESTION_RE.test(tail)) return "question";
	if (PERMISSION_RE.test(tail)) return "permission";
	return null;
}

/**
 * pty からの判定。末尾に目印があり、かつ最後の出力のあとに人が入力していない（入力したら応答済み）ときだけ。
 * 出力の直後（描画の途中）は避けるため、出力が 300ms 止まってから。
 */
export function ptyWaiting(tail: string, lastOutput: number, userInputAt: number, now: number): WaitKind | null {
	if (userInputAt >= lastOutput || now - lastOutput < 300) return null;
	return detectPtyWaiting(tail);
}

// ───────── hook の印ファイル（state/ui/waiting-<id>.json）の読み書き ─────────

import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";

/** hook 側（scripts/hooks/waiting.ts の waitingFileName）と同じ規則 */
export function waitingPath(cwd: string, termId: string): string {
	return join(cwd, "state", "ui", `waiting-${termId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

export function readWaitingFile(cwd: string, termId: string, sessionId: string): WaitKind | null {
	const p = waitingPath(cwd, termId);
	if (!existsSync(p)) return null;
	try {
		return parseWaitingFile(readFileSync(p, "utf-8"), sessionId);
	} catch {
		return null;
	}
}

/** claude の起動・終了で前の印を消す（残ったままだと止まった claude に印が付く） */
export function clearWaitingFile(cwd: string, termId: string) {
	try {
		rmSync(waitingPath(cwd, termId), { force: true });
	} catch {
		// 消せなくてもよい（session が違えば無視される）
	}
}
