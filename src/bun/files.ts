// File タブの bun 側。読み取りと「開く / Finder で表示 / Quick Look」だけ。削除・移動・書き込みはしない。
// 表示の起点は、そのタブの claude プロセスの cwd（lsof で動的に取る）。取れなければ MANAGER_DIR。

import { existsSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, normalize, resolve } from "path";
import type { FileEntry, FileListing, FileProbe, FileResolve } from "../shared/types";

/** `lsof -a -p <pid> -d cwd -Fn` の出力から cwd を取り出す（n で始まる行） */
export function parseLsofCwd(out: string): string | null {
	for (const line of out.split("\n")) if (line.startsWith("n/")) return line.slice(1);
	return null;
}

/** claude プロセスの cwd。pid が無い・取れない・消えているときは fallback */
export async function claudeCwd(
	pid: number | null,
	fallback: string,
	run: (pid: number) => Promise<string> = lsofCwd,
	exists: (p: string) => boolean = existsSync,
): Promise<{ cwd: string; live: boolean }> {
	if (pid != null) {
		try {
			const cwd = parseLsofCwd(await run(pid));
			if (cwd && exists(cwd)) return { cwd, live: true };
		} catch {
			/* フォールバック */
		}
	}
	return { cwd: fallback, live: false };
}

async function lsofCwd(pid: number): Promise<string> {
	const p = Bun.spawn(["/usr/sbin/lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], { stdout: "pipe", stderr: "ignore" });
	const out = await new Response(p.stdout).text();
	await p.exited;
	return out;
}

/** 入力（絶対 / ~ / cwd 起点の相対）を正規化した絶対パスにする */
export function resolveInput(input: string, base: string, home: string = homedir()): FileResolve {
	let s = input.trim().replace(/^file:\/\//, "");
	if (!s) return { ok: false, error: "パスが空" };
	if (s === "~" || s.startsWith("~/")) s = join(home, s.slice(1));
	const path = normalize(isAbsolute(s) ? s : resolve(base, s));
	let st;
	try {
		st = statSync(path);
	} catch {
		return { ok: false, error: "見つからない" };
	}
	return { ok: true, path, dir: st.isDirectory() };
}

/** ターミナルのパス候補を cwd 起点で解決。存在しないものは null（リンクにしない） */
export function probeTokens(tokens: string[], base: string, home: string = homedir()): (FileProbe | null)[] {
	return tokens.slice(0, 50).map((t) => {
		const r = resolveInput(t, base, home);
		return r.ok && r.path ? { path: r.path, dir: r.dir === true } : null;
	});
}

/** 1 階層のリスト。ディレクトリが先、名前順。隠しファイル（. 始まり）は hidden のときだけ */
export function listDir(dir: string, hidden: boolean): FileListing {
	const path = normalize(dir);
	let names: string[];
	try {
		names = readdirSync(path);
	} catch {
		return { ok: false, error: "開けない", path, parent: null, entries: [] };
	}
	const entries: FileEntry[] = [];
	for (const name of names) {
		if (!hidden && name.startsWith(".")) continue;
		const full = join(path, name);
		try {
			const st = statSync(full); // リンクは先を見る（壊れたリンクは落とす）
			entries.push({ name, path: full, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs });
		} catch {
			/* 読めないものは出さない */
		}
	}
	entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, "ja", { numeric: true }));
	const parent = dirname(path);
	return { ok: true, path, parent: parent === path ? null : parent, entries };
}

type Proc = { kill(): void; exited: Promise<number> };
type Run = (cmd: string[]) => Proc;
const defaultRun: Run = (cmd) => Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }) as unknown as Proc;

/** Finder で表示（open -R）。存在する絶対パスだけ */
export function reveal(path: string, run: Run = defaultRun): boolean {
	if (!isAbsolute(path) || !existsSync(path)) return false;
	run(["/usr/bin/open", "-R", path]);
	return true;
}

/** Quick Look（qlmanage -p）。1 つだけ。開いている間にもう一度呼ぶと閉じる */
export class QuickLook {
	private proc: Proc | null = null;
	constructor(private run: Run = defaultRun) {}

	get open() {
		return this.proc !== null;
	}

	/** 開いた/閉じた後の状態を返す */
	toggle(path: string): boolean {
		if (this.proc) {
			this.close();
			return false;
		}
		if (!isAbsolute(path) || !existsSync(path)) return false;
		const p = this.run(["/usr/bin/qlmanage", "-p", path]);
		this.proc = p;
		void p.exited.then(() => {
			if (this.proc === p) this.proc = null; // Esc などで自分で閉じられた
		});
		return true;
	}

	close() {
		const p = this.proc;
		this.proc = null;
		p?.kill();
	}
}
