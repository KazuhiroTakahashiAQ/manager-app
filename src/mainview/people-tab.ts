// 「関係者」タブ（グラフ ⇄ 表、プロジェクトで絞り込み、ノードや行を押すと詳細）。
// 描画は見えているときだけ。データが変わっていなければ描き直さない（グラフの配置を保つ）。

import { IdeaGraph, type GraphNode } from "./graph";
import {
	REL_LABEL,
	SORT_KEYS,
	SORT_LABEL,
	type Filter,
	type SortKey,
	backlogLabel,
	buildGraph,
	isRetired,
	membership,
	personDetail,
	pjColors,
	slackLabel,
	sortRows,
	tableRows,
} from "./people-view";
import { affiliations, buildOrgGraph, orgLabel, orgTree, peopleIn, treeRows } from "./org-view";
import type { OrgNote, PersonNote, PjNote } from "../shared/types";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** 表に出す行の上限（人物が増えても重くならないように） */
export const TABLE_LIMIT = 300;

type Sel = { kind: "person" | "pj"; name: string } | null;

type Hooks = {
	openNote: (path: string) => void;
	talk: (path: string, text: string) => void;
	load: (key: string) => string | null;
	store: (key: string, value: string) => void;
};

export class PeopleTab {
	readonly el: HTMLDivElement;
	private people: PersonNote[] = [];
	private pjs: PjNote[] = [];
	private orgs: OrgNote[] = [];
	/** 見方。pj = プロジェクトの指揮命令系統、org = 所属組織のツリー（別モード） */
	private mode: "pj" | "org";
	private orgSel = "";
	private collapsed = new Set<string>();
	private sig = "";
	private visible = false;
	private view: "graph" | "table";
	private filter: Filter;
	private sort: { key: SortKey; dir: 1 | -1 } = { key: "name", dir: 1 };
	private sel: Sel = null;
	private graph: IdeaGraph;

	constructor(private h: Hooks) {
		this.mode = h.load("peopleMode") === "org" ? "org" : "pj";
		this.orgSel = h.load("peopleOrg") ?? "";
		this.view = h.load("peopleView") === "table" ? "table" : "graph";
		this.filter = { pj: h.load("peoplePj") ?? "", retired: h.load("peopleRetired") === "1" };
		this.el = document.createElement("div");
		this.el.className = "reader-people";
		this.el.hidden = true;
		this.graph = new IdeaGraph((n) => this.pick(n));
		this.el.addEventListener("click", (e) => this.click(e));
		this.el.addEventListener("change", (e) => this.change(e));
	}

	/** vault の状態が来たとき（見えていなければ覚えるだけ） */
	setData(people: PersonNote[], pjs: PjNote[], orgs: OrgNote[] = []) {
		const sig = JSON.stringify([people.map((p) => [p.path, p.mtime]), pjs.map((p) => [p.path, p.mtime]), orgs.map((o) => [o.path, o.mtime])]);
		this.orgs = orgs;
		this.people = people;
		this.pjs = pjs;
		if (sig === this.sig) return;
		this.sig = sig;
		if (this.visible) this.render();
	}

	/** タブを開いた・閉じた */
	setVisible(v: boolean) {
		this.visible = v;
		this.el.hidden = !v;
		if (v) this.render();
	}

	private pjNames(): string[] {
		return [...new Set(this.pjs.map((p) => p.name))].sort((a, b) => a.localeCompare(b, "ja"));
	}

	private render() {
		if (this.filter.pj && !this.pjs.some((p) => p.name === this.filter.pj)) this.filter.pj = "";
		const graph = this.view === "graph";
		const org = this.mode === "org";
		if (this.orgSel && !this.orgKnown(this.orgSel)) this.orgSel = "";
		const opts = this.pjNames()
			.map((n) => `<option value="${esc(n)}"${n === this.filter.pj ? " selected" : ""}>${esc(n)}</option>`)
			.join("");
		this.el.innerHTML = `<div class="pp-bar">
			<span class="vt"><button type="button" data-pv="graph" aria-pressed="${graph}">グラフ</button><button type="button" data-pv="table" aria-pressed="${!graph}">表</button></span>
			<span class="vt"><button type="button" data-pm="pj" aria-pressed="${!org}">プロジェクト</button><button type="button" data-pm="org" aria-pressed="${org}">組織</button></span>
			${org ? "" : `<label class="pp-f">プロジェクト <select data-pp-pj><option value="">すべて</option>${opts}</select></label>`}
			<label class="pp-f"><input type="checkbox" data-pp-retired${this.filter.retired ? " checked" : ""}> 退役を含む</label>
		</div>
		<div class="pp-main">${org ? `<nav class="pp-orgs" id="pp-orgs">${this.orgTreeHtml()}</nav>` : ""}<div class="pp-view" id="pp-view"></div><aside class="pp-detail" id="pp-detail"></aside></div>`;
		const host = this.el.querySelector<HTMLElement>("#pp-view")!;
		if (graph) {
			const g = org ? buildOrgGraph(this.orgs, this.people, this.orgSel, this.filter.retired) : buildGraph(this.people, this.pjs, this.filter);
			host.innerHTML = `<div class="pp-graph"></div>${org ? this.orgLegend() : this.legend(!!this.filter.pj)}`;
			const slot = host.querySelector<HTMLElement>(".pp-graph")!;
			this.graph.setData(g.nodes, g.edges, g.empty, { fixed: g.fixed });
			slot.appendChild(this.graph.el);
			this.graph.refresh();
		} else {
			host.innerHTML = this.tableHtml();
		}
		this.renderDetail();
	}

