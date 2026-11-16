// 壁打ち相手 Clawd くん。ウィンドウ全体の上の層をふよふよ歩く、Claude Code の Clawd くんのドット絵（canvas に描く。接地影・まばたき・弾み）。
// - ゆっくりランダムに歩く・止まる・たまに向きを変える。本体と吹き出し以外はクリックを透過する。
// - ドラッグで好きな場所へ（離した場所からまた歩く。位置は localStorage）。
//   掴まれている間は目が「><」になり、手足をバタバタさせて汗を飛ばす。檻に近いほど激しく、汗の間隔も短くなる。
// - ターミナルのタブの帯（位置切り替えの丸いボタンの背後）に檻がある。檻の中に落とすと、自分では出られない（中だけを歩く）。掴んで外に出せば出られる。
// - クリックで吹き出しを開いて話す（Enter で送る・Shift+Enter で改行・Esc で閉じる）。開いている間は歩かない。
// - 返事中は小さく揺れる。Ctrl の 2 連打（アプリの外でも。bun 側のヘルパー）で呼び出せる。

import type { BuddyLine, BuddyState } from "../shared/types";

// 当たり判定・配置の箱（CSS px）。Claude Code の起動画面の Clawd くんと同じドット絵（横 18 × 縦 5 ドット）:
//
//    ▐▛███▜▌        ...############...   0 段目: 胴体
//   ▝▜█████▛▘       ...##.######.##...   1 段目: 胴体と目（5・12 列目）
//     ▘▘ ▝▝         .################.   2 段目: 胴体と腕（1〜2・15〜16 列目）
//                   ...############...   3 段目: 胴体
//                   ....#.#....#.#....   4 段目: 足（4・6・11・13 列目）
//
// 1 ドットは端末の文字の 1/4 と同じく縦長（横 PX × 縦 PY）。
const W = 48;
const H = 30;
const PX = W / 18;
const PY = H / 5;
const BODY_L = 3 * PX; // 胴体（3〜14 列目・0〜3 段目）
const BODY_R = 15 * PX;
const BODY_B = 4 * PY; // 胴体の下端（ここから足）
const ARM_COLS = [1, 15]; // 腕の左端の列（幅 2 ドット、2 段目）
const EYE_COLS = [5, 12]; // 目の列（1 段目）
const LEG_COLS = [4, 6, 11, 13]; // 足の列（4 段目）。4・11 と 6・13 が組で交互に上がる
// canvas は汗・振り上げた腕・足元の影のぶん余白を取る（CSS px）
const PAD_X = 18;
const PAD_T = 15;
const PAD_B = 7;
const CW = W + PAD_X * 2;
const CH = H + PAD_T + PAD_B;
const COLORS = {
	body: "#d77757", // Claude のオレンジ
	bodyHi: "#e6906f", // 上からの光
	bodyLo: "#bf613f", // 下側の陰
	legHi: "#c9694a",
	legLo: "#a9523a",
	drop: "rgba(70, 32, 20, 0.28)", // 体の下に落ちるやわらかい影
	eye: "#141413",
	cheek: (a: number) => `rgba(255, 96, 88, ${a})`,
};
const TAU = Math.PI * 2;
const SWEAT_MS = 520;
const SPEED = 16; // px / 秒
const FONT_DEFAULT = 12; // 吹き出しの文字（px）。⌘- / ⌘⇧- / ⌘= / ⌘0 で変える
const FONT_MIN = 9;
const FONT_MAX = 22;
// 檻（ターミナルの右上）
const CAGE_W = 96;
const CAGE_H = 46;
const CAGE_MARGIN = 14;

/**
 * 表示用: 「。」のあとで改行する（.cb-msg は white-space: pre-wrap）。
 * 直後の閉じ括弧は「。」側に付けたまま、その後ろで改行する。すでに改行がある・文末・続けて「。」のときは何もしない。
 * 「。」のあとの空白は改行に置き換える。保存データ・送信テキストは変えない（描画時だけ）。
 */
