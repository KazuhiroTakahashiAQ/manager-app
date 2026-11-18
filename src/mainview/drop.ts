// ファイル・パス・テキストのドラッグ＆ドロップ（画面側）。
// - ターミナルのカード（.dock）: macOS の Terminal.app と同じく、シェル向けにエスケープした絶対パスを空白区切りで貼る（送信しない）。
//   パスでないテキストはそのまま貼る。
// - Clawd くん（本体・吹き出し）: ~/work/buddy/drops/ にコピーし、吹き出しを開いて入力欄に「ファイル: <パス>」を差し込む（送信しない）。
// - それ以外の場所に落としても、webview がファイルを開いて画面が変わらないよう、既定の動作を止める。
// パスの取り方: WKWebView は File のローカルパスを渡さない。text/uri-list の file:// → Bun がドラッグ用ペーストボードから
// 名前と大きさで照合（dropResolve）→ それでも分からなければ中身を読んで Bun に送り、一時ファイルのパスを使う（dropUpload）。
// 見た目: ドラッグ中は body に dnd-active、いま上にあるドロップ先に drop-over を付ける（CSS は index.css 側）。

import type { DropResult } from "../shared/types";

type DropApi = {
	dropResolve(p: { files: { name: string; size: number }[] }): Promise<{ paths: (string | null)[] }>;
	dropCheck(p: { paths: string[] }): Promise<{ items: { path: string; exists: boolean; dir: boolean }[] }>;
	dropToBuddy(p: { path: string }): Promise<DropResult>;
	dropUpload(p: { upload: string; name: string; to: "term" | "buddy"; size: number; chunk: string; first: boolean; last: boolean }): Promise<DropResult>;
};

type DropOptions = {
	api: DropApi;
	/** ターミナルのカード */
	dock: HTMLElement;
	/** Clawd くんの本体と吹き出し */
	clawdZones: () => HTMLElement[];
	/** アクティブな端末に貼る（送信しない） */
	paste: (text: string) => void;
	/** Clawd くんの吹き出しを開き、入力欄に差し込む */
	insertClawd: (text: string) => void;
	toast: (text: string) => void;
};

type Zone = "term" | "clawd";
type Payload = { kind: "files"; files: File[]; paths: (string | null)[] } | { kind: "paths"; paths: string[] } | { kind: "text"; text: string };

const MAX_FILES = 20;
const CLAWD_LIMIT = 10 * 1024 * 1024;
const CHUNK = 1024 * 1024;

export function initDrop(o: DropOptions) {
	let overEl: HTMLElement | null = null;
	let clearTimer = 0;

	const zoneOf = (target: EventTarget | null): { zone: Zone; el: HTMLElement } | null => {
		if (!(target instanceof Node)) return null;
		const c = o.clawdZones().find((z) => !z.hidden && z.contains(target));
		if (c) return { zone: "clawd", el: c };
		if (o.dock.contains(target)) return { zone: "term", el: o.dock };
		return null;
	};

	const setOver = (el: HTMLElement | null) => {
		if (overEl === el) return;
		overEl?.classList.remove("drop-over");
		overEl = el;
		el?.classList.add("drop-over");
	};

	const clear = () => {
		setOver(null);
		document.body.classList.remove("dnd-active");
	};

	const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement);

	// dragleave はウィンドウの外へ出たかを確かに判定できないので、dragover が途切れたら消す
	window.addEventListener(
		"dragover",
		(e) => {
			const dt = e.dataTransfer;
			const hit = zoneOf(e.target);
			const hasFiles = !!dt && Array.from(dt.types).includes("Files");
			if (hit) {
				e.preventDefault();
				if (dt) dt.dropEffect = "copy";
			} else if (hasFiles || !editable(e.target)) {
				// ファイルや URL を開いて画面が変わらないように。ほかの入力欄への文字のドロップは邪魔しない
				e.preventDefault();
				if (dt) dt.dropEffect = "none";
			}
			document.body.classList.add("dnd-active");
			setOver(hit?.el ?? null);
			clearTimeout(clearTimer);
			clearTimer = window.setTimeout(clear, 200);
		},
		true,
	);

	window.addEventListener(
		"drop",
		(e) => {
			clearTimeout(clearTimer);
			clear();
			const hit = zoneOf(e.target);
			const dt = e.dataTransfer;
			const hasFiles = !!dt && Array.from(dt.types).includes("Files");
			if (!hit) {
				if (hasFiles || !editable(e.target)) e.preventDefault();
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			if (!dt) return;
			// dataTransfer は drop の間しか読めないので、先に同期で取り出しておく
			const files = Array.from(dt.files);
			const uriList = dt.getData("text/uri-list");
			const plain = dt.getData("text/plain");
			void (async () => {
				try {
					const payload = await collect(o.api, files, uriList, plain);
					if (!payload) return;
					if (hit.zone === "term") await toTerm(o, payload);
					else await toClawd(o, payload);
				} catch (err) {
					console.error("ドロップを受け取れなかった", err);
					o.toast(`ドロップを受け取れなかった（${(err as Error).message}）`);
				}
			})();
		},
		true,
	);
}

// ───────── 中身を取り出す ─────────