	private orgKnown(name: string): boolean {
		return this.orgs.some((o) => o.name === name) || this.people.some((p) => affiliations(p, this.orgs).some((a) => a.name === name));
	}

	/** 組織で絞った（配下を含む）人物。プロジェクトの見方では絞らない */
	private scoped(): PersonNote[] {
		return this.mode === "org" ? peopleIn(this.orgSel, this.people, this.orgs) : this.people;
	}

	private orgTreeHtml(): string {
		const rows = treeRows(orgTree(this.orgs, this.people, this.filter.retired), this.collapsed);
		const all = `<li class="all${this.orgSel ? "" : " sel"}"><button type="button" class="link" data-org-pick="">すべての組織</button></li>`;
		const items = rows
			.map(({ node: n, depth, open }) => {
				const fold = n.children.length ? `<button type="button" class="fold" data-org-fold="${esc(n.name)}" aria-label="${open ? "たたむ" : "開く"}">${open ? "▾" : "▸"}</button>` : `<i class="fold"></i>`;
				const kind = n.kind ? `<span class="dim">${esc(n.kind)}</span>` : n.resolved ? "" : `<span class="dim">（組織ノートなし）</span>`;
				return `<li class="${n.name === this.orgSel ? "sel" : ""}${n.side === "外部" ? " ext" : ""}" style="padding-left:${depth * 14}px">${fold}<button type="button" class="link" data-org-pick="${esc(n.name)}">${esc(n.name)}</button> ${kind}<span class="cnt" title="直接 ${n.direct} 人 / 配下を含む ${n.total} 人">${n.total}</span></li>`;
			})
			.join("");
		return `<ul>${all}${items || `<li class="dim">組織がまだない（memory/org/）</li>`}</ul>`;
	}

	private orgLegend(): string {
		return `<p class="igraph-legend"><span class="lg in">社内</span><span class="lg out">外部</span><span class="lg cmd">配下（上から下）</span><span class="lg wk">兼務（破線）</span><span class="hint">組織は PJ 参画とは別。左のツリーで組織を選ぶと配下を含めて絞る</span></p>`;
	}

	private legend(pj: boolean): string {
		const base = `<span class="lg in">社内</span><span class="lg out">外部</span><span class="lg pjn">プロジェクト</span><span class="lg ring">縁取り = 所属プロジェクトの色</span><span class="lg faded">退役</span>`;
		const hier = pj
			? `<span class="lg cmd">指示（上から下）</span><span class="lg rep">報告（矢印の先が上長）</span><span class="lg wk">協働</span>`
			: `<span class="lg cmd">指示</span><span class="lg rep">報告</span><span class="lg wk">協働</span><span class="lg ref">顧客窓口・紹介（点線の矢印）</span>`;
		return `<p class="igraph-legend">${base}${hier}<span class="hint">ドラッグで動かす・ホイールで拡大・ダブルクリックで全体・押すと詳細</span></p>`;
	}

