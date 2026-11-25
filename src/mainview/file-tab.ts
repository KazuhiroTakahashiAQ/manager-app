// File タブ（dock の Claude / Shell と並ぶ）。起点はそのタブの claude の cwd。1 階層のリスト・パンくず・パス入力。
// 読み取りと open / Finder / Quick Look だけ。bun 側は src/bun/files.ts。

import type { FileEntry, FileListing, FileResolve } from "../shared/types";

export type FileApi = {
	filesCwd(p: { id: string }): Promise<{ cwd: string; live: boolean }>;
	filesList(p: { path: string; hidden: boolean }): Promise<FileListing>;
	filesResolve(p: { input: string; base: string }): Promise<FileResolve>;
	filesReveal(p: { path: string }): Promise<{ ok: boolean }>;
	filesQuickLook(p: { path: string }): Promise<{ open: boolean }>;
	filesQuickLookClose(p: {}): Promise<{ ok: boolean }>;
	openPath(p: { path: string }): Promise<{ ok: boolean }>;
};

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

function sizeLabel(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type State = { id: string; cwd: string; live: boolean; cwdAt: number; dir: string; entries: FileEntry[]; sel: number; error: string; loaded: boolean };
const RELOAD_CWD_MS = 30_000;

export class FileTab {
	private states = new Map<string, State>();
	private id = "";
	private hidden = false;
	private qlOpen = false;
	private head: HTMLElement;
	private list: HTMLElement;
	private input: HTMLInputElement;
	private crumbEl: HTMLElement;
	private msg: HTMLElement;

	constructor(
		readonly el: HTMLElement,
		private api: FileApi,
	) {
		el.className = "filetab";
		el.tabIndex = 0;
		el.innerHTML =
			`<div class="ft-bar"><nav class="ft-crumbs" aria-label="パス"></nav>` +
			`<button type="button" class="ft-btn" data-act="cwd" title="claude の cwd に戻す（再取得）">cwd</button>` +
			`<button type="button" class="ft-btn" data-act="reload" title="再読み込み">↻</button>` +
			`<button type="button" class="ft-btn" data-act="hidden" title="隠しファイルの表示" aria-pressed="false">.*</button></div>` +
			`<input class="ft-input" type="text" spellcheck="false" placeholder="パス（絶対 / ~ / cwd 起点の相対）→ Enter" />` +
			`<div class="ft-msg" role="status"></div><div class="ft-list" role="listbox"></div>`;
		this.head = el.querySelector(".ft-bar")!;
		this.crumbEl = el.querySelector(".ft-crumbs")!;
		this.input = el.querySelector(".ft-input")!;
		this.msg = el.querySelector(".ft-msg")!;
		this.list = el.querySelector(".ft-list")!;
		el.addEventListener("click", (e) => this.onClick(e));
		el.addEventListener("dblclick", (e) => {
			const row = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
			if (row) void this.activate(Number(row.dataset.i));
		});
		el.addEventListener("keydown", (e) => this.onKey(e));
		this.input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter" && !e.isComposing) void this.go(this.input.value);
			if (e.key === "Escape") this.el.focus();
		});
	}

	private st(): State {
		let s = this.states.get(this.id);
		if (!s) {
			s = { id: this.id, cwd: "", live: true, cwdAt: 0, dir: "", entries: [], sel: 0, error: "", loaded: false };
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
		if (!s.loaded) await this.resetToCwd(s);
		else if (Date.now() - s.cwdAt > RELOAD_CWD_MS) await this.refreshCwd(s);
		if (this.id === id) this.el.focus();
	}

	/** cwd が変わっていたら、そこへ追従する（今いる場所が前の cwd のままのときだけ） */
	private async refreshCwd(s: State) {
		const r = await this.fetchCwd(s);
		if (!r) return;
		const { cwd, live } = r;
		if (cwd !== s.cwd) {
			const following = s.dir === s.cwd;
			s.cwd = cwd;
			s.live = live;
			if (following) await this.load(s, cwd);
		}
	}

	private async resetToCwd(s: State) {
		const r = await this.fetchCwd(s);
		if (!r) return this.noRpc(s);
		const { cwd, live } = r;
		s.cwd = cwd;
		s.live = live;
		await this.load(s, cwd);
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

	private async load(s: State, dir: string, select?: string) {
		const r = await this.api.filesList({ path: dir, hidden: this.hidden }).catch(() => null);
		if (!r || !r.ok) {
			s.error = `${r?.error ?? "開けない"}: ${dir}`;
			this.render(s);
			return;
		}
		s.loaded = true;
		s.error = "";
		s.dir = r.path;
		s.entries = r.entries;
		const at = select ? r.entries.findIndex((e) => e.name === select) : -1;
		s.sel = at >= 0 ? at : 0;
		this.render(s);
	}

	/** パス入力・外から渡された相対 / 絶対パス。ディレクトリなら入る、ファイルなら親を開いて選択 */
	async go(input: string) {
		if (!this.id) return;
		const s = this.st();
		const r = await this.api.filesResolve({ input, base: s.dir || s.cwd });
		if (!r.ok || !r.path) {
			s.error = `${r.error ?? "見つからない"}: ${input.trim()}`;
			this.render();
			return;
		}
		if (r.dir) await this.load(s, r.path);
		else {
			const slash = r.path.lastIndexOf("/");
			await this.load(s, r.path.slice(0, slash) || "/", r.path.slice(slash + 1));
		}
		this.input.value = "";
		this.el.focus();
	}

	private async up() {
		const s = this.st();
		if (s.dir && s.dir !== "/") {
			const slash = s.dir.lastIndexOf("/");
			await this.load(s, s.dir.slice(0, slash) || "/", s.dir.slice(slash + 1));
		}
	}

	private async activate(i: number) {
		const e = this.st().entries[i];
		if (!e) return;
		if (e.dir) await this.load(this.st(), e.path);
		else await this.api.openPath({ path: e.path });
	}

	private move(d: number) {
		const s = this.st();
		if (!s.entries.length) return;
		s.sel = Math.max(0, Math.min(s.entries.length - 1, s.sel + d));
		this.render();
		this.list.querySelector(".ft-row[aria-selected='true']")?.scrollIntoView({ block: "nearest" });
	}

	private async quickLook() {
		const e = this.st().entries[this.st().sel];
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

	private onKey(ev: KeyboardEvent) {
		if (ev.isComposing || ev.metaKey || ev.ctrlKey || ev.altKey) return;
		const k = ev.key;
		const handled = ["ArrowDown", "ArrowUp", "Enter", " ", "Backspace", "Escape"];
		if (!handled.includes(k)) return;
		ev.preventDefault();
		if (k === "ArrowDown") this.move(1);
		else if (k === "ArrowUp") this.move(-1);
		else if (k === "Enter") void this.activate(this.st().sel);
		else if (k === " ") void this.quickLook();
		else if (k === "Backspace") void this.up();
		else if (k === "Escape") void this.closeQuickLook();
	}

	private onClick(e: MouseEvent) {
		const t = e.target as HTMLElement;
		const s = this.st();
		const crumb = t.closest<HTMLElement>("[data-path]");
		if (crumb) return void this.load(s, crumb.dataset.path!);
		const act = t.closest<HTMLElement>("[data-act]");
		if (act) {
			const a = act.dataset.act;
			if (a === "hidden") {
				this.hidden = !this.hidden;
				void this.load(s, s.dir || s.cwd);
			} else if (a === "reload") void this.load(s, s.dir || s.cwd);
			else if (a === "cwd") void this.resetToCwd(s);
			else {
				const i = Number(act.closest<HTMLElement>("[data-i]")?.dataset.i);
				const en = s.entries[i];
				if (!en) return;
				if (a === "open") void this.api.openPath({ path: en.path });
				else if (a === "reveal") void this.api.filesReveal({ path: en.path });
				else if (a === "copy") void this.copy(en.path);
			}
			return;
		}
		const row = t.closest<HTMLElement>("[data-i]");
		if (row) {
			s.sel = Number(row.dataset.i);
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

	private render(st?: State) {
		const s = st ?? this.st();
		if (s.id !== this.id) return; // 裏で終わった別タブの結果は、そのタブを開いたときに描く
		this.crumbEl.innerHTML = crumbs(s.dir || s.cwd || "/")
			.map((c) => `<button type="button" class="ft-crumb" data-path="${esc(c.path)}">${esc(c.name)}</button>`)
			.join("");
		this.head.querySelector("[data-act='hidden']")!.setAttribute("aria-pressed", String(this.hidden));
		this.msg.textContent = s.error || (s.live ? "" : "claude の cwd を取れなかったので Manager/ を表示");
		this.msg.dataset.error = String(Boolean(s.error));
		this.list.innerHTML = s.entries.length
			? s.entries
					.map(
						(e, i) =>
							`<div class="ft-row" role="option" data-i="${i}" aria-selected="${i === s.sel}">` +
							`<span class="ft-name">${e.dir ? "▸ " : ""}${esc(e.name)}</span>` +
							`<span class="ft-size">${e.dir ? "" : sizeLabel(e.size)}</span>` +
							`<span class="ft-acts"><button type="button" data-act="open" title="既定のアプリで開く">開く</button>` +
							`<button type="button" data-act="reveal" title="Finder で表示">Finder</button>` +
							`<button type="button" data-act="copy" title="パスをコピー">パス</button></span></div>`,
					)
					.join("")
			: `<div class="ft-empty">${s.loaded ? "空" : s.error ? "" : "読み込み中…"}</div>`;
	}
}