async function collect(api: DropApi, files: File[], uriList: string, plain: string): Promise<Payload | null> {
	const uris = uriList
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter((s) => s && !s.startsWith("#"));
	const filePaths = uris.filter((u) => u.startsWith("file://")).map(fileUrlToPath).filter((p): p is string => !!p);

	if (files.length) {
		const list = files.slice(0, MAX_FILES);
		const paths: (string | null)[] = list.map((f) => {
			// File.path（Electron などの拡張）があれば使う。WKWebView にはない
			const own = (f as File & { path?: unknown }).path;
			if (typeof own === "string" && own.startsWith("/")) return own;
			return filePaths.find((p) => baseName(p).normalize("NFC") === f.name.normalize("NFC")) ?? null;
		});
		const missing = paths.flatMap((p, i) => (p ? [] : [i]));
		if (missing.length) {
			const r = await api.dropResolve({ files: missing.map((i) => ({ name: list[i]!.name, size: list[i]!.size })) });
			missing.forEach((i, k) => {
				paths[i] = r.paths[k] ?? null;
			});
		}
		return { kind: "files", files: list, paths };
	}
	if (filePaths.length) return { kind: "paths", paths: filePaths.slice(0, MAX_FILES) };

	// 文字: 1 行ずつ全部がパス（/・~/・file://）で、全部あるならパスとして扱う
	const text = plain || uris.join("\n");
	if (!text) return null;
	const lines = text
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter(Boolean);
	if (lines.length && lines.length <= MAX_FILES && lines.every((l) => /^(\/|~\/|file:\/\/)/.test(l))) {
		const { items } = await api.dropCheck({ paths: lines });
		if (items.length === lines.length && items.every((it) => it.exists)) return { kind: "paths", paths: items.map((it) => it.path) };
	}
	return { kind: "text", text };
}

function fileUrlToPath(u: string): string | null {
	try {
		const url = new URL(u);
		if (url.protocol !== "file:") return null;
		const p = decodeURIComponent(url.pathname);
		return p.startsWith("/") ? p : null;
	} catch {
		return null;
	}
}

const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;

/** 中身を少しずつ base64 で Bun に送る（パスが取れないとき） */
async function upload(api: DropApi, file: File, to: "term" | "buddy"): Promise<DropResult> {
	const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	for (let off = 0; ; ) {
		const end = Math.min(file.size, off + CHUNK);
		const chunk = await readBase64(file.slice(off, end));
		const r = await api.dropUpload({ upload: id, name: file.name, to, size: file.size, chunk, first: off === 0, last: end >= file.size });
		if (!r.ok || end >= file.size) return r;
		off = end;
	}
}

function readBase64(blob: Blob): Promise<string> {
	return new Promise((res, rej) => {
		const fr = new FileReader();
		fr.onload = () => res(String(fr.result).replace(/^data:[^,]*,/, ""));
		fr.onerror = () => rej(fr.error ?? new Error("読めなかった"));
		fr.readAsDataURL(blob);
	});
}

// ───────── 渡す ─────────

async function toTerm(o: DropOptions, p: Payload) {
	if (p.kind === "text") return o.paste(p.text);
	const out: string[] = [];
	const errors: string[] = [];
	if (p.kind === "paths") out.push(...p.paths);
	else {
		for (const [i, f] of p.files.entries()) {
			const known = p.paths[i];
			if (known) {
				out.push(known);
				continue;
			}
			const r = await upload(o.api, f, "term").catch((e: Error) => ({ ok: false, error: `${f.name} を読めなかった（${e.message}）` }) as DropResult);
			if (r.ok && r.path) out.push(r.path);
			else errors.push(r.error ?? f.name);
		}
	}
	if (out.length) o.paste(`${out.map(shellQuote).join(" ")} `);
	if (errors.length) o.toast(errors.join(" / "));
}

async function toClawd(o: DropOptions, p: Payload) {
	if (p.kind === "text") return o.insertClawd(p.text);
	const placed: string[] = [];
	const errors: string[] = [];
	const add = (r: DropResult, name: string) => {
		if (r.ok && r.path) placed.push(r.path);
		else errors.push(r.error ?? name);
	};
	if (p.kind === "paths") {
		for (const path of p.paths) add(await o.api.dropToBuddy({ path }), baseName(path));
	} else {
		for (const [i, f] of p.files.entries()) {
			const known = p.paths[i];
			if (known) {
				add(await o.api.dropToBuddy({ path: known }), f.name);
				continue;
			}
			if (f.size > CLAWD_LIMIT) {
				errors.push(`大きすぎる: ${f.name}（上限 ${CLAWD_LIMIT / 1024 / 1024}MB）`);
				continue;
			}
			add(await upload(o.api, f, "buddy").catch((e: Error) => ({ ok: false, error: `${f.name} を読めなかった（${e.message}）` }) as DropResult), f.name);
		}
	}
	if (placed.length) o.insertClawd(placed.map((path) => `ファイル: ${path}`).join("\n"));
	if (errors.length) o.toast(`Clawd くんに渡せなかった: ${errors.join(" / ")}`);
}

/**
 * Terminal.app と同じく、シェルで特別な意味を持つ ASCII の記号をバックスラッシュでエスケープする（日本語などはそのまま）。
 * 改行などの制御文字を含むときだけ $'…' で囲む。
 */
function shellQuote(p: string): string {
	if (/[\x00-\x1f\x7f]/.test(p)) {
		const body = p
			.replace(/\\/g, "\\\\")
			.replace(/'/g, "\\'")
			.replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
		return `$'${body}'`;
	}
	return p.replace(/[ !"#$&'()*;<>?[\\\]`{|}]/g, "\\$&");
}