	private tableHtml(): string {
		const all = sortRows(tableRows(this.scoped(), this.pjs, { ...this.filter, pj: this.mode === "org" ? "" : this.filter.pj }, (p) => affiliations(p, this.orgs).map((a) => orgLabel(a.name, this.orgs) + (a.post ? `（${a.post}）` : "")).join("、")), this.sort.key, this.sort.dir);
		const rows = all.slice(0, TABLE_LIMIT);
		const head = SORT_KEYS.map((k) => {
			const on = this.sort.key === k;
			return `<th><button type="button" data-sort="${k}" aria-sort="${on ? (this.sort.dir === 1 ? "ascending" : "descending") : "none"}">${SORT_LABEL[k]}${on ? (this.sort.dir === 1 ? " ▲" : " ▼") : ""}</button></th>`;
		}).join("");
		const body = rows
			.map(
				(r) => `<tr data-row="${esc(r.name)}" class="${r.retired ? "retired" : ""}${this.sel?.kind === "person" && this.sel.name === r.name ? " sel" : ""}">
				<td class="nm">${esc(r.name)}</td><td>${esc(r.kind)}</td><td>${esc(r.org)}</td><td>${esc(r.role)}</td><td>${esc(r.slack)}</td>
				<td class="${r.backlog === "—未登録" || r.backlog === "未確認" ? "dim" : ""}">${esc(r.backlog)}</td><td>${esc(r.projects.join("、") || "—")}</td><td>${esc(r.updated)}</td></tr>`,
			)
			.join("");
		const more = all.length > rows.length ? `<p class="pp-more">先頭 ${rows.length} 件を表示（全 ${all.length} 件）。プロジェクトで絞ると減る</p>` : "";
		return `<div class="pp-table"><table><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="8" class="dim">関係者がまだない（memory/people/）</td></tr>`}</tbody></table>${more}</div>`;
	}

	// ───────── 詳細 ─────────

	private renderDetail() {
		const el = this.el.querySelector<HTMLElement>("#pp-detail");
		if (!el) return;
		el.innerHTML = this.detailHtml();
	}

	private detailHtml(): string {
		const s = this.sel;
		const hint = `<p class="pp-hint">ノードか行を押すと詳細</p>`;
		if (!s) return hint;
		if (s.kind === "person") {
			const p = this.people.find((x) => x.name === s.name);
			if (!p) return hint;
			const d = personDetail(p, this.people, this.pjs);
			const colors = pjColors(this.pjs);
			const f = p.fm;
			const row = (k: string, v: string, cls = "") => `<dt>${k}</dt><dd class="${cls}">${esc(v || "—")}</dd>`;
			const bl = backlogLabel(p);
			const projs = d.projects.length
				? d.projects
						.map(
							(m) => `<li><button type="button" class="link" data-sel-pj="${esc(m.pj)}"><i class="dot" style="border-color:${colors.get(m.pj) ?? "var(--graphite)"}"></i>${esc(m.pj)}</button>${m.role ? ` — ${esc(m.role)}` : ""}</li>`,
						)
						.join("")
				: `<li class="dim">なし</li>`;
			const rels = d.relations.length
				? d.relations
						.map((r) => `<li>${esc(r.label)}${r.dir === "from" ? "（相手から）" : ""}: <button type="button" class="link" data-sel-person="${esc(r.other)}">${esc(r.other)}</button></li>`)
						.join("")
				: `<li class="dim">なし</li>`;
			const prof = p.profile.length ? `<h4>プロフィール</h4><ul>${p.profile.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : "";
			return `<h3>${esc(p.name)}${isRetired(p) ? ` <span class="dim">（退役）</span>` : ""}</h3>
			<dl class="pp-props">${row("社内・外部", f["kind"] ?? "")}${row("所属", affiliations(p, this.orgs).map((a) => `${orgLabel(a.name, this.orgs)}${a.post ? `（${a.post}）` : ""}${a.primary ? "" : " 兼務"}`).join("、"))}${row("役割", f["role"] ?? "")}
			${row("Slack", f["slack_id"] ? `${slackLabel(p)}（${f["slack_id"]}）` : slackLabel(p))}${row("Backlog", bl, bl === "—未登録" || bl === "未確認" ? "dim" : "")}${row("更新", f["updated"] ?? "")}</dl>
			<h4>所属プロジェクトと役割</h4><ul>${projs}</ul>
			<h4>関係</h4><ul>${rels}</ul>${prof}
			<p class="pp-act"><button type="button" data-open-note="${esc(p.path)}">ノートを開く</button><button type="button" class="quiet" data-talk="${esc(p.path)}">話す</button></p>`;
		}
		const pj = this.pjs.find((x) => x.name === s.name);
		if (!pj) return hint;
		const roles = new Map(pj.members.map((m) => [m.name, m.role]));
		const names = [...new Set([...pj.members.map((m) => m.name), ...[...membership(this.people, this.pjs)].filter(([, v]) => v.some((m) => m.pj === pj.name)).map(([n]) => n)])];
		const members = names
			.map((n) => `<li><button type="button" class="link" data-sel-person="${esc(n)}">${esc(n)}</button>${roles.get(n) ? ` — ${esc(roles.get(n)!)}` : ""}</li>`)
			.join("");
		const lines = pj.links
			.map((l) => `<li>${esc(l.from)} ${l.rel === "works_with" ? "—" : "→"} ${esc(l.to)}（${esc(REL_LABEL[l.rel])}）${l.note ? ` <span class="dim">${esc(l.note)}</span>` : ""}</li>`)
			.join("");
		return `<h3>${esc(pj.name)}</h3>
		<dl class="pp-props">${[["状態", pj.fm["status"]], ["顧客", pj.fm["customer"]], ["更新", pj.fm["updated"]]].map(([k, v]) => `<dt>${k}</dt><dd>${esc(v || "—")}</dd>`).join("")}</dl>
		<h4>要約</h4><ul class="pp-sum">${pj.summary.slice(0, 6).map((l) => `<li>${esc(l.replace(/^[\s-]+/, ""))}</li>`).join("") || `<li class="dim">未記入</li>`}</ul>
		<h4>関係者</h4><ul>${members || `<li class="dim">なし</li>`}</ul>
		${lines ? `<h4>指揮・報告・協働</h4><ul>${lines}</ul>` : ""}
		<p class="pp-act"><button type="button" data-pp-focus="${esc(pj.name)}">この PJ で絞る</button><button type="button" data-open-note="${esc(pj.path)}">ノートを開く</button><button type="button" class="quiet" data-talk="${esc(pj.path)}">話す</button></p>`;
	}

	// ───────── 操作 ─────────

	private pick(n: GraphNode) {
		const m = /^([pj]):(.*)$/.exec(n.id);
		if (!m) return;
		this.sel = { kind: m[1] === "p" ? "person" : "pj", name: m[2]! };
		this.renderDetail();
	}

	private click(e: Event) {
		const t = e.target as HTMLElement;
		const pv = t.closest<HTMLElement>("[data-pv]");
		if (pv) {
			this.view = pv.dataset["pv"] === "table" ? "table" : "graph";
			this.h.store("peopleView", this.view);
			return this.render();
		}
		const pm = t.closest<HTMLElement>("[data-pm]");
		if (pm) {
			this.mode = pm.dataset["pm"] === "org" ? "org" : "pj";
			this.h.store("peopleMode", this.mode);
			return this.render();
		}
		const fold = t.closest<HTMLElement>("[data-org-fold]");
		if (fold) {
			const n = fold.dataset["orgFold"]!;
			this.collapsed.has(n) ? this.collapsed.delete(n) : this.collapsed.add(n);
			return this.render();
		}
		const pick = t.closest<HTMLElement>("[data-org-pick]");
		if (pick) {
			this.orgSel = pick.dataset["orgPick"] ?? "";
			this.h.store("peopleOrg", this.orgSel);
			return this.render();
		}
		const sort = t.closest<HTMLElement>("[data-sort]");
		if (sort) {
			const key = sort.dataset["sort"] as SortKey;
			this.sort = this.sort.key === key ? { key, dir: this.sort.dir === 1 ? -1 : 1 } : { key, dir: 1 };
			return this.render();
		}
		const row = t.closest<HTMLElement>("[data-row]");
		if (row) {
			this.sel = { kind: "person", name: row.dataset["row"]! };
			this.el.querySelectorAll("tr.sel").forEach((x) => x.classList.remove("sel"));
			row.classList.add("sel");
			return this.renderDetail();
		}
		const sp = t.closest<HTMLElement>("[data-sel-person]");
		if (sp) {
			this.sel = { kind: "person", name: sp.dataset["selPerson"]! };
			return this.renderDetail();
		}
		const sj = t.closest<HTMLElement>("[data-sel-pj]");
		if (sj) {
			this.sel = { kind: "pj", name: sj.dataset["selPj"]! };
			return this.renderDetail();
		}
		const focus = t.closest<HTMLElement>("[data-pp-focus]");
		if (focus) {
			this.filter.pj = focus.dataset["ppFocus"]!;
			this.h.store("peoplePj", this.filter.pj);
			return this.render();
		}
		const open = t.closest<HTMLElement>("[data-open-note]");
		if (open) return this.h.openNote(open.dataset["openNote"]!);
		const talk = t.closest<HTMLElement>("[data-talk]");
		if (talk) {
			const path = talk.dataset["talk"]!;
			const p = this.people.find((x) => x.path === path);
			const j = this.pjs.find((x) => x.path === path);
			const text = p ? [p.fm["kind"], affiliations(p, this.orgs)[0]?.name, p.fm["role"]].filter(Boolean).join(" / ") : (j?.summary[0] ?? "").replace(/^[\s-]+/, "");
			return this.h.talk(path, text);
		}
	}

	private change(e: Event) {
		const t = e.target as HTMLElement;
		if (t instanceof HTMLSelectElement && t.hasAttribute("data-pp-pj")) {
			this.filter.pj = t.value;
			this.h.store("peoplePj", t.value);
			this.render();
		} else if (t instanceof HTMLInputElement && t.hasAttribute("data-pp-retired")) {
			this.filter.retired = t.checked;
			this.h.store("peopleRetired", t.checked ? "1" : "0");
			this.render();
		}
	}
}
