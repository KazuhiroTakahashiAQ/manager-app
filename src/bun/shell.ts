// ドッキング式のシェル。claude のタブ 1 つにつき対話シェルを 1 つ、ボタンを押したときに初めて PTY で起動する。
// claude の Term（term.ts）とは完全に別の部品にしてある。シェルの入出力は lastOutput / userInputAt / buffer に混ざらないので、
// handoff 配信の待ち・自動 compact の入力待ち判定・nudge には影響しない。

import { existsSync } from "fs";
import { homedir } from "os";
import { cleanEnv } from "./term";

/** 画面を開き直したときに描き直すための出力の控え（claude の 512KB より小さく） */
export const SHELL_MAX_BUFFER = 128 * 1024;

export type ShellProc = {
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
	exited: Promise<number>;
};

export type ShellSpawnOpts = {
	cmd: string[];
	cwd: string;
	env: Record<string, string | undefined>;
	cols: number;
	rows: number;
	onData: (bytes: Uint8Array) => void;
};
export type ShellSpawn = (o: ShellSpawnOpts) => ShellProc;

/** Bun.spawn の terminal（PTY）。devkit の型定義にまだないので、ここだけ型を当てる */
export const spawnPty: ShellSpawn = (o) => {
	type Raw = {
		terminal?: { write(data: string): number; resize(cols: number, rows: number): void };
		exited: Promise<number>;
		kill(): void;
	};
	const p = (Bun.spawn as unknown as (a: string[], opts: unknown) => Raw)(o.cmd, {
		cwd: o.cwd,
		env: o.env,
		terminal: { cols: o.cols, rows: o.rows, data: (_t: unknown, bytes: Uint8Array) => o.onData(bytes) },
	});
	return {
		write: (d) => void p.terminal?.write(d),
		resize: (c, r) => p.terminal?.resize(c, r),
		kill: () => p.kill(),
		exited: p.exited,
	};
};

/** $SHELL（実在すれば）、なければ /bin/zsh */
export function pickShell(envShell: string | undefined, exists: (p: string) => boolean = existsSync): string {
	return envShell && envShell.startsWith("/") && exists(envShell) ? envShell : "/bin/zsh";
}

/** 開く時点の cwd（claude タブの cwd）。消えていたらホーム */
export function pickCwd(cwd: string, exists: (p: string) => boolean = existsSync, home: string = homedir()): string {
	return exists(cwd) ? cwd : home;
}

type ShellsOpts = {
	/** claude タブの cwd（今は全タブ共通で Manager/） */
	cwd: (id: string) => string;
	data: (id: string, chunk: string) => void;
	spawn?: ShellSpawn;
	shell?: () => string;
	exists?: (p: string) => boolean;
	/** 出力をまとめて送る間隔（ms）。テストでは 0 */
	flushMs?: number;
};

class Shell {
	proc: ShellProc | null = null;
	buffer = "";
	cols = 100;
	rows = 30;
	generation = 0;
	pending = "";
	timer: ReturnType<typeof setTimeout> | null = null;
	decoder = new TextDecoder();
}

export class Shells {
	private shells = new Map<string, Shell>();
	private o: Required<Omit<ShellsOpts, "cwd" | "data">> & Pick<ShellsOpts, "cwd" | "data">;

	constructor(o: ShellsOpts) {
		this.o = {
			spawn: spawnPty,
			shell: () => pickShell(process.env["SHELL"]),
			exists: existsSync,
			flushMs: 16,
			...o,
		};
	}

	running(id: string): boolean {
		return this.shells.get(id)?.proc != null;
	}

	/** 開く（なければ起動。起動済みならそのまま）。これまでの出力を返す */
	open(id: string, cols: number, rows: number): { buffer: string } {
		let s = this.shells.get(id);
		if (!s) {
			s = new Shell();
			this.shells.set(id, s);
		}
		this.resize(id, cols, rows);
		if (!s.proc) this.start(id, s);
		return { buffer: s.buffer };
	}

	write(id: string, data: string) {
		const s = this.shells.get(id);
		if (!s) return;
		if (!s.proc) {
			if (data.includes("\r")) this.start(id, s); // 終了後に Enter で再開
			return;
		}
		s.proc.write(data);
	}

	resize(id: string, cols: number, rows: number) {
		const s = this.shells.get(id);
		if (!s || cols < 20 || rows < 5) return;
		s.cols = cols;
		s.rows = rows;
		s.proc?.resize(cols, rows);
	}

	/** claude タブを閉じたとき。シェルも終わらせて控えも捨てる */
	close(id: string) {
		const s = this.shells.get(id);
		if (!s) return;
		this.shells.delete(id);
		s.generation++;
		if (s.timer) clearTimeout(s.timer);
		s.proc?.kill();
		s.proc = null;
	}

	closeAll() {
		for (const id of [...this.shells.keys()]) this.close(id);
	}

	private start(id: string, s: Shell) {
		const gen = ++s.generation;
		const shell = this.o.shell();
		const cwd = pickCwd(this.o.cwd(id), this.o.exists);
		let proc: ShellProc;
		try {
			proc = this.o.spawn({
				cmd: [shell, "-l"],
				cwd,
				env: {
					...cleanEnv(),
					TERM: "xterm-256color",
					COLORTERM: "truecolor",
					LANG: process.env["LANG"] || "ja_JP.UTF-8",
					MANAGER_SHELL: "1",
				},
				cols: s.cols,
				rows: s.rows,
				onData: (bytes) => gen === s.generation && this.onBytes(id, s, bytes),
			});
		} catch (e) {
			this.say(id, s, `シェルを起動できなかった: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		s.proc = proc;
		proc.exited.then(() => {
			if (gen !== s.generation) return;
			s.proc = null;
			this.flush(id, s);
			this.say(id, s, "シェルが終了した。Enter で再開する");
		});
	}

	private onBytes(id: string, s: Shell, bytes: Uint8Array) {
		s.pending += s.decoder.decode(bytes, { stream: true });
		if (s.timer) return;
		if (this.o.flushMs <= 0) return this.flush(id, s);
		s.timer = setTimeout(() => this.flush(id, s), this.o.flushMs);
	}

	private flush(id: string, s: Shell) {
		s.timer = null;
		const chunk = s.pending;
		s.pending = "";
		if (!chunk) return;
		this.append(id, s, chunk);
	}

	private say(id: string, s: Shell, text: string) {
		this.append(id, s, `\r\n\x1b[2m[manager-app] ${text}\x1b[0m\r\n`);
	}

	private append(id: string, s: Shell, chunk: string) {
		s.buffer += chunk;
		if (s.buffer.length > SHELL_MAX_BUFFER) s.buffer = s.buffer.slice(-SHELL_MAX_BUFFER);
		this.o.data(id, chunk);
	}
}