export function breakAtPeriod(s: string): string {
	return s.replace(/(。[」』）)】〕〉》”’"']*)[ \t　]*(?=[^\s。])/g, "$1\n");
}

/** やわらかい楕円の影（中心 (x, y)、横半径 rx、縦はつぶす） */
function softShadow(c: CanvasRenderingContext2D, x: number, y: number, rx: number, squash: number, rgb: string, a: number) {
	c.save();
	c.translate(x, y);
	c.scale(1, squash);
	const g = c.createRadialGradient(0, 0, 0, 0, 0, rx);
	g.addColorStop(0, `rgba(${rgb}, ${a})`);
	g.addColorStop(0.5, `rgba(${rgb}, ${a * 0.65})`);
	g.addColorStop(1, `rgba(${rgb}, 0)`);
	c.fillStyle = g;
	c.fillRect(-rx, -rx, rx * 2, rx * 2);
	c.restore();
}

type Mode = "walk" | "rest" | "drag" | "talk";
type Drop = { x: number; y: number; vx: number; vy: number; born: number };

export class Clawd {
	private layer: HTMLDivElement;
	private cage: HTMLDivElement;
	private sprite: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private bubble: HTMLDivElement;
	private logEl: HTMLDivElement;
	private input: HTMLTextAreaElement;
	private statusEl: HTMLSpanElement;
	private x = 0;
	private y = 0;
	private face: 1 | -1 = 1;
	private mode: Mode = "rest";
	private target = { x: 0, y: 0 };
	private restUntil = 0;
	private blinkUntil = 0;
	private nextBlink = 0;
	private bob = 0;
	private lastT = 0;
	private dpr = 0;
	// なめらかな動き（位相と、0〜1 にゆっくり寄せる強さ）
	private walkPhase = 0;
	private walkAmp = 0;
	private dragAmp = 0;
	private look = 1; // 目の向き（-1.2〜1.2）
	private landAt = -1e9; // 落とされた時刻（着地のぷにっ）
	private state: BuddyState = "starting";
	private lines: BuddyLine[] = [];
	private pending = "";
	private drag: { dx: number; dy: number; sx: number; sy: number; moved: boolean } | null = null;
	// バタバタと汗
	private flailPhase = 0;
	private k = 0; // 檻への近さ（0〜1）。バタバタの激しさ
	private sweatAt = 0;
	private drops: Drop[] = [];
	// 檻
	private caged = false;
	private cageRect = { x: 0, y: 0, w: CAGE_W, h: CAGE_H };
	private font = FONT_DEFAULT;

	constructor(
		private send: (text: string) => void,
		private store: { load(k: string): string | null; save(k: string, v: string): void },
	) {
		this.layer = document.createElement("div");
		this.layer.className = "clawd-layer";
		this.cage = document.createElement("div");
		this.cage.className = "clawd-cage";
		this.cage.innerHTML = `<span class="cage-top"></span><span class="cage-bars"></span><span class="cage-floor"></span>`;
		this.cage.title = "Clawd くんの檻（中に落とすと出られない）";
		this.sprite = document.createElement("canvas");
		this.sprite.className = "clawd";
		this.sprite.style.width = `${CW}px`;
		this.sprite.style.height = `${CH}px`;
		// ドット絵用の指定（CSS の pixelated・固い影）を打ち消す。影は canvas に描く
		this.sprite.style.imageRendering = "auto";
		this.sprite.style.filter = "none";
		this.sprite.title = "Clawd くん（クリックで話す・ドラッグで動かす・Ctrl 2 回で呼ぶ）";
		this.ctx = this.sprite.getContext("2d")!;
		this.bubble = document.createElement("div");
		this.bubble.className = "clawd-bubble";
		this.bubble.hidden = true;
		this.bubble.innerHTML = `<div class="cb-head"><span class="cb-name">Clawd くん</span><span class="cb-st"></span><button type="button" class="cb-x" title="閉じる（Esc）">×</button></div><div class="cb-log"></div><textarea class="cb-input" rows="2" placeholder="なんでも話してなー"></textarea><div class="cb-hint">Enter で送る・Shift+Enter で改行・Esc で閉じる</div>`;
		this.logEl = this.bubble.querySelector(".cb-log")!;
		this.input = this.bubble.querySelector(".cb-input")!;
		this.statusEl = this.bubble.querySelector(".cb-st")!;
		this.layer.append(this.sprite, this.cage, this.bubble); // 檻の格子は Clawd くんより手前
		document.body.appendChild(this.layer);

		this.font = Number(this.store.load("clawdFont")) || FONT_DEFAULT;
		this.bubble.style.setProperty("--cb-font", `${this.font}px`);
		this.updateCage();
		this.caged = this.store.load("clawdCaged") === "1";
		const saved = this.store.load("clawdPos");
		const p = saved ? (JSON.parse(saved) as { x: number; y: number }) : { x: window.innerWidth * 0.35, y: window.innerHeight - 90 };
		this.x = p.x;
		this.y = p.y;
		this.clamp();
		this.pickTarget();
		this.restUntil = performance.now() + 2000;

		this.sprite.addEventListener("pointerdown", (e) => this.down(e));
		this.sprite.addEventListener("pointermove", (e) => this.move(e));
		this.sprite.addEventListener("pointerup", (e) => this.up(e));
		this.bubble.querySelector(".cb-x")!.addEventListener("click", () => this.close());
		// 日本語入力: WebKit は確定の Enter で isComposing=false・keyCode=229 を返し、compositionend が keydown より先に来る。
		// 変換中フラグと確定直後の猶予で、確定の Enter / Esc を送信・閉じるに使わない。
		let composing = false;
		let composedAt = 0;
		this.input.addEventListener("compositionstart", () => { composing = true; });
		this.input.addEventListener("compositionend", () => { composing = false; composedAt = performance.now(); });
		this.input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (composing || e.isComposing || e.keyCode === 229 || performance.now() - composedAt < 80) return;
			if (e.key === "Escape") {
				e.preventDefault();
				this.close();
			} else if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !e.altKey && !e.metaKey && !e.ctrlKey) {
				e.preventDefault();
				this.submit();
			}
		});
		// 吹き出しの外を押したら、打ちかけがなければ閉じる
		document.addEventListener("pointerdown", (e) => {
			if (this.bubble.hidden || this.layer.contains(e.target as Node)) return;
			if (!this.input.value.trim() && this.state !== "replying") this.close();
		});
		window.addEventListener("resize", () => {
			this.updateCage();
			this.clamp();
			this.place();
		});
		setInterval(() => this.savePos(), 15_000);
		requestAnimationFrame((t) => this.frame(t));
	}

	// ───────── 外から ─────────

	setState(s: BuddyState) {
		this.state = s;
		this.renderStatus();
		if (s !== "replying") this.bob = 0;
	}

	setHistory(lines: BuddyLine[]) {
		this.lines = [...lines];
		this.renderLog();
	}

	delta(text: string) {
		this.pending = text;
		this.renderLog();
	}

	reply(text: string) {
		this.pending = "";
		this.lines.push({ role: "clawd", text });
		this.renderLog();
	}

	/** Ctrl の 2 連打・クリック：吹き出しを開いて入力欄へ */
	open() {
		this.mode = "talk";
		this.bubble.hidden = false;
		this.renderLog();
		this.renderStatus();
		this.place();
		this.input.focus();
	}

	close() {
		this.bubble.hidden = true;
		this.input.blur();
		this.mode = "rest";
		this.restUntil = performance.now() + 1500;
	}

	/** 吹き出しの文字の大きさ（1 段 = 1px） */
	setFont(step: 1 | -1 | "reset") {
		this.font = step === "reset" ? FONT_DEFAULT : Math.min(Math.max(this.font + step, FONT_MIN), FONT_MAX);
		this.bubble.style.setProperty("--cb-font", `${this.font}px`);
		this.store.save("clawdFont", String(this.font));
		this.statusEl.textContent = `文字 ${this.font}px`;
		setTimeout(() => this.renderStatus(), 1200);
		this.place();
	}

	/** 吹き出しの中（入力欄など）にフォーカスがある */
	get hasFocus() {
		return !this.bubble.hidden && this.bubble.contains(document.activeElement);
	}

	get isOpen() {
		return !this.bubble.hidden;
	}

	/** ファイルのドロップ先（本体と吹き出し。drop.ts が使う） */
	get dropZones(): HTMLElement[] {
		return [this.sprite, this.bubble];
	}

	/** 吹き出しを開き、入力欄のカーソル位置に差し込む（送信しない）。前後の文とは改行で分ける */
	insert(text: string) {
		if (this.bubble.hidden) this.open();
		const ta = this.input;
		const s = ta.selectionStart ?? ta.value.length;
		const e = ta.selectionEnd ?? s;
		const before = ta.value.slice(0, s);
		const after = ta.value.slice(e);
		const head = before && !before.endsWith("\n") ? "\n" : "";
		const tail = after && !after.startsWith("\n") ? "\n" : "";
		ta.value = before + head + text + tail + after;
		const pos = (before + head + text).length;
		ta.focus();
		ta.setSelectionRange(pos, pos);
	}

	// ───────── 会話 ─────────

	private submit() {
		const text = this.input.value.trim();
		if (!text) return;
		this.input.value = "";
		this.lines.push({ role: "user", text });
		this.pending = "";
		this.renderLog();
		this.send(text);
	}

	private renderLog() {
		if (this.bubble.hidden) return;
		const shown = this.lines.slice(-6);
		const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
		this.logEl.innerHTML =
			(shown.length || this.pending ? "" : `<p class="cb-msg bot">んむむ、なんか話すかなー？</p>`) +
			shown.map((l) => `<p class="cb-msg ${l.role === "clawd" ? "bot" : l.role}">${esc(l.role === "clawd" ? breakAtPeriod(l.text) : l.text)}</p>`).join("") +
			(this.pending ? `<p class="cb-msg bot pending">${esc(breakAtPeriod(this.pending))}</p>` : this.state === "replying" ? `<p class="cb-msg bot pending">んむむ…</p>` : "");
		this.logEl.scrollTop = this.logEl.scrollHeight;
		this.place();
	}

	private renderStatus() {
		this.statusEl.textContent = { starting: "起きてるとこ", idle: this.caged ? "檻の中" : "", replying: "考え中", stopped: "寝てる（立ち上げ直し中）" }[this.state];
	}

	// ───────── 檻 ─────────

	/**
	 * 檻はターミナルのタブの帯、ターミナルの位置を切り替える丸いボタン（↓ / →）の背後に置く（ボタンは檻と Clawd くんより手前に出る）。
	 * 分割や配置が変わっても付いていく。
	 */
	private updateCage() {
		const btn = document.getElementById("layout-toggle")?.getBoundingClientRect();
		const head = document.querySelector(".dock-head")?.getBoundingClientRect();
		let next: { x: number; y: number; w: number; h: number };
		if (btn && head && btn.width > 0 && head.height > 0) {
			const w = Math.max(CAGE_W, Math.round(btn.width + 48));
			const h = CAGE_H;
			const x = Math.min(Math.round(btn.left + btn.width / 2 - w / 2), Math.round(head.right - w - 2));
			const y = Math.max(Math.round(head.top + 2), Math.round(btn.top + btn.height / 2 - h / 2));
			next = { x, y, w, h };
		} else {
			next = { x: window.innerWidth - CAGE_W - CAGE_MARGIN, y: 8, w: CAGE_W, h: CAGE_H };
		}
		const c = this.cageRect;
		if (next.x === c.x && next.y === c.y && next.w === c.w && next.h === c.h) return;
		// 檻が動いたら、中の Clawd くんも一緒に動かす
		if (this.caged) {
			this.x += next.x - c.x;
			this.y += next.y - c.y;
			this.target.x += next.x - c.x;
			this.target.y += next.y - c.y;
		}
		this.cageRect = next;
		this.cage.style.transform = `translate(${next.x}px, ${next.y}px)`;
		this.cage.style.width = `${next.w}px`;
		this.cage.style.height = `${next.h}px`;
		if (this.caged && this.mode !== "drag") this.clamp();
	}

	/** 檻の中で Clawd くんが動ける範囲（左上の座標） */
	private cageInner() {
		const c = this.cageRect;
		return { x0: c.x + 6, y0: c.y + 8, x1: c.x + c.w - W - 6, y1: Math.max(c.y + 8, c.y + c.h - H - 6) };
	}

	/** 胴体の中心と檻の中心の距離 */
	private cageDistance() {
		const c = this.cageRect;
		return Math.hypot(this.x + W / 2 - (c.x + c.w / 2), this.y + H / 2 - (c.y + c.h / 2));
	}

	private overCage() {
		const c = this.cageRect;
		const cx = this.x + W / 2;
		const cy = this.y + H / 2;
		return cx >= c.x && cx <= c.x + c.w && cy >= c.y && cy <= c.y + c.h;
	}

	// ───────── 動き ─────────

	private frame(t: number) {
		const dt = Math.min(0.1, (t - (this.lastT || t)) / 1000);
		this.lastT = t;
		this.updateCage();
		if (this.mode === "rest" && t >= this.restUntil) {
			this.pickTarget();
			this.mode = "walk";
		}
		let walking = false;
		if (this.mode === "walk") {
			const dx = this.target.x - this.x;
			const dy = this.target.y - this.y;
			const d = Math.hypot(dx, dy);
			if (d < 2) {
				this.mode = "rest";
				this.restUntil = t + 2000 + Math.random() * 5000;
				// たまに向きを変える
				if (Math.random() < 0.35) this.face = this.face === 1 ? -1 : 1;
			} else {
				const step = Math.min(d, SPEED * dt);
				this.x += (dx / d) * step;
				this.y += (dy / d) * step;
				if (Math.abs(dx) > 1) this.face = dx > 0 ? 1 : -1;
				walking = true;
			}
		}
		const ease = (v: number, to: number, rate: number) => v + (to - v) * Math.min(1, dt * rate);
		if (this.mode === "drag") {
			// 檻に近いほど激しく（0〜1）
			const k = Math.max(0, Math.min(1, 1 - this.cageDistance() / 520));
			this.k = k;
			const flailMs = 170 - 120 * k; // 腕の振り上げ・振り下ろし 1 回の時間
			const sweatMs = 620 - 500 * k;
			this.flailPhase = (this.flailPhase + (dt * Math.PI * 1000) / flailMs) % TAU;
			if (t - this.sweatAt > sweatMs) {
				this.sweatAt = t;
				this.spawnSweat(t, k);
			}
		} else this.k = ease(this.k, 0, 6);
		// 歩幅 1 回 ≒ 0.45 秒（左右の足で 2 歩）
		if (walking || this.walkAmp > 0.01) this.walkPhase = (this.walkPhase + dt * TAU * 2.2) % TAU;
		this.walkAmp = ease(this.walkAmp, walking ? 1 : 0, 7);
		this.dragAmp = ease(this.dragAmp, this.mode === "drag" ? 1 : 0, 14);
		this.look = ease(this.look, this.mode === "talk" ? 0 : this.face * 1.2, 6);
		this.drops = this.drops.filter((d) => t - d.born < SWEAT_MS);
		for (const d of this.drops) {
			d.x += d.vx * dt;
			d.y += d.vy * dt;
			d.vy += 90 * dt; // px / 秒²
		}
		if (t >= this.nextBlink) {
			this.blinkUntil = t + 160;
			// たまに 2 回続けてまばたき
			this.nextBlink = Math.random() < 0.2 ? t + 320 : t + 2500 + Math.random() * 4000;
		}
		this.bob = this.state === "replying" ? (1 - Math.cos((t / 360) * TAU)) * 0.6 : ease(this.bob, 0, 10);
		this.draw(t);
		const shake = Math.sin(this.flailPhase * 2) * this.dragAmp * (0.4 + 0.8 * this.k);
		const snap = (v: number) => Math.round(v * this.dpr) / this.dpr;
		this.sprite.style.transform = `translate(${snap(this.x - PAD_X + shake)}px, ${snap(this.y - PAD_T - this.bob)}px)`;
		if (!this.bubble.hidden && (this.mode === "drag" || this.mode === "walk")) this.place();
		requestAnimationFrame((n) => this.frame(n));
	}

	/** 汗を 1〜2 粒、頭の左右から外へ飛ばす（CSS px。当たり判定の箱の左上が原点） */
	private spawnSweat(t: number, k: number) {
		const n = k > 0.6 ? 2 : 1;
		for (let i = 0; i < n; i++) {
			const left = Math.random() < 0.5;
			// 頭の左上・右上の角から
			const x = left ? BODY_L : BODY_R;
			const y = 0;
			this.drops.push({
				x,
				y,
				vx: (left ? -1 : 1) * (18 + Math.random() * 18 + 18 * k),
				vy: -(24 + Math.random() * 18),
				born: t,
			});
		}
	}

	private pickTarget() {
		if (this.caged) {
			const c = this.cageInner();
			this.target = { x: c.x0 + Math.random() * Math.max(0, c.x1 - c.x0), y: c.y0 + Math.random() * Math.max(0, c.y1 - c.y0) };
			return;
		}
		const maxX = window.innerWidth - W - 8;
		const maxY = window.innerHeight - H - 8;
		// 遠くへ行きすぎない（近くをうろうろする）。檻の中には自分から入らない
		const r = 220;
		for (let i = 0; i < 8; i++) {
			const x = Math.min(Math.max(8, this.x + (Math.random() * 2 - 1) * r), maxX);
			const y = Math.min(Math.max(48, this.y + (Math.random() * 2 - 1) * r * 0.5), maxY);
			const c = this.cageRect;
			const inCage = x + W > c.x - 8 && x < c.x + c.w + 8 && y + H > c.y - 8 && y < c.y + c.h + 8;
			this.target = { x, y };
			if (!inCage) return;
		}
		this.target = { x: this.x, y: this.y };
	}

	private clamp() {
		if (this.caged && this.mode !== "drag") {
			const c = this.cageInner();
			this.x = Math.min(Math.max(c.x0, this.x), c.x1);
			this.y = Math.min(Math.max(c.y0, this.y), c.y1);
			return;
		}
		this.x = Math.min(Math.max(4, this.x), window.innerWidth - W - 4);
		this.y = Math.min(Math.max(4, this.y), window.innerHeight - H - 4);
	}

	private savePos() {
		this.store.save("clawdPos", JSON.stringify({ x: Math.round(this.x), y: Math.round(this.y) }));
		this.store.save("clawdCaged", this.caged ? "1" : "0");
	}

	/** devicePixelRatio に合わせて canvas の実ピクセルを取り直す（くっきり描く） */
	private fitCanvas() {
		const dpr = window.devicePixelRatio || 1;
		if (dpr === this.dpr) return;
		this.dpr = dpr;
		this.sprite.width = Math.round(CW * dpr);
		this.sprite.height = Math.round(CH * dpr);
	}

	/**
	 * 毎フレーム描く。座標は CSS px、原点は当たり判定の箱の左上。ドット絵なので塗りは平坦（陰影なし）。
	 * 奥から: 足元の影 → 足 → 胴体・腕・目（伸び縮みする） → 汗。
	 * 歩くと足が 2 本ずつ交互に上がって弾み、掴まれると伸びて腕と足をバタバタさせ、目が「><」になる。
	 */
	private draw(t: number) {
		this.fitCanvas();
		const c = this.ctx;
		const dpr = this.dpr;
		c.setTransform(1, 0, 0, 1, 0, 0);
		c.clearRect(0, 0, this.sprite.width, this.sprite.height);
		c.setTransform(dpr, 0, 0, dpr, PAD_X * dpr, PAD_T * dpr);

		const wa = this.walkAmp;
		const da = this.dragAmp;
		const k = this.k;
		const wp = this.walkPhase;
		const fp = this.flailPhase;
		const cx = W / 2;

		// ── 体の動き ──
		// 歩き: 1 歩ごとに弾む。弾んだ瞬間は縦に伸び、着いた瞬間はつぶれる
		const bounce = Math.abs(Math.sin(wp)) * wa;
		const lift = bounce * PY * 0.3 * (1 - da);
		let sy = 1 + (bounce - 0.5 * wa) * 0.06;
		// 立ち止まっているときは小さく呼吸
		sy *= 1 + Math.sin((t / 1000) * TAU * 0.4) * 0.015 * (1 - wa) * (1 - da);
		// 落とされた直後はぺたっとつぶれて戻る
		const la = t - this.landAt;
		if (la < 500) sy *= 1 - 0.16 * Math.exp(-la / 110) * Math.cos(la / 55);
		// 掴まれている間は上に引っぱられて少し伸び、もがきに合わせて伸び縮み
		sy = sy * (1 - da) + (1.06 + Math.sin(fp * 2) * 0.03 * (0.5 + k)) * da;
		const sx = 1 + (1 / sy - 1) * 0.8;
		const tilt = Math.sin(fp) * (0.05 + 0.05 * k) * da;
		const bottom = BODY_B - lift;

		// 足元の影（掴まれている間は離れて小さく薄く）
		softShadow(c, cx, H - 0.3 + da * 4, (20 - lift * 2) * (1 - da * 0.4), 0.14, "48, 30, 24", 0.28 * (1 - da * 0.6));

		this.drawLegs(sx, bottom);

		// ── ここから胴体の座標（下端中央を軸に傾け・伸び縮み） ──
		c.save();
		c.translate(cx, bottom);
		c.rotate(tilt);
		c.scale(sx, sy);
		c.translate(-cx, -BODY_B);
		this.drawBody();
		this.drawFace(t);
		c.restore();

		this.drawSweat(t);
	}

	/** 足（1 ドット幅の棒）。4・11 列目と 6・13 列目が交互に上がる。掴まれている間はぶらぶら・バタバタ */
	private drawLegs(sx: number, bottom: number) {
		const c = this.ctx;
		const wa = this.walkAmp;
		const da = this.dragAmp;
		const k = this.k;
		const g = c.createLinearGradient(0, bottom, 0, H);
		g.addColorStop(0, COLORS.legHi);
		g.addColorStop(1, COLORS.legLo);
		c.fillStyle = g;
		c.beginPath();
		LEG_COLS.forEach((col, i) => {
			const pair = i % 2;
			const up = Math.max(0, Math.sin(this.walkPhase + pair * Math.PI)) * wa * (1 - da);
			const dangle = Math.sin(this.flailPhase * 1.3 + i * 1.7) * PX * (0.4 + 0.5 * k) * da;
			const x = W / 2 + (col * PX - W / 2) * sx + dangle;
			// 地面に着いている足は下端が地面、上がった足は短くなる。ぶら下がると胴体の下に垂れる
			const groundLen = H - bottom - up * PY * 0.5;
			const hangLen = PY * (0.9 + Math.sin(this.flailPhase * 2 + i) * 0.15 * (0.5 + k));
			const len = groundLen * (1 - da) + hangLen * da;
			c.roundRect(x, bottom - 1.5, PX * sx, len + 1.5, [0, 0, 0.9, 0.9]);
		});
		c.fill();
	}

	/**
	 * 胴体（3〜14 列目の箱）と腕（2 段目の左右 2 ドット）。角を少し丸め、1 本のパスにまとめて塗って継ぎ目を出さない。
	 * 上から光が当たる縦のグラデーションに、下へやわらかい影を落とし、上の縁にうっすら照りを足す。
	 */
	private drawBody() {
		const c = this.ctx;
		const wa = this.walkAmp;
		const da = this.dragAmp;
		c.beginPath();
		c.roundRect(BODY_L, 0, BODY_R - BODY_L, BODY_B, 2.2);
		ARM_COLS.forEach((col, i) => {
			const side = i === 0 ? -1 : 1;
			// 歩くと交互に小さく上下、掴まれると交互に振り上げる（上は 1 段目まで）
			const walk = Math.sin(this.walkPhase + i * Math.PI) * PY * 0.15 * wa;
			const flail = (0.5 + 0.5 * Math.sin(this.flailPhase + i * Math.PI)) * PY * (0.6 + 0.4 * this.k);
			const dy = walk * (1 - da) - flail * da;
			// 胴体に食い込ませて、離れて見えないようにする
			const x = col * PX + (side < 0 ? 0 : -0.4);
			c.roundRect(x, 2 * PY + dy, PX * 2 + 0.4, PY, side < 0 ? [1.4, 0, 0, 1.4] : [0, 1.4, 1.4, 0]);
		});
		const g = c.createLinearGradient(0, 0, 0, BODY_B);
		g.addColorStop(0, COLORS.bodyHi);
		g.addColorStop(0.45, COLORS.body);
		g.addColorStop(1, COLORS.bodyLo);
		c.fillStyle = g;
		c.save();
		c.shadowColor = COLORS.drop;
		c.shadowBlur = 3 * this.dpr;
		c.shadowOffsetY = 1.2 * this.dpr;
		c.fill();
		c.restore();
		// 上の縁の照り
		c.save();
		c.clip();
		const hi = c.createLinearGradient(0, 0, 0, PY * 0.7);
		hi.addColorStop(0, "rgba(255, 240, 228, 0.35)");
		hi.addColorStop(1, "rgba(255, 240, 228, 0)");
		c.fillStyle = hi;
		c.fillRect(BODY_L, 0, BODY_R - BODY_L, PY * 0.7);
		c.restore();
	}

	/** 目（1 段目の 5・12 列目の黒いドット）。ふだんはまばたきと目線、掴まれると「><」と赤いほっぺ */
	private drawFace(t: number) {
		const c = this.ctx;
		const da = this.dragAmp;
		const k = this.k;
		if (da > 0.02) {
			c.fillStyle = COLORS.cheek(0.45 * da * (0.4 + 0.6 * k));
			for (const col of EYE_COLS) c.fillRect((col - 0.6) * PX, 2 * PY + PY * 0.15, PX * 2.2, PY * 0.4);
		}
		c.fillStyle = COLORS.eye;
		c.strokeStyle = COLORS.eye;
		if (this.mode === "drag") {
			// 「>」と「<」。檻に近いほど太く
			c.lineWidth = PX * (0.45 + 0.15 * k);
			c.lineCap = "square";
			c.lineJoin = "miter";
			const w = PX * 0.6;
			const h = PY * 0.38;
			const y = 1.5 * PY;
			const [l, r] = EYE_COLS.map((col) => (col + 0.5) * PX);
			c.beginPath();
			c.moveTo(l! - w, y - h);
			c.lineTo(l! + w, y);
			c.lineTo(l! - w, y + h);
			c.moveTo(r! + w, y - h);
			c.lineTo(r! - w, y);
			c.lineTo(r! + w, y + h);
			c.stroke();
			return;
		}
		// まばたきは上から閉じて、閉じきったら細い線
		const bt = this.blinkUntil - t;
		const closed = bt > 0 ? Math.sin((1 - bt / 160) * Math.PI) : 0;
		const eh = PY * (1 - closed * 0.82);
		const dx = this.look * PX * 0.3;
		c.beginPath();
		for (const col of EYE_COLS) c.roundRect(col * PX + dx, 2 * PY - eh, PX, eh, Math.min(0.9, eh / 2));
		c.fill();
	}

	/** 汗（ピッピ）: 飛ぶ向きの反対にとがる水滴。重力で落ちながら消える */
	private drawSweat(t: number) {
		const c = this.ctx;
		const r = 1.5 + 0.5 * this.k;
		for (const d of this.drops) {
			const age = (t - d.born) / SWEAT_MS;
			c.save();
			c.globalAlpha = Math.max(0, 1 - age * age);
			c.translate(d.x, d.y);
			c.rotate(Math.atan2(-d.vx, d.vy));
			c.beginPath();
			c.moveTo(0, -r * 2.3);
			c.bezierCurveTo(r * 0.5, -r * 1.3, r, -r * 0.6, r, 0);
			c.arc(0, 0, r, 0, Math.PI);
			c.bezierCurveTo(-r, -r * 0.6, -r * 0.5, -r * 1.3, 0, -r * 2.3);
			c.closePath();
			const g = c.createLinearGradient(0, -r * 2.3, 0, r);
			g.addColorStop(0, "#d4efff");
			g.addColorStop(1, "#5aaee8");
			c.fillStyle = g;
			c.fill();
			c.strokeStyle = "rgba(48, 118, 170, 0.4)";
			c.lineWidth = 0.5;
			c.stroke();
			c.fillStyle = "rgba(255, 255, 255, 0.9)";
			c.beginPath();
			c.arc(-r * 0.35, -r * 0.2, r * 0.3, 0, TAU);
			c.fill();
			c.restore();
		}
	}

	// ───────── ドラッグ・クリック ─────────

	private down(e: PointerEvent) {
		if (e.button !== 0) return;
		e.preventDefault();
		this.sprite.setPointerCapture(e.pointerId);
		this.drag = { dx: e.clientX - this.x, dy: e.clientY - this.y, sx: e.clientX, sy: e.clientY, moved: false };
	}

	private move(e: PointerEvent) {
		const d = this.drag;
		if (!d) return;
		if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 4) {
			if (!d.moved) this.sweatAt = 0;
			d.moved = true;
			this.mode = "drag";
		}
		if (!d.moved) return;
		this.x = e.clientX - d.dx;
		this.y = e.clientY - d.dy;
		this.clamp();
	}

	private up(e: PointerEvent) {
		const d = this.drag;
		this.drag = null;
		if (this.sprite.hasPointerCapture(e.pointerId)) this.sprite.releasePointerCapture(e.pointerId);
		if (!d) return;
		if (d.moved) {
			// 檻の上で離したら閉じ込める。外で離したら出られる
			this.caged = this.overCage();
			this.landAt = performance.now();
			this.mode = this.bubble.hidden ? "rest" : "talk";
			this.clamp();
			this.renderStatus();
			this.savePos();
			this.restUntil = performance.now() + 2500;
			return;
		}
		if (this.bubble.hidden) this.open();
		else this.close();
	}

	/**
	 * 吹き出しを Clawd くんの上か下に置く。大きくて入らなければ左右（広い側）に置く。画面からははみ出さない。
	 */
	private place() {
		if (this.bubble.hidden) return;
		const bw = this.bubble.offsetWidth;
		const bh = this.bubble.offsetHeight;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const cx = this.x + W / 2;
		const cy = this.y + H / 2;
		const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(lo, v), Math.max(lo, hi));
		let left: number;
		let top: number;
		let side: "" | "below" | "side-r" | "side-l" = "";
		if (this.y - bh - 12 >= 8) {
			top = this.y - bh - 12;
			left = clamp(cx - bw / 2, 8, vw - bw - 8);
		} else if (this.y + H + 12 + bh <= vh - 8) {
			side = "below";
			top = this.y + H + 12;
			left = clamp(cx - bw / 2, 8, vw - bw - 8);
		} else {
			side = vw - (this.x + W) >= this.x ? "side-r" : "side-l";
			left = side === "side-r" ? this.x + W + 12 : this.x - bw - 12;
			left = clamp(left, 8, vw - bw - 8);
			top = clamp(cy - bh / 2, 8, vh - bh - 8);
		}
		this.bubble.style.left = `${Math.round(left)}px`;
		this.bubble.style.top = `${Math.round(top)}px`;
		this.bubble.classList.toggle("below", side === "below");
		this.bubble.classList.toggle("side-r", side === "side-r");
		this.bubble.classList.toggle("side-l", side === "side-l");
		this.bubble.style.setProperty("--tail", `${Math.round(clamp(cx - left, 16, bw - 16))}px`);
		this.bubble.style.setProperty("--tail-y", `${Math.round(clamp(cy - top, 16, bh - 16))}px`);
	}
}
