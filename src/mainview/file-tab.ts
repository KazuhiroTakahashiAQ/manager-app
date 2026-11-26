// File タブ（dock の Claude / Shell と並ぶ）。Explorer 風: 上にツールバー（戻る/進む/上へ・アドレスバー）、
// 右に一覧（名前 / 更新日時 / 種類 / サイズ。列見出しでソート）。起点はそのタブの claude の cwd。
// 読み取りと open / Finder / Quick Look だけ。bun 側は src/bun/files.ts。
// 参考: file-explorer-mac（Apache-2.0）の UI の構成（ツールバー・パンくず・列・右クリック）。コードは複製していない。

import type { FileEntry, FileListing, FileResolve } from "../shared/types";
import { formatDate, formatSize, glyphColor, kindLabel, sortEntries, type Sort, type SortKey } from "./file-format";

export type FileApi = {
	filesCwd(p: { id: string }): Promise<{ cwd: string; live: boolean }>;
	filesList(p: { path: string; hidden: boolean }): Promise<FileListing>;
	filesResolve(p: { input: string; base: string }): Promise<FileResolve>;
	filesReveal(p: { path: string }): Promise<{ ok: boolean }>;
	filesQuickLook(p: { path: string }): Promise<{ open: boolean }>;
	filesQuickLookClose(p: {}): Promise<{ ok: boolean }>;
	openPath(p: { path: string }): Promise<{ ok: boolean }>;
};

export type TreeRoot = { label: string; path: string };

/** ツリーの根（起点 / ホーム / /）。重複するパスは先のものだけ残す */
export function treeRoots(cwd: string, home: string): TreeRoot[] {
	const out: TreeRoot[] = [];
	const add = (label: string, path: string) => {
		if (path && !out.some((r) => r.path === path)) out.push({ label, path });
	};
	add(`${cwd.split("/").filter(Boolean).pop() ?? "/"}（起点）`, cwd);
	add("ホーム", home);
	add("/", "/");
	return out;
}

/** dir を表示するとき開いておく祖先（根を除く、根より下の階層）。根は dir を含む最も深いもの */
export function ancestorsToOpen(dir: string, roots: TreeRoot[]): { root: TreeRoot; open: string[] } | null {
	const hit = roots
		.filter((r) => dir === r.path || dir.startsWith(r.path === "/" ? "/" : `${r.path}/`))
		.sort((a, b) => b.path.length - a.path.length)[0];
	if (!hit) return null;
	const open = [hit.path];
	let acc = hit.path === "/" ? "" : hit.path;
	for (const part of dir.slice(hit.path === "/" ? 1 : hit.path.length + 1).split("/").filter(Boolean)) {
		acc += `/${part}`;
		if (acc !== dir) open.push(acc);
	}
	return { root: hit, open };
}

