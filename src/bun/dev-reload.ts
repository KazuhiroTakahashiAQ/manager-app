// 開発時（channel = dev）だけ、画面側（src/mainview・src/shared）の変更で WebView だけ読み込み直す。
// 公式の `electrobun dev --watch` はアプリごと作り直して再起動するため、bun の子である
// claude のセッション（mgr / sub mgr）が全部終わる。ここでは bun プロセスを生かしたまま
// 画面のバンドルだけを作り直し、location.reload() する。ターミナルは画面の attach で描き直される。
// bun 側（src/bun）の変更は対象外（再起動が要る）。

import { copyFileSync, existsSync, watch, type FSWatcher } from "fs";
import { join, resolve, sep } from "path";

export type ChangeKind = "copy" | "bundle";

/**
 * リポジトリのルートを探す。dev のアプリは <root>/build/dev-macos-arm64/<名前>.app/Contents/MacOS で動くので、
 * cwd の /build/ より前を最初に見る。なければ起動元の INIT_CWD / PWD。
 */
export function projectRootFrom(
	cwd: string,
	env: Record<string, string | undefined>,
	isRoot: (dir: string) => boolean,
): string | null {
	const candidates: string[] = [];
	if (env["MANAGER_APP_ROOT"]) candidates.push(env["MANAGER_APP_ROOT"]);
	const i = cwd.lastIndexOf(`${sep}build${sep}`);
	if (i > 0) candidates.push(cwd.slice(0, i));
	for (const k of ["INIT_CWD", "PWD"]) if (env[k]) candidates.push(env[k]!);
	return candidates.find((d) => isRoot(d)) ?? null;
}

/**
 * 変更されたファイル（src からの相対パス）が画面にどう効くか。
 * index.html / index.css はそのまま写す（electrobun.config.ts の copy と同じ）。
 * ts は画面のバンドルを作り直す。テスト・その他は無視（null）。
 */
export function classifyChange(relFromSrc: string): ChangeKind | null {
	const p = relFromSrc.split(sep).join("/");
	if (/\.test\.tsx?$/.test(p) || /(^|\/)\./.test(p)) return null;
	if (p === "mainview/index.html" || p === "mainview/index.css") return "copy";
	if (/^(mainview|shared)\/.+\.(ts|tsx)$/.test(p)) return "bundle";
	return null;
}

/** 連続した変更をまとめる（保存時に複数のイベントが出るため） */
export function debounce(fn: () => void, ms: number): () => void {
	let t: ReturnType<typeof setTimeout> | null = null;
	return () => {
		if (t) clearTimeout(t);
		t = setTimeout(() => {
			t = null;
			fn();
		}, ms);
	};
}

type Options = {
	/** WebView を読み込み直す */
	reload: () => void;
	/** 失敗を画面に知らせる */
	notify: (text: string) => void;
	cwd?: string;
	env?: Record<string, string | undefined>;
};

/** 監視を始める。始められなければ null（理由はログに出す） */
export function startDevReload(opts: Options): { dispose(): void } | null {
	const cwd = opts.cwd ?? process.cwd();
	const env = opts.env ?? process.env;
	const root = projectRootFrom(cwd, env, (d) => existsSync(join(d, "electrobun.config.ts")) && existsSync(join(d, "src", "mainview")));
	// 実行中の画面は <app>/Contents/Resources/app/views/mainview（bun は Contents/MacOS で動く）
	const viewsDir = resolve(cwd, "..", "Resources", "app", "views", "mainview");
	if (!root || !existsSync(join(viewsDir, "index.html"))) {
		console.warn(`[dev-reload] 監視しない（root: ${root}, views: ${viewsDir}）`);
		return null;
	}
	const src = join(root, "src");
	let pending = new Set<ChangeKind>();
	let running = false;
	let again = false;

	const apply = async () => {
		if (running) {
			again = true;
			return;
		}
		running = true;
		const kinds = pending;
		pending = new Set();
		try {
			if (kinds.has("copy")) {
				for (const f of ["index.html", "index.css"]) copyFileSync(join(src, "mainview", f), join(viewsDir, f));
			}
			if (kinds.has("bundle")) {
				const result = await Bun.build({
					entrypoints: [join(src, "mainview", "index.ts")],
					target: "browser",
					outdir: viewsDir,
					throw: false,
				});
				if (!result.success) {
					const msg = result.logs.map((l) => String(l.message ?? l)).join("\n");
					console.error("[dev-reload] 画面のビルドに失敗\n" + msg);
					opts.notify(`画面のビルドに失敗（読み込み直さない）: ${msg.split("\n")[0]?.slice(0, 160) ?? ""}`);
					return;
				}
			}
			console.log(`[dev-reload] ${[...kinds].join("+")} → WebView を読み込み直す`);
			opts.reload();
		} catch (e) {
			console.error("[dev-reload] 失敗", e);
			opts.notify(`画面の作り直しに失敗: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			running = false;
			if (again) {
				again = false;
				if (pending.size) void apply();
			}
		}
	};
	const schedule = debounce(() => void apply(), 250);

	const watchers: FSWatcher[] = [];
	for (const dir of ["mainview", "shared"]) {
		const abs = join(src, dir);
		if (!existsSync(abs)) continue;
		watchers.push(
			watch(abs, { recursive: true }, (_ev, name) => {
				if (!name) return;
				const kind = classifyChange(join(dir, String(name)));
				if (!kind) return;
				pending.add(kind);
				schedule();
			}),
		);
	}
	console.log(`[dev-reload] ${src}/{mainview,shared} を監視中`);
	return {
		dispose() {
			for (const w of watchers) w.close();
		},
	};
}
