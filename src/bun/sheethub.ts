// sheet-preview のハブ（http://127.0.0.1:8765）の自動起動。アプリ起動時に ping し、いなければ serve.ts を引数なしで起動する。
import { spawn } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const HUB_PING = "http://127.0.0.1:8765/api/ping";
export const HUB_TIMEOUT_MS = 1500;

/** hub: ハブが応答 / foreign: 別のものが 8765 で応答 / down: 応答なし */
export type PingResult = "hub" | "foreign" | "down";
/** 画面に返す状態。down = 未起動（スクリプトはある）、no-script = serve.ts が無い */
export type HubState = "running" | "started" | "foreign" | "down" | "no-script" | "failed";

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<{ json(): Promise<unknown> }>;

export function serveScriptPath(home = homedir()): string {
	return join(home, ".claude", "skills", "sheet-preview", "scripts", "serve.ts");
}

export async function pingHub(fetchFn: FetchLike = fetch as unknown as FetchLike, timeoutMs = HUB_TIMEOUT_MS): Promise<PingResult> {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		const res = await fetchFn(HUB_PING, { signal: ctl.signal });
		try {
			const body = await res.json();
			return typeof body === "object" && body !== null && (body as { app?: unknown }).app === "sheet-preview" ? "hub" : "foreign";
		} catch {
			return "foreign"; // 応答はあるが JSON ではない = 別プロセス
		}
	} catch {
		return "down";
	} finally {
		clearTimeout(timer);
	}
}

export type HubDeps = {
	ping: () => Promise<PingResult>;
	scriptExists: (path: string) => boolean;
	/** detached・stdio ignore・unref で起動する */
	spawn: (script: string) => void;
	script: string;
	log?: (msg: string) => void;
};

/** 画面用: 今の状態（起動はしない） */
export async function hubState(deps: Pick<HubDeps, "ping" | "scriptExists" | "script">): Promise<HubState> {
	const r = await deps.ping();
	if (r === "hub") return "running";
	if (r === "foreign") return "foreign";
	return deps.scriptExists(deps.script) ? "down" : "no-script";
}

/** アプリ起動時: 生きていなければ起動する。失敗してもアプリは落とさない */
export async function ensureHub(deps: HubDeps): Promise<HubState> {
	const log = deps.log ?? (() => {});
	try {
		const r = await deps.ping();
		if (r === "hub") return "running";
		if (r === "foreign") {
			log("sheet-preview: 8765 が別プロセスで使用中のため起動しない");
			return "foreign";
		}
		if (!deps.scriptExists(deps.script)) {
			log(`sheet-preview: ${deps.script} が無いので起動しない`);
			return "no-script";
		}
		deps.spawn(deps.script);
		log("sheet-preview: ハブを起動した");
		return "started";
	} catch (e) {
		log(`sheet-preview: 起動に失敗 ${String(e)}`);
		return "failed";
	}
}

export function defaultHubDeps(log: (msg: string) => void): HubDeps {
	return {
		ping: () => pingHub(),
		scriptExists: existsSync,
		script: serveScriptPath(),
		spawn: (script) => {
			const child = spawn("node", [script], { detached: true, stdio: "ignore" });
			child.on("error", (e) => log(`sheet-preview: node を起動できない ${String(e)}`));
			child.unref();
		},
		log,
	};
}
