// アイデアのグラフ（Obsidian のグラフビューのような力学配置）。外部ライブラリなしで canvas に描く。
// - 反発（全ペア）・ばね（エッジ）・中心への引力で配置し、落ち着いたら止まる（数百ノードまで）。
// - ノードのドラッグで移動、ホイールで拡大縮小、背景のドラッグでパン、ホバーで隣接だけ強調、クリックで開く。
// - データが変わっても、同じ id のノードは位置を保つ。

type GraphNodeKind = "idea" | "task" | "goal" | "project";

export type GraphNode = {
	id: string;
	kind: GraphNodeKind;
	label: string;
	/** アイデアの status（新規 / 温め中 / タスク化 / 見送り）・タスクの status */
	status?: string;
	/** クリックで開くノート（Manager/ からの相対パス）。なければ開かない */
	path?: string;
};

export type GraphEdge = { a: string; b: string };

type Sim = GraphNode & { x: number; y: number; vx: number; vy: number; fixed: boolean; deg: number };

const REPULSE = 2600;
const SPRING = 0.035;
const SPRING_LEN = 70;
const GRAVITY = 0.012;
const DAMPING = 0.82;
const MAX_V = 24;

export class IdeaGraph {
	readonly el: HTMLDivElement;
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private nodes: Sim[] = [];
	private byId = new Map<string, Sim>();
	private edges: [Sim, Sim][] = [];
	private adj = new Map<string, Set<string>>();
	private signature = "";
	private alpha = 0;
	private raf = 0;
	private view = { x: 0, y: 0, k: 1 };
	private hover: Sim | null = null;
	private drag: { node: Sim | null; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null = null;
	private colors: Record<string, string> = {};
	private emptyText = "";

	/** onDragEnd: ドラッグ中に止めていた描き直しを再開する合図 */
	constructor(
		private onOpen: (node: GraphNode) => void,
		private onDragEnd: () => void = () => {},
	) {
		this.el = document.createElement("div");
		this.el.className = "igraph";
		this.canvas = document.createElement("canvas");
		this.el.appendChild(this.canvas);
		this.ctx = this.canvas.getContext("2d")!;
		new ResizeObserver(() => this.resize()).observe(this.el);
		this.canvas.addEventListener("pointerdown", (e) => this.down(e));
		this.canvas.addEventListener("pointermove", (e) => this.move(e));
		this.canvas.addEventListener("pointerup", (e) => this.up(e));
		this.canvas.addEventListener("pointerleave", () => {
			if (!this.drag && this.hover) {
				this.hover = null;
				this.draw();
			}
		});
		this.canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
		this.canvas.addEventListener("dblclick", () => this.fit());
	}

	/** データを入れ替える。同じなら何もしない（揺らさない） */
	setData(nodes: GraphNode[], edges: GraphEdge[], emptyText = "") {
		this.emptyText = emptyText;
		const sig = JSON.stringify([nodes.map((n) => [n.id, n.label, n.status, n.path]), edges.map((e) => e.a + ">" + e.b)]);
		if (sig === this.signature) return;
		const first = this.signature === "";
		this.signature = sig;
		const old = this.byId;
		this.byId = new Map();
		this.adj = new Map();
		for (const e of edges) {
			(this.adj.get(e.a) ?? this.adj.set(e.a, new Set()).get(e.a)!).add(e.b);
			(this.adj.get(e.b) ?? this.adj.set(e.b, new Set()).get(e.b)!).add(e.a);
		}
		this.nodes = nodes.map((n) => {
			const prev = old.get(n.id);
			const s: Sim = prev
				? { ...n, x: prev.x, y: prev.y, vx: 0, vy: 0, fixed: false, deg: 0 }
				: { ...n, ...this.spawnNear(n.id, old), vx: 0, vy: 0, fixed: false, deg: 0 };
			this.byId.set(n.id, s);
			return s;
		});
		this.edges = edges
			.map((e) => [this.byId.get(e.a), this.byId.get(e.b)] as const)
			.filter((p): p is [Sim, Sim] => !!p[0] && !!p[1] && p[0] !== p[1]);
		for (const [a, b] of this.edges) {
			a.deg++;
			b.deg++;
		}
		if (this.hover && !this.byId.has(this.hover.id)) this.hover = null;
		this.heat(first ? 1 : 0.5);
		if (first) {
			// 最初は先に落ち着かせてから見せる
			for (let i = 0; i < 200; i++) this.step();
			this.alpha = 0.3;
			this.fit();
		}
	}

	/** ノードか背景をドラッグしている最中（盤面の描き直しで DOM を動かすと掴みが外れる） */
	get dragging(): boolean {
		return this.drag !== null;
	}

	/** 見えている場所に置かれたとき（タブの切り替え・盤面の描き直し）に呼ぶ */
	refresh() {
		this.readColors();
		this.resize();
	}

	// ───────── 配置 ─────────

	/** 新しいノードは、既にある隣のそばに置く（なければ中心の近く） */
	private spawnNear(id: string, old: Map<string, Sim>): { x: number; y: number } {
		const near = [...(this.adj.get(id) ?? [])].map((x) => old.get(x)).find(Boolean);
		const r = () => (Math.random() - 0.5) * 60;
		// 初回はまとめて散らす（中心に固まると反発で弾ける）
		const spread = Math.sqrt(this.adj.size + 1) * 0.6;
		return near ? { x: near.x + r(), y: near.y + r() } : { x: r() * spread, y: r() * spread };
	}

	private heat(a: number) {
		this.alpha = Math.max(this.alpha, a);
		if (!this.raf) this.raf = requestAnimationFrame(() => this.frame());
	}

	private frame() {
		this.raf = 0;
		this.step();
		this.draw();
		this.alpha *= 0.985;
		if (this.alpha > 0.01 || this.drag?.node) this.raf = requestAnimationFrame(() => this.frame());
	}

	private step() {
		const ns = this.nodes;
		const a = this.alpha;
		for (let i = 0; i < ns.length; i++) {
			const p = ns[i]!;
			for (let j = i + 1; j < ns.length; j++) {
				const q = ns[j]!;
				let dx = p.x - q.x;
				let dy = p.y - q.y;
				let d2 = dx * dx + dy * dy;
				if (d2 < 0.01) {
					dx = Math.random() - 0.5;
					dy = Math.random() - 0.5;
					d2 = 0.25;
				}
				if (d2 > 250_000) continue; // 遠いものは無視（500px）
				d2 = Math.max(d2, 100); // 近すぎるときに弾け飛ばない
				const f = (REPULSE * a) / d2;
				const d = Math.sqrt(d2);
				p.vx += (dx / d) * f;
				p.vy += (dy / d) * f;
				q.vx -= (dx / d) * f;
				q.vy -= (dy / d) * f;
			}
		}
		for (const [p, q] of this.edges) {
			const dx = q.x - p.x;
			const dy = q.y - p.y;
			const d = Math.sqrt(dx * dx + dy * dy) || 1;
			const len = SPRING_LEN + 6 * Math.sqrt(Math.max(p.deg, q.deg));
			const f = (d - len) * SPRING * a;
			p.vx += (dx / d) * f;
			p.vy += (dy / d) * f;
			q.vx -= (dx / d) * f;
			q.vy -= (dy / d) * f;
		}
		for (const p of ns) {
			p.vx -= p.x * GRAVITY * a;
			p.vy -= p.y * GRAVITY * a;
			if (p.fixed) {
				p.vx = p.vy = 0;
				continue;
			}
			p.vx *= DAMPING;
			p.vy *= DAMPING;
			const v = Math.hypot(p.vx, p.vy);
			if (v > MAX_V) {
				p.vx *= MAX_V / v;
				p.vy *= MAX_V / v;
			}
			p.x += p.vx;
			p.y += p.vy;
		}
	}

	/** 全体が収まるように寄せる（ダブルクリックでも） */
	private fit() {
		const w = this.canvas.clientWidth || 600;
		const h = this.canvas.clientHeight || 360;
		if (!this.nodes.length) {
			this.view = { x: w / 2, y: h / 2, k: 1 };
			return this.draw();
		}
		const xs = this.nodes.map((n) => n.x);
		const ys = this.nodes.map((n) => n.y);
		const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
		const k = Math.min(2, Math.max(0.2, Math.min((w - 80) / (x1 - x0 || 1), (h - 60) / (y1 - y0 || 1))));
		this.view = { k, x: w / 2 - ((x0 + x1) / 2) * k, y: h / 2 - ((y0 + y1) / 2) * k };
		this.draw();
	}

	// ───────── 描画 ─────────

	private readColors() {
		const cs = getComputedStyle(document.documentElement);
		for (const k of ["ink", "graphite", "focus", "rule", "paper", "paper-2", "shu", "sans"]) this.colors[k] = cs.getPropertyValue(`--${k}`).trim();
	}

	private resize() {
		const dpr = window.devicePixelRatio || 1;
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (!w || !h) return;
		const first = this.canvas.width === 300 && this.canvas.height === 150;
		const cw = Math.round(w * dpr);
		const ch = Math.round(h * dpr);
		if (cw !== this.canvas.width || ch !== this.canvas.height) {
			this.canvas.width = cw;
			this.canvas.height = ch;
		}
		if (!this.colors["ink"]) this.readColors();
		if (first) this.fit();
		else this.draw();
	}

	private radius(n: Sim): number {
		if (n.kind === "project") return 9 + Math.min(8, n.deg);
		if (n.kind === "goal") return 8 + Math.min(6, n.deg);
		if (n.kind === "task") return 5 + Math.min(4, n.deg * 0.5);
		return 4.5;
	}

	private draw() {
		const c = this.ctx;
		const dpr = window.devicePixelRatio || 1;
		const w = this.canvas.width / dpr;
		const h = this.canvas.height / dpr;
		const col = this.colors;
		c.setTransform(dpr, 0, 0, dpr, 0, 0);
		c.clearRect(0, 0, w, h);
		if (!this.nodes.length) {
			c.fillStyle = col["graphite"] || "#999";
			c.font = `12px ${col["sans"] || "sans-serif"}`;
			c.textAlign = "center";
			c.fillText(this.emptyText, w / 2, h / 2);
			return;
		}
		const { x: tx, y: ty, k } = this.view;
		c.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
		const hv = this.hover;
		const near = hv ? this.adj.get(hv.id) ?? new Set<string>() : null;
		const lit = (n: Sim) => !hv || n === hv || near!.has(n.id);

		// エッジ
		c.lineWidth = 1 / k;
		for (const [p, q] of this.edges) {
			const on = hv && (p === hv || q === hv);
			c.strokeStyle = on ? col["focus"]! : col["graphite"]!;
			c.globalAlpha = hv ? (on ? 0.9 : 0.08) : 0.35;
			c.beginPath();
			c.moveTo(p.x, p.y);
			c.lineTo(q.x, q.y);
			c.stroke();
		}

		// ノード：アイデアは丸、タスクは四角、目標はひし形、PJ は輪
		for (const n of this.nodes) {
			const r = this.radius(n);
			c.globalAlpha = (lit(n) ? 1 : 0.15) * (n.kind === "idea" ? ideaAlpha(n.status) : n.kind === "task" && n.status === "done" ? 0.45 : 1);
			c.beginPath();
			if (n.kind === "task") c.rect(n.x - r, n.y - r, r * 2, r * 2);
			else if (n.kind === "goal") {
				c.moveTo(n.x, n.y - r);
				c.lineTo(n.x + r, n.y);
				c.lineTo(n.x, n.y + r);
				c.lineTo(n.x - r, n.y);
				c.closePath();
			} else c.arc(n.x, n.y, r, 0, Math.PI * 2);
			if (n.kind === "project") {
				c.fillStyle = col["paper-2"]!;
				c.fill();
				c.lineWidth = 2 / k;
				c.strokeStyle = col["graphite"]!;
				c.stroke();
			} else {
				c.fillStyle = n.kind === "idea" ? col["focus"]! : col["ink"]!;
				c.fill();
				if (n === hv) {
					c.lineWidth = 2 / k;
					c.strokeStyle = col["paper"]!;
					c.stroke();
				}
			}
		}

		// ラベル：ハブ（目標・PJ）はいつも、ほかはホバーとその隣、拡大したときだけ
		const fs = 11 / Math.max(k, 0.6);
		c.font = `${fs}px ${col["sans"] || "sans-serif"}`;
		c.textAlign = "center";
		c.textBaseline = "top";
		for (const n of this.nodes) {
			const show = hv ? lit(n) : n.kind === "goal" || n.kind === "project" || k >= 1.4;
			if (!show) continue;
			const label = n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label;
			const y = n.y + this.radius(n) + 3 / k;
			c.globalAlpha = 1;
			c.lineWidth = 3 / k;
			c.strokeStyle = col["paper"]!;
			c.strokeText(label, n.x, y);
			c.fillStyle = n === hv ? col["ink"]! : col["graphite"]!;
			c.fillText(label, n.x, y);
		}
		c.globalAlpha = 1;
	}

	// ───────── 操作 ─────────

	/** 画面上の点 → 配置の座標（盤面の CSS zoom も吸収する） */
	private toWorld(e: PointerEvent | WheelEvent): { x: number; y: number; sx: number; sy: number } {
		const rect = this.canvas.getBoundingClientRect();
		const scale = rect.width / (this.canvas.clientWidth || rect.width) || 1;
		const sx = (e.clientX - rect.left) / scale;
		const sy = (e.clientY - rect.top) / scale;
		return { sx, sy, x: (sx - this.view.x) / this.view.k, y: (sy - this.view.y) / this.view.k };
	}

	private pick(x: number, y: number): Sim | null {
		let best: Sim | null = null;
		let bd = Infinity;
		for (const n of this.nodes) {
			const r = this.radius(n) + 4 / this.view.k;
			const d = (n.x - x) ** 2 + (n.y - y) ** 2;
			if (d < r * r && d < bd) {
				best = n;
				bd = d;
			}
		}
		return best;
	}

	private down(e: PointerEvent) {
		if (e.button !== 0) return;
		const p = this.toWorld(e);
		const node = this.pick(p.x, p.y);
		this.canvas.setPointerCapture(e.pointerId);
		this.drag = { node, sx: p.sx, sy: p.sy, vx: this.view.x, vy: this.view.y, moved: false };
		if (node) {
			node.fixed = true;
			this.heat(0.3);
		}
	}

	private move(e: PointerEvent) {
		const p = this.toWorld(e);
		const d = this.drag;
		if (!d) {
			const h = this.pick(p.x, p.y);
			if (h !== this.hover) {
				this.hover = h;
				this.canvas.style.cursor = h ? (h.path ? "pointer" : "grab") : "default";
				this.draw();
			}
			return;
		}
		if (Math.abs(p.sx - d.sx) + Math.abs(p.sy - d.sy) > 3) d.moved = true;
		if (d.node) {
			d.node.x = p.x;
			d.node.y = p.y;
			this.heat(0.3);
		} else {
			this.view.x = d.vx + (p.sx - d.sx);
			this.view.y = d.vy + (p.sy - d.sy);
			this.draw();
		}
	}

	private up(e: PointerEvent) {
		const d = this.drag;
		this.drag = null;
		if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
		if (!d) return;
		if (d.node) {
			d.node.fixed = false;
			if (!d.moved) this.onOpen(d.node);
		}
		this.onDragEnd();
	}

	private wheel(e: WheelEvent) {
		e.preventDefault();
		const p = this.toWorld(e);
		const k = Math.min(4, Math.max(0.15, this.view.k * Math.exp(-e.deltaY * 0.0015)));
		this.view = { k, x: p.sx - p.x * k, y: p.sy - p.y * k };
		this.draw();
	}
}

/** アイデアの status で明度を変える（見送りは薄く） */
function ideaAlpha(status = ""): number {
	if (status === "温め中") return 0.7;
	if (status === "タスク化") return 0.45;
	if (status === "見送り") return 0.2;
	return 1;
}
