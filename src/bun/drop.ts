// 画面へのファイルのドラッグ＆ドロップ（ターミナル）の Bun 側。
// - WKWebView はドロップされた File のローカルパスを渡さない。drop の直後にドラッグ用のペーストボードを
//   Swift のヘルパー（native/drag-paths.swift）で読み、名前と大きさが合うパスを返す（resolve）。
// - パスが取れないとき（ほかのアプリからの画像など）は、画面がファイルを読んで少しずつ送り、ここで書く（upload）。
//   置き場は userData/drops/。
// - drops/ は起動時に 7 日より古いものを消す。

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, appendFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, isAbsolute, join, resolve } from "path";
import type { DropResult } from "../shared/types";
import { ensureNative } from "./native";
import dragPathsSource from "../../native/drag-paths.swift" with { type: "text" };

/** パスが取れずに画面から送ってもらうときの上限 */
const TERM_UPLOAD_LIMIT = 50 * 1024 * 1024;
const KEEP_MS = 7 * 86_400_000;

type Upload = { path: string; written: number; limit: number };

export class Drops {
	private uploads = new Map<string, Upload>();

	constructor(private o: { dataDir: string }) {
		cleanup(this.termDir);
		// 初回はコンパイルに数秒かかるので先に作っておく
		void ensureNative("drag-paths", dragPathsSource, o.dataDir);
	}

	get termDir() {
		return join(this.o.dataDir, "drops");
	}

	/** ドロップされた File（名前・大きさ）に対応する絶対パス。分からないものは null */
	async resolve(files: { name: string; size: number }[]): Promise<(string | null)[]> {
		const candidates = await this.dragPasteboard();
		const used = new Set<string>();
		return files.map((f) => {
			const name = f.name.normalize("NFC");
			const hit = candidates.find((p) => {
				if (used.has(p) || basename(p).normalize("NFC") !== name) return false;
				try {
					const st = statSync(p);
					return st.isDirectory() || st.size === f.size;
				} catch {
					return false;
				}
			});
			if (!hit) return null;
			used.add(hit);
			return hit;
		});
	}

	/** 文字で渡されたパス（~/ も可）がいまあるか */
	check(paths: string[]): { path: string; exists: boolean; dir: boolean }[] {
		return paths.slice(0, 100).map((raw) => {
			const path = expand(raw);
			if (!path) return { path: raw, exists: false, dir: false };
			try {
				const st = statSync(path);
				return { path, exists: true, dir: st.isDirectory() };
			} catch {
				return { path, exists: false, dir: false };
			}
		});
	}

	/** 画面から少しずつ送られた中身を書く（first で作り、last で書き終わったパスを返す） */
	upload(p: { upload: string; name: string; size: number; chunk: string; first: boolean; last: boolean }): DropResult {
		if (!/^[A-Za-z0-9-]{1,64}$/.test(p.upload)) return { ok: false, error: "受け取れない" };
		const limit = TERM_UPLOAD_LIMIT;
		let u = this.uploads.get(p.upload);
		if (p.first) {
			if (p.size > limit) return { ok: false, error: tooLarge(p.name, p.size, limit) };
			try {
				const path = uniquePath(this.termDir, p.name);
				writeFileSync(path, "");
				u = { path, written: 0, limit };
				this.uploads.set(p.upload, u);
			} catch (e) {
				return { ok: false, error: `書けなかった: ${p.name}（${(e as Error).message}）` };
			}
		}
		if (!u) return { ok: false, error: "受け取りが途切れた" };
		try {
			const buf = Buffer.from(p.chunk, "base64");
			u.written += buf.length;
			if (u.written > u.limit) throw new Error(tooLarge(p.name, u.written, u.limit));
			appendFileSync(u.path, buf);
		} catch (e) {
			this.uploads.delete(p.upload);
			rmSync(u.path, { force: true });
			return { ok: false, error: (e as Error).message };
		}
		if (!p.last) return { ok: true };
		this.uploads.delete(p.upload);
		return { ok: true, path: u.path };
	}

	private async dragPasteboard(): Promise<string[]> {
		const bin = await ensureNative("drag-paths", dragPathsSource, this.o.dataDir);
		if (!bin) return [];
		try {
			const p = Bun.spawn([bin], { stdout: "pipe", stderr: "ignore" });
			const timer = setTimeout(() => p.kill(), 3000);
			const out = await new Response(p.stdout).text();
			clearTimeout(timer);
			const v: unknown = JSON.parse(out.trim() || "[]");
			return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && isAbsolute(s)) : [];
		} catch (e) {
			console.error("ドラッグのパスを読めなかった", e);
			return [];
		}
	}
}

function expand(raw: string): string | null {
	let p = raw.trim();
	if (p.startsWith("file://")) {
		try {
			p = decodeURIComponent(new URL(p).pathname);
		} catch {
			return null;
		}
	}
	if (p === "~" || p.startsWith("~/")) p = join(homedir(), p.slice(1));
	return isAbsolute(p) ? resolve(p) : null;
}

function tooLarge(name: string, size: number, limit: number) {
	const mb = (n: number) => (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0);
	return `大きすぎる: ${name}（${mb(size)}MB。上限 ${mb(limit)}MB）`;
}

/** <dir>/<YYYYMMDD-HHMMSS>-<名前>。重なれば -2, -3 … を付ける */
function uniquePath(dir: string, name: string): string {
	mkdirSync(dir, { recursive: true });
	const safe =
		name
			.normalize("NFC")
			.replace(/[/:\x00-\x1f\x7f]/g, "_")
			.replace(/^\.+/, "_")
			.slice(-120) || "file";
	const d = new Date();
	const z = (n: number) => String(n).padStart(2, "0");
	const stamp = `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
	const dot = safe.lastIndexOf(".");
	const [stem, ext] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ""];
	for (let i = 1; ; i++) {
		const p = join(dir, `${stamp}-${stem}${i > 1 ? `-${i}` : ""}${ext}`);
		if (!existsSync(p)) return p;
	}
}

function cleanup(dir: string) {
	try {
		if (!existsSync(dir)) return;
		const limit = Date.now() - KEEP_MS;
		for (const f of readdirSync(dir)) {
			const p = join(dir, f);
			try {
				if (statSync(p).mtimeMs < limit) rmSync(p, { recursive: true, force: true });
			} catch {
				// 次の起動で
			}
		}
	} catch (e) {
		console.error(`${dir} を片付けられなかった`, e);
	}
}
