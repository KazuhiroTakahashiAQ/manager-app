// 1 回きりの haiku 呼び出し（分類・要約）。vault 外の作業場で、CLAUDE.md・skill・hook・MCP・ツールなしで動かす。
// 会話は保存しない（--no-session-persistence）。入力は stdin で渡す（長い文字を引数に載せない）。

import { mkdirSync } from "fs";
import { cleanEnv } from "./term";

export async function runHaiku(o: { claudePath: string; cwd: string; system: string; prompt: string; timeoutMs?: number }): Promise<string | null> {
	mkdirSync(o.cwd, { recursive: true });
	try {
		const proc = Bun.spawn(
			[
				o.claudePath,
				"-p",
				"--model",
				"haiku",
				"--safe-mode",
				"--tools",
				"",
				"--strict-mcp-config",
				"--no-session-persistence",
				"--disable-slash-commands",
				"--system-prompt",
				o.system,
			],
			{ cwd: o.cwd, env: { ...cleanEnv(), LANG: process.env["LANG"] || "ja_JP.UTF-8" }, stdin: new Blob([o.prompt]), stdout: "pipe", stderr: "pipe" },
		);
		const timer = setTimeout(() => proc.kill(), o.timeoutMs ?? 120_000);
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		clearTimeout(timer);
		if (code !== 0) {
			console.error("haiku の呼び出しに失敗", code, (await new Response(proc.stderr).text()).slice(0, 300));
			return null;
		}
		return out;
	} catch (e) {
		console.error("haiku の呼び出しに失敗", e);
		return null;
	}
}
