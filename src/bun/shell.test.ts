import { describe, expect, test } from "bun:test";
import { pickCwd, pickShell, Shells, type ShellProc, type ShellSpawnOpts } from "./shell";

function fake() {
	const spawns: ShellSpawnOpts[] = [];
	const procs: { written: string[]; sizes: [number, number][]; killed: boolean; exit: (c: number) => void }[] = [];
	const spawn = (o: ShellSpawnOpts): ShellProc => {
		spawns.push(o);
		let exit!: (c: number) => void;
		const exited = new Promise<number>((r) => (exit = r));
		const p = { written: [] as string[], sizes: [] as [number, number][], killed: false, exit };
		procs.push(p);
		return { write: (d) => void p.written.push(d), resize: (c, r) => void p.sizes.push([c, r]), kill: () => (p.killed = true), exited };
	};
	const out: [string, string][] = [];
	const shells = new Shells({ cwd: () => "/vault", data: (id, c) => out.push([id, c]), spawn, shell: () => "/bin/zsh", exists: () => true, flushMs: 0 });
	return { shells, spawns, procs, out };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const enc = (s: string) => new TextEncoder().encode(s);

describe("pickShell / pickCwd", () => {
	test("SHELL が実在すれば使い、なければ /bin/zsh", () => {
		expect(pickShell("/opt/homebrew/bin/fish", () => true)).toBe("/opt/homebrew/bin/fish");
		expect(pickShell("/opt/homebrew/bin/fish", () => false)).toBe("/bin/zsh");
		expect(pickShell(undefined)).toBe("/bin/zsh");
		expect(pickShell("fish", () => true)).toBe("/bin/zsh");
	});
	test("cwd が消えていたらホーム", () => {
		expect(pickCwd("/vault", () => true, "/h")).toBe("/vault");
		expect(pickCwd("/vault", () => false, "/h")).toBe("/h");
	});
});

describe("Shells", () => {
	test("開くまで起動しない。開くと cwd・ログインシェルで 1 回だけ起動する", () => {
		const { shells, spawns } = fake();
		expect(spawns.length).toBe(0);
		shells.open("main", 120, 40);
		shells.open("main", 120, 40);
		expect(spawns.length).toBe(1);
		expect(spawns[0]!.cwd).toBe("/vault");
		expect(spawns[0]!.cmd).toEqual(["/bin/zsh", "-l"]);
		expect([spawns[0]!.cols, spawns[0]!.rows]).toEqual([120, 40]);
		expect(spawns[0]!.env["MANAGER_SHELL"]).toBe("1");
		expect(spawns[0]!.env["CLAUDECODE"]).toBeUndefined();
	});

	test("タブごとに別のシェル。出力は id つきで届き、控えは再 open で返る", () => {
		const { shells, spawns, out } = fake();
		shells.open("main", 100, 30);
		shells.open("system", 100, 30);
		expect(spawns.length).toBe(2);
		spawns[0]!.onData(enc("hello"));
		expect(out).toEqual([["main", "hello"]]);
		expect(shells.open("main", 100, 30).buffer).toBe("hello");
		expect(shells.open("system", 100, 30).buffer).toBe("");
	});

	test("入力と大きさの変更は起動済みのシェルへ。小さすぎる大きさは無視", () => {
		const { shells, procs } = fake();
		shells.open("main", 100, 30);
		shells.write("main", "ls\r");
		shells.resize("main", 90, 20);
		shells.resize("main", 5, 2);
		expect(procs[0]!.written).toEqual(["ls\r"]);
		expect(procs[0]!.sizes).toEqual([[90, 20]]);
		shells.write("nobody", "x"); // 開いていない id は何もしない
	});

	test("終了したら一言出し、Enter で再起動する（Enter 以外では起動しない）", async () => {
		const { shells, procs, spawns, out } = fake();
		shells.open("main", 100, 30);
		procs[0]!.exit(0);
		await tick();
		expect(shells.running("main")).toBe(false);
		expect(out.at(-1)![1]).toContain("シェルが終了した");
		shells.write("main", "a");
		expect(spawns.length).toBe(1);
		shells.write("main", "\r");
		expect(spawns.length).toBe(2);
		expect(shells.running("main")).toBe(true);
	});

	test("古い世代の出力・終了は無視する（再起動後に前のシェルの終了が来ても影響しない）", async () => {
		const { shells, procs, spawns, out } = fake();
		shells.open("main", 100, 30);
		procs[0]!.exit(0);
		await tick();
		shells.write("main", "\r");
		const before = out.length;
		spawns[0]!.onData(enc("old"));
		expect(out.length).toBe(before);
		expect(shells.running("main")).toBe(true);
	});

	test("close でシェルを kill し、控えも捨てる。以降の終了通知は無視", async () => {
		const { shells, procs, out } = fake();
		shells.open("main", 100, 30);
		shells.close("main");
		expect(procs[0]!.killed).toBe(true);
		expect(shells.running("main")).toBe(false);
		procs[0]!.exit(0);
		await tick();
		expect(out.length).toBe(0);
		expect(shells.open("main", 100, 30).buffer).toBe("");
	});

	test("closeAll は全部 kill", () => {
		const { shells, procs } = fake();
		shells.open("a", 100, 30);
		shells.open("b", 100, 30);
		shells.closeAll();
		expect(procs.every((p) => p.killed)).toBe(true);
	});

	test("起動に失敗しても落ちず、一言出す", () => {
		const out: string[] = [];
		const shells = new Shells({
			cwd: () => "/v",
			data: (_i, c) => out.push(c),
			spawn: () => {
				throw new Error("boom");
			},
			exists: () => true,
			flushMs: 0,
		});
		shells.open("main", 100, 30);
		expect(out.join("")).toContain("boom");
		expect(shells.running("main")).toBe(false);
	});
});
