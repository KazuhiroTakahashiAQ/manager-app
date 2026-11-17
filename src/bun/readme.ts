// アプリ自身の README.md を読む（画面の「README」タブ用。読み取り専用）。
// 場所は dev-reload と同じ解決（MANAGER_APP_ROOT → build の手前 → 起動元）。
// 見つからなければ既定の ~/Documents/work/manager-app。

import { existsSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { projectRootFrom } from "./dev-reload";
import type { Doc } from "../shared/types";

export function readmePath(
	cwd: string,
	env: Record<string, string | undefined>,
	exists: (p: string) => boolean = existsSync,
	home: string = homedir(),
): string | null {
	const root = projectRootFrom(cwd, env, (d) => exists(join(d, "README.md")) && exists(join(d, "electrobun.config.ts")));
	const p = root ? join(root, "README.md") : join(home, "Documents", "work", "manager-app", "README.md");
	return exists(p) ? p : null;
}

/** 呼ばれるたびに読み直す（キャッシュしない） */
export function readReadme(
	cwd: string = process.cwd(),
	env: Record<string, string | undefined> = process.env,
): Doc | null {
	const p = readmePath(cwd, env);
	if (!p) return null;
	try {
		return { path: "app:readme", fm: {}, body: readFileSync(p, "utf-8"), mtime: statSync(p).mtimeMs };
	} catch {
		return null;
	}
}