/** パンくずの区間（先頭は "/"）。クリックでその階層へ */
export function crumbs(path: string): { name: string; path: string }[] {
	const out = [{ name: "/", path: "/" }];
	let acc = "";
	for (const part of path.split("/").filter(Boolean)) {
		acc += `/${part}`;
		out.push({ name: part, path: acc });
	}
	return out;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const SVG = (body: string) =>
	`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const I_BACK = SVG('<path d="M10 3 5 8l5 5"/>');
const I_FWD = SVG('<path d="M6 3l5 5-5 5"/>');
const I_UP = SVG('<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>');
const I_RELOAD = SVG('<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3"/>');
const I_HOME = SVG('<path d="M2.5 8 8 3l5.5 5M4 7v6h3v-3.5h2V13h3V7"/>');

function glyph(e: Pick<FileEntry, "name" | "dir">): string {
	const c = glyphColor(e);
	return e.dir
		? `<svg class="ft-ico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 4.2c0-.7.5-1.2 1.2-1.2h3.2l1.3 1.5h6.1c.7 0 1.2.5 1.2 1.2v6.6c0 .7-.5 1.2-1.2 1.2H2.7c-.7 0-1.2-.5-1.2-1.2z" fill="${c}"/></svg>`
		: `<svg class="ft-ico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 1.5h5.8l3.2 3.2v8.6c0 .6-.4 1-1 1H3.5c-.6 0-1-.4-1-1V2.5c0-.6.4-1 1-1z" fill="none" stroke="${c}" stroke-width="1.3"/><path d="M9.3 1.5v3.2h3.2" fill="none" stroke="${c}" stroke-width="1.3"/></svg>`;
}

type State = {
	id: string;
	cwd: string;
	live: boolean;
	cwdAt: number;
	dir: string;
	entries: FileEntry[];
	/** 選択中の名前（並べ替え・再読み込みをまたいで保つ） */
	sel: string | null;
	error: string;
	loaded: boolean;
	/** 戻る / 進む（訪れたディレクトリ） */
	hist: string[];
	hi: number;
	/** ディレクトリごとに最後に選んでいた名前（戻る・上へで復元） */
	memory: Map<string, string>;
	/** ツリーで開いているフォルダ */
	open: Set<string>;
};
const RELOAD_CWD_MS = 30_000;
const MAX_ROWS = 3000;

export class FileTab {
	private states = new Map<string, State>();
	private id = "";
	private hidden = false;
	private sort: Sort = { key: "name", asc: true };
	private qlOpen = false;
	private editing = false;
	private view: FileEntry[] = [];
	private home = "";
	/** ツリー用: フォルダ → 子フォルダ（遅延読み込み。隠しファイルの切り替え・再読み込みで捨てる） */
	private kids = new Map<string, { name: string; path: string }[]>();
	private kidsLoading = new Map<string, Promise<void>>();
	private tree: HTMLElement;
	private crumbEl: HTMLElement;
	private input: HTMLInputElement;
	private msg: HTMLElement;
	private head: HTMLElement;
	private list: HTMLElement;
	private status: HTMLElement;
	private menu: HTMLElement;

	constructor(
		readonly el: HTMLElement,
		private api: FileApi,
	) {
		el.className = "filetab";
		el.tabIndex = 0;
		el.innerHTML =
			`<div class="ft-bar">` +
			`<button type="button" class="ft-btn" data-act="back" title="戻る（Alt+←）">${I_BACK}</button>` +
			`<button type="button" class="ft-btn" data-act="fwd" title="進む（Alt+→）">${I_FWD}</button>` +
			`<button type="button" class="ft-btn" data-act="up" title="上へ（Backspace）">${I_UP}</button>` +
			`<div class="ft-addr" title="クリックでパスを入力"><nav class="ft-crumbs" aria-label="パス"></nav>` +
			`<input class="ft-input" type="text" spellcheck="false" hidden /></div>` +
			`<button type="button" class="ft-btn" data-act="cwd" title="claude の cwd に戻る">${I_HOME}</button>` +
			`<button type="button" class="ft-btn" data-act="reload" title="再読み込み">${I_RELOAD}</button>` +
			`<button type="button" class="ft-btn ft-txt" data-act="hidden" title="隠しファイルの表示" aria-pressed="false">.*</button></div>` +
			`<div class="ft-msg" role="status"></div>` +
			`<div class="ft-body"><div class="ft-tree" role="tree" aria-label="フォルダー"></div><div class="ft-main"><div class="ft-head" role="row"></div>` +
			`<div class="ft-list" role="listbox"></div></div></div>` +
			`<div class="ft-status"></div><div class="ft-menu" hidden></div>`;
		this.tree = el.querySelector(".ft-tree")!;
		this.crumbEl = el.querySelector(".ft-crumbs")!;
		this.input = el.querySelector(".ft-input")!;
		this.msg = el.querySelector(".ft-msg")!;
		this.head = el.querySelector(".ft-head")!;
		this.list = el.querySelector(".ft-list")!;
		this.status = el.querySelector(".ft-status")!;
		this.menu = el.querySelector(".ft-menu")!;
		el.addEventListener("click", (e) => this.onClick(e));
		el.addEventListener("dblclick", (e) => {
			const row = (e.target as HTMLElement).closest<HTMLElement>(".ft-row[data-i]");
			if (row) void this.activate(this.view[Number(row.dataset.i)]);
		});
		el.addEventListener("contextmenu", (e) => this.onContext(e));
		el.addEventListener("keydown", (e) => this.onKey(e));
		this.input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter" && !e.isComposing) void this.go(this.input.value).then(() => this.endEdit());
			if (e.key === "Escape") this.endEdit();
		});
		this.input.addEventListener("blur", () => this.endEdit());
		document.addEventListener("pointerdown", (e) => {
			if (!this.menu.hidden && !this.menu.contains(e.target as Node)) this.menu.hidden = true;
		});
	}

	private st(): State {
		let s = this.states.get(this.id);
		if (!s) {
			s = { id: this.id, cwd: "", live: true, cwdAt: 0, dir: "", entries: [], sel: null, error: "", loaded: false, hist: [], hi: -1, memory: new Map(), open: new Set() };
			this.states.set(this.id, s);
		}
		return s;
	}

	/**
	 * File タブを前に出した / 親タブが切り替わった。初回はそのタブの claude の cwd の一覧をすぐ出す（入力待ち・空表示にしない）。
	 * 2 回目以降は前回の場所を出し、cwd が変わっていれば（今 cwd にいるときだけ）追従する。
	 * 非同期の途中でタブが切り替わっても、結果は取りに行った側の状態に書く。
	 */
	async show(id: string) {
		this.id = id;
		const s = this.st();
		this.render();
		this.el.focus(); // 一覧にフォーカス（読み込みの完了を待たない）
		if (!s.loaded) await this.resetToCwd(s);
		else if (Date.now() - s.cwdAt > RELOAD_CWD_MS) await this.refreshCwd(s);
		if (this.id === id && !this.editing) this.el.focus();
	}

	private async refreshCwd(s: State) {
		const r = await this.fetchCwd(s);
		if (!r) return;
		if (r.cwd !== s.cwd) {
			const following = s.dir === s.cwd;
			s.cwd = r.cwd;
			s.live = r.live;
			if (following) await this.visit(s, r.cwd);
		}
	}

	private async resetToCwd(s: State) {
		const r = await this.fetchCwd(s);
		if (!r) return this.noRpc(s);
		s.cwd = r.cwd;
		s.live = r.live;
		await this.visit(s, r.cwd);
	}

	/** bun が応答しない（再起動前の古い bun など）ときは null。`/` に倒さない */
	private async fetchCwd(s: State): Promise<{ cwd: string; live: boolean } | null> {
		try {
			const r = await this.api.filesCwd({ id: s.id });
			s.cwdAt = Date.now();
			return r.cwd ? r : null;
		} catch {
			return null;
		}
	}

	private noRpc(s: State) {
		s.error = "File の取得に失敗（bun が古い可能性。アプリの再起動で直る）";
		this.render(s);
	}

	/** dir を読み込んで表示する（履歴には触らない） */
	private async load(s: State, dir: string, select?: string | null): Promise<boolean> {
		const r = await this.api.filesList({ path: dir, hidden: this.hidden }).catch(() => null);
		if (!r || !r.ok) {
			s.error = `${r?.error ?? "開けない"}: ${dir}`;
			this.render(s);
			return false;
		}
		s.loaded = true;
		s.error = "";
		s.dir = r.path;
		s.entries = r.entries;
		this.pickInitial(s, select ?? s.memory.get(r.path) ?? null);
		this.render(s);
		return true;
	}

	/** 選択を決める（指定の名前があればそれ、なければ先頭） */
	private pickInitial(s: State, name: string | null) {
		const view = sortEntries(s.entries, this.sort);
		s.sel = name && view.some((e) => e.name === name) ? name : (view[0]?.name ?? null);
	}

	/** 移動（履歴に積む）。同じ場所への再訪は積まない */
	private async visit(s: State, dir: string, select?: string | null) {
		const prev = s.dir;
		if (prev && s.sel) s.memory.set(prev, s.sel);
		if (!(await this.load(s, dir, select))) return;
		if (s.hist[s.hi] !== s.dir) {
			s.hist = s.hist.slice(0, s.hi + 1);
			s.hist.push(s.dir);
			s.hi = s.hist.length - 1;
		}
	}

	private async step(d: -1 | 1) {
		const s = this.st();
		const to = s.hi + d;
		if (to < 0 || to >= s.hist.length) return;
		if (s.dir && s.sel) s.memory.set(s.dir, s.sel);
		if (await this.load(s, s.hist[to]!)) {
			s.hi = to;
			this.render(s);
		}
	}

	/** パス入力・外から渡された相対 / 絶対パス（パスの Cmd+クリックもここ）。ディレクトリなら入る、ファイルなら親を開いて選択 */
	async go(input: string) {
		if (!this.id) return;
		const s = this.st();
		const r = await this.api.filesResolve({ input, base: s.dir || s.cwd });
		if (!r.ok || !r.path) {
			s.error = `${r.error ?? "見つからない"}: ${input.trim()}`;
			this.render(s);
			return;
		}
		if (r.dir) await this.visit(s, r.path);
		else {
			const slash = r.path.lastIndexOf("/");
			await this.visit(s, r.path.slice(0, slash) || "/", r.path.slice(slash + 1));
		}
		if (this.id === s.id) this.el.focus();
	}

	private async up() {
		const s = this.st();
		if (s.dir && s.dir !== "/") {
			const slash = s.dir.lastIndexOf("/");
			await this.visit(s, s.dir.slice(0, slash) || "/", s.dir.slice(slash + 1));
		}
	}

	private async activate(e: FileEntry | undefined) {
		if (!e) return;
		if (e.dir) await this.visit(this.st(), e.path);
		else await this.api.openPath({ path: e.path });
	}

	private selIndex(): number {
		const s = this.st();
		return this.view.findIndex((e) => e.name === s.sel);
	}

	private move(d: number, abs = false) {
		const s = this.st();
		if (!this.view.length) return;
		const i = abs ? (d < 0 ? 0 : this.view.length - 1) : Math.max(0, Math.min(this.view.length - 1, this.selIndex() + d));
		s.sel = this.view[i]!.name;
		this.render();
		this.list.querySelector(".ft-row[aria-selected='true']")?.scrollIntoView({ block: "nearest" });
	}

	private async quickLook() {
		const e = this.view[this.selIndex()];
		if (!e) return;
		this.qlOpen = (await this.api.filesQuickLook({ path: e.path })).open;
	}

	/** タブを離れるとき・Esc で Quick Look を閉じる */
	async closeQuickLook() {
		if (!this.qlOpen) return false;
		this.qlOpen = false;
		await this.api.filesQuickLookClose({});
		return true;
	}

	private startEdit() {
		const s = this.st();
		this.editing = true;
		this.input.hidden = false;
		this.crumbEl.hidden = true;
		this.input.value = s.dir || s.cwd;
		this.input.placeholder = "パス（絶対 / ~ / cwd 起点の相対）→ Enter";
		this.input.focus();
		this.input.select();
	}

	private endEdit() {
		if (!this.editing) return;
		this.editing = false;
		this.input.hidden = true;
		this.crumbEl.hidden = false;
		this.el.focus();
	}

	private onKey(ev: KeyboardEvent) {
		if (ev.isComposing || ev.metaKey || ev.ctrlKey) return;
		const k = ev.key;
		if (ev.altKey) {
			if (k === "ArrowLeft") void this.step(-1);
			else if (k === "ArrowRight") void this.step(1);
			else return;
			return void ev.preventDefault();
		}
		if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Backspace", "Escape"].includes(k)) return;
		ev.preventDefault();
		if (k === "ArrowDown") this.move(1);
		else if (k === "ArrowUp") this.move(-1);
		else if (k === "Home") this.move(-1, true);
		else if (k === "End") this.move(1, true);
		else if (k === "Enter") void this.activate(this.view[this.selIndex()]);
		else if (k === " ") void this.quickLook();
		else if (k === "Backspace") void this.up();
		else if (k === "Escape") {
			this.menu.hidden = true;
			void this.closeQuickLook();
		}
	}

	private onContext(ev: MouseEvent) {
		const row = (ev.target as HTMLElement).closest<HTMLElement>(".ft-row[data-i]");
		if (!row) return;
		ev.preventDefault();
		const e = this.view[Number(row.dataset.i)];
		if (!e) return;
		this.st().sel = e.name;
		this.render();
		this.menu.innerHTML =
			`<button type="button" data-m="open">${e.dir ? "開く（入る）" : "開く"}</button>` +
			`<button type="button" data-m="reveal">Finder で表示</button>` +
			`<button type="button" data-m="copy">パスをコピー</button>`;
		this.menu.dataset.path = e.path;
		this.menu.dataset.dir = String(e.dir);
		this.menu.hidden = false;
		const box = this.el.getBoundingClientRect();
		const x = Math.min(ev.clientX - box.left, box.width - 170);
		const y = Math.min(ev.clientY - box.top, box.height - 100);
		this.menu.style.left = `${Math.max(4, x)}px`;
		this.menu.style.top = `${Math.max(4, y)}px`;
	}

	private onClick(ev: MouseEvent) {
		const t = ev.target as HTMLElement;
		const s = this.st();
		const m = t.closest<HTMLElement>("[data-m]");
		if (m) {
			const path = this.menu.dataset.path!;
			this.menu.hidden = true;
			if (m.dataset.m === "open") {
				if (this.menu.dataset.dir === "true") void this.visit(s, path);
				else void this.api.openPath({ path });
			} else if (m.dataset.m === "reveal") void this.api.filesReveal({ path });
			else void this.copy(path);
			return;
		}
		const tw = t.closest<HTMLElement>("[data-twist]");
		if (tw) return void this.toggleNode(s, tw.dataset.twist!);
		const tn = t.closest<HTMLElement>("[data-tp]");
		if (tn) return void this.visit(s, tn.dataset.tp!).then(() => this.el.focus());
		const crumb = t.closest<HTMLElement>("[data-path]");
		if (crumb) return void this.visit(s, crumb.dataset.path!);
		const sortBy = t.closest<HTMLElement>("[data-sort]");
		if (sortBy) {
			const key = sortBy.dataset.sort as SortKey;
			this.sort = { key, asc: this.sort.key === key ? !this.sort.asc : true };
			this.render();
			return;
		}
		const act = t.closest<HTMLElement>("[data-act]");
		if (act) {
			const a = act.dataset.act;
			if (a === "hidden") {
				this.hidden = !this.hidden;
				this.kids.clear();
				void this.load(s, s.dir || s.cwd, s.sel);
			} else if (a === "reload") {
				this.kids.clear();
				void this.load(s, s.dir || s.cwd, s.sel);
			}
			else if (a === "cwd") void this.resetToCwd(s);
			else if (a === "back") void this.step(-1);
			else if (a === "fwd") void this.step(1);
			else if (a === "up") void this.up();
			return;
		}
		if (t.closest(".ft-addr") && !t.closest(".ft-input")) return this.startEdit(); // パンくずの余白 = 編集
		const row = t.closest<HTMLElement>(".ft-row[data-i]");
		if (row) {
			s.sel = this.view[Number(row.dataset.i)]?.name ?? null;
			this.render();
			this.el.focus();
		}
	}

	private async copy(path: string) {
		try {
			await navigator.clipboard.writeText(path);
			this.msg.textContent = "パスをコピーした";
		} catch {
			this.msg.textContent = "コピーできなかった";
		}
	}

	private roots(s: State): TreeRoot[] {
		return treeRoots(s.cwd || s.dir, this.home);
	}

	private async loadKids(path: string) {
		if (this.kids.has(path)) return;
		let p = this.kidsLoading.get(path);
		if (!p) {
			p = this.api
				.filesList({ path, hidden: this.hidden })
				.then((r) => void this.kids.set(path, r.ok ? r.entries.filter((e) => e.dir).map((e) => ({ name: e.name, path: e.path })) : []))
				.catch(() => void this.kids.set(path, []))
				.finally(() => void this.kidsLoading.delete(path));
			this.kidsLoading.set(path, p);
		}
		await p;
	}

	private async toggleNode(s: State, path: string) {
		if (s.open.has(path)) s.open.delete(path);
		else {
			s.open.add(path);
			await this.loadKids(path);
		}
		this.renderTree(s);
	}

	/** いまのフォルダまでの祖先を開き、子を遅延で読む。ホームの場所は初回だけ取る */
	private async syncTree(s: State) {
		if (!this.home) {
			const r = await this.api.filesResolve({ input: "~", base: "/" }).catch(() => null);
			this.home = r?.ok && r.path ? r.path : "";
		}
		const a = ancestorsToOpen(s.dir, this.roots(s));
		if (a) for (const o of a.open) s.open.add(o);
		this.renderTree(s);
		if (a) {
			for (const o of a.open) await this.loadKids(o);
			this.renderTree(s);
			this.tree.querySelector(".ft-node[aria-selected='true']")?.scrollIntoView({ block: "nearest" });
		}
	}

	private renderTree(s: State) {
		if (s.id !== this.id) return;
		const roots = this.roots(s);
		const cur = ancestorsToOpen(s.dir, roots)?.root.path;
		const node = (label: string, path: string, depth: number, isRoot: boolean, selectedHere: boolean): string => {
			const open = s.open.has(path);
			const kids = this.kids.get(path);
			const mark = open ? "▾" : "▸";
			let h =
				`<div class="ft-node" role="treeitem" data-tp="${esc(path)}" style="padding-left:${6 + depth * 12}px" aria-selected="${selectedHere && path === s.dir}">` +
				`<span class="ft-twist" data-twist="${esc(path)}">${mark}</span>${glyph({ name: label, dir: true })}<span class="ft-nlabel">${esc(label)}</span></div>`;
			if (open && kids) {
				const MAX = 500;
				for (const k of kids.slice(0, MAX)) h += node(k.name, k.path, depth + 1, false, selectedHere);
				if (kids.length > MAX) h += `<div class="ft-more" style="padding-left:${6 + (depth + 1) * 12}px">他 ${kids.length - MAX} 件</div>`;
			} else if (open && !kids) h += `<div class="ft-more" style="padding-left:${6 + (depth + 1) * 12}px">…</div>`;
			void isRoot;
			return h;
		};
		this.tree.innerHTML = roots.map((r) => node(r.label, r.path, 0, true, r.path === cur)).join("");
	}

	private render(st?: State) {
		const s = st ?? this.st();
		if (s.id !== this.id) return; // 裏で終わった別タブの結果は、そのタブを開いたときに描く
		this.view = sortEntries(s.entries, this.sort);
		this.crumbEl.innerHTML = crumbs(s.dir || s.cwd || "/")
			.map((c) => `<button type="button" class="ft-crumb" data-path="${esc(c.path)}">${esc(c.name)}</button>`)
			.join("");
		const q = (a: string) => this.el.querySelector(`[data-act='${a}']`) as HTMLButtonElement;
		q("hidden").setAttribute("aria-pressed", String(this.hidden));
		q("back").disabled = s.hi <= 0;
		q("fwd").disabled = s.hi >= s.hist.length - 1;
		q("up").disabled = !s.dir || s.dir === "/";
		this.msg.textContent = s.error || (s.live ? "" : "claude の cwd を取れなかったので Manager/ を表示");
		this.msg.dataset.error = String(Boolean(s.error));
		const arrow = (k: SortKey) => (this.sort.key === k ? (this.sort.asc ? " ▲" : " ▼") : "");
		this.head.innerHTML = (
			[
				["name", "名前"],
				["mtime", "更新日時"],
				["kind", "種類"],
				["size", "サイズ"],
			] as [SortKey, string][]
		)
			.map(([k, l]) => `<button type="button" class="ft-h ft-h-${k}" data-sort="${k}">${l}${arrow(k)}</button>`)
			.join("");
		const top = this.list.scrollTop;
		const shown = this.view.slice(0, MAX_ROWS);
		this.list.innerHTML = shown.length
			? shown
					.map(
						(e, i) =>
							`<div class="ft-row" role="option" data-i="${i}" aria-selected="${e.name === s.sel}">` +
							`<span class="ft-c ft-name">${glyph(e)}<span>${esc(e.name)}</span></span>` +
							`<span class="ft-c ft-mtime">${formatDate(e.mtime)}</span>` +
							`<span class="ft-c ft-kind">${esc(kindLabel(e))}</span>` +
							`<span class="ft-c ft-size">${e.dir ? "" : formatSize(e.size)}</span></div>`,
					)
					.join("")
			: `<div class="ft-empty">${s.loaded ? "このフォルダーは空" : s.error ? "" : "読み込み中…"}</div>`;
		this.list.scrollTop = top;
		void this.syncTree(s);
		const more = this.view.length > MAX_ROWS ? `（先頭 ${MAX_ROWS} 件を表示）` : "";
		this.status.textContent = s.loaded ? `${this.view.length} 項目${more}${s.sel ? ` ・ 選択: ${s.sel}` : ""}` : "";
	}
}
