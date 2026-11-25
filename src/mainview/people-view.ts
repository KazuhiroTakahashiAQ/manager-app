// 「関係者」タブの中身を作る純関数（DOM に触らない）。人物ノート・プロジェクトノートからグラフのノード / エッジ、
// 指揮命令系統の階層レイアウト、表の行・並べ替え・絞り込みを出す。書式は vault の docs/schema.md。

import type { PersonNote, PjNote } from "../shared/types";
import type { GraphEdge, GraphNode } from "./graph";

export const PEOPLE_TAB = "graph:people";
export const PEOPLE_LABEL = "関係者";

export type Rel = "member_of" | "reports_to" | "works_with" | "client_of" | "introduced_by" | "commands";

/** 線のそばに出す名前（ホバー） */
export const REL_LABEL: Record<Rel, string> = {
	member_of: "所属",
	reports_to: "報告先",
	works_with: "協働",
	client_of: "顧客窓口",
	introduced_by: "紹介",
	commands: "指示",
};

/** 内部のノード id */
export const personId = (name: string) => `p:${name}`;
export const pjId = (name: string) => `j:${name}`;

export type Filter = {
	/** 絞り込むプロジェクト名。空なら全体 */
	pj: string;
	/** 退役（status: 退役）を含めるか */
	retired: boolean;
};

export const isRetired = (p: PersonNote) => p.fm["status"] === "退役";
export const isExternal = (p: PersonNote) => p.fm["kind"] === "外部";

/** プロジェクトの識別色（名前順で割り当てる。人物の縁取りとプロジェクトの輪に使う） */
const PALETTE = ["#d9822b", "#8b5bd0", "#2e9466", "#c2477a", "#b5a02a", "#3a8fb7", "#a0522d", "#6b7bd0"];
export function pjColors(pjs: PjNote[]): Map<string, string> {
	const names = [...new Set(pjs.map((p) => p.name))].sort((a, b) => a.localeCompare(b, "ja"));
	return new Map(names.map((n, i) => [n, PALETTE[i % PALETTE.length]!]));
}

/** 人物 → 参加プロジェクトと役割（PJ ノートの member 行と、人物ノートの member_of の両方から。重複はまとめる） */
export function membership(people: PersonNote[], pjs: PjNote[]): Map<string, { pj: string; role: string }[]> {
	const out = new Map<string, { pj: string; role: string }[]>();
	const add = (person: string, pj: string, role: string) => {
		const list = out.get(person) ?? out.set(person, []).get(person)!;
		const hit = list.find((x) => x.pj === pj);
		if (hit) hit.role ||= role;
		else list.push({ pj, role });
	};
	const pjNames = new Set(pjs.map((p) => p.name));
	for (const pj of pjs) for (const m of pj.members) add(m.name, pj.name, m.role);
	for (const p of people) for (const r of p.rels) if (r.rel === "member_of" && pjNames.has(r.to)) add(p.name, r.to, "");
	return out;
}

type RawEdge = { rel: Rel; a: string; b: string; pj?: string };

const edgeKey = (e: RawEdge) => (e.rel === "works_with" ? `${e.rel}|${[e.a, e.b].sort().join("|")}` : `${e.rel}|${e.a}|${e.b}`);

/** 人物ノート・PJ ノートの関係を、人名 / PJ 名のペアに（見つからない相手のリンクは捨てる）。同じ組は 1 本にまとめる */
export function collectEdges(people: PersonNote[], pjs: PjNote[]): RawEdge[] {
	const persons = new Set(people.map((p) => p.name));
	const pjNames = new Set(pjs.map((p) => p.name));
	const out = new Map<string, RawEdge>();
	const put = (e: RawEdge) => {
		if (e.a === e.b) return;
		const k = edgeKey(e);
		const prev = out.get(k);
		if (!prev) out.set(k, e);
		else if (e.pj && !prev.pj) prev.pj = e.pj;
	};
	for (const p of people) {
		for (const r of p.rels) {
			if (r.rel === "member_of") {
				if (pjNames.has(r.to)) put({ rel: "member_of", a: p.name, b: r.to });
			} else if (r.rel !== "belongs_to" && persons.has(r.to)) put({ rel: r.rel as Rel, a: p.name, b: r.to });
		}
	}
	for (const pj of pjs) {
		for (const m of pj.members) if (persons.has(m.name)) put({ rel: "member_of", a: m.name, b: pj.name, pj: pj.name });
		for (const l of pj.links) if (persons.has(l.from) && persons.has(l.to)) put({ rel: l.rel, a: l.from, b: l.to, pj: pj.name });
	}
	return [...out.values()];
}

/** 指揮命令系統の弧 (上 → 下)。commands A->B は A が上、reports_to A->B は B が上 */
export function hierArcs(edges: RawEdge[]): { from: string; to: string }[] {
	const arcs: { from: string; to: string }[] = [];
	for (const e of edges) {
		if (e.rel === "commands") arcs.push({ from: e.a, to: e.b });
		else if (e.rel === "reports_to") arcs.push({ from: e.b, to: e.a });
	}
	return arcs;
}

export const GAP_X = 140;
export const GAP_Y = 110;

/**
 * 簡易な階層レイアウト。弧に出てくるノードを上から下の層に並べ（最長経路の深さ。循環は後ろ向きの弧を無視）、
 * 弧に出てこないノードは一番下の行にまとめる。層の中は親の位置の平均で並べ替える。
 * 弧のないノードは、works_with の相手（peers）に段が決まった人がいればその段に横並びで置く（連鎖は最初に決まった側に揃える）。
 * 揃える相手が決まらない孤立ノードだけ最下段にまとめる。
 * 戻り値の level は 0 が最上段、孤立ノードは最下段（弧が 1 本もなければ全員 0）。
 */
export function hierLayout(ids: string[], arcsIn: { from: string; to: string }[], peers: { a: string; b: string }[] = []): Map<string, { x: number; y: number; level: number }> {
	const idSet = new Set(ids);
	const arcs = arcsIn.filter((a) => idSet.has(a.from) && idSet.has(a.to) && a.from !== a.to);
	const children = new Map<string, string[]>();
	for (const a of arcs) (children.get(a.from) ?? children.set(a.from, []).get(a.from)!).push(a.to);
	const inHier = new Set(arcs.flatMap((a) => [a.from, a.to]));

	// 循環の後ろ向きの弧を落とす（DFS）
	const state = new Map<string, 0 | 1 | 2>();
	const dag: { from: string; to: string }[] = [];
	const visit = (v: string) => {
		state.set(v, 1);
		for (const w of children.get(v) ?? []) {
			if (state.get(w) === 1) continue; // 後ろ向き
			dag.push({ from: v, to: w });
			if (!state.get(w)) visit(w);
		}
		state.set(v, 2);
	};
	for (const v of ids) if (inHier.has(v) && !state.get(v)) visit(v);

	// 最長経路の深さ
	const parents = new Map<string, string[]>();
	for (const a of dag) (parents.get(a.to) ?? parents.set(a.to, []).get(a.to)!).push(a.from);
	const level = new Map<string, number>();
	const depth = (v: string): number => {
		const hit = level.get(v);
		if (hit !== undefined) return hit;
		level.set(v, 0);
		const d = Math.max(-1, ...(parents.get(v) ?? []).map(depth)) + 1;
		level.set(v, d);
		return d;
	};
	for (const v of inHier) depth(v);
	const maxLevel = inHier.size ? Math.max(...level.values()) : -1;
	const looseLevel = inHier.size ? maxLevel + 1 : 0;
	// 弧のないノードを works_with の相手の段に揃える（段が決まった側から順に広げる）
	const aligned = new Set<string>();
	for (let changed = inHier.size > 0; changed; ) {
		changed = false;
		for (const v of ids) {
			if (inHier.has(v) || aligned.has(v)) continue;
			const hit = peers.find((e) => (e.a === v && level.has(e.b) && idSet.has(e.b)) || (e.b === v && level.has(e.a) && idSet.has(e.a)));
			if (!hit) continue;
			level.set(v, level.get(hit.a === v ? hit.b : hit.a)!);
			aligned.add(v);
			changed = true;
		}
	}
	for (const v of ids) if (!inHier.has(v) && !aligned.has(v)) level.set(v, looseLevel);

	// 層ごとの並び（入力順 → 親の平均位置で 2 回整える）
	const rows: string[][] = [];
	for (const v of ids) (rows[level.get(v)!] ??= []).push(v);
	const order = new Map<string, number>();
	const index = () => rows.forEach((r) => r?.forEach((v, i) => order.set(v, i - (r.length - 1) / 2)));
	index();
	for (let pass = 0; pass < 2; pass++) {
		for (let l = 1; l < rows.length; l++) {
			const r = rows[l];
			if (!r || l === looseLevel) continue;
			const bary = (v: string) => {
				const ps = parents.get(v) ?? [];
				return ps.length ? ps.reduce((s, p) => s + (order.get(p) ?? 0), 0) / ps.length : (order.get(v) ?? 0);
			};
			r.sort((a, b) => bary(a) - bary(b));
			index();
		}
	}
	const out = new Map<string, { x: number; y: number; level: number }>();
	rows.forEach((r, l) => r?.forEach((v) => out.set(v, { x: (order.get(v) ?? 0) * GAP_X, y: l * GAP_Y, level: l })));
	return out;
}

export type PeopleGraph = { nodes: GraphNode[]; edges: GraphEdge[]; fixed: boolean; empty: string };

const REL_STYLE: Record<Rel, Partial<GraphEdge>> = {
	commands: { arrow: true, strong: true, color: "#b5412c" },
	reports_to: { arrow: true, strong: true },
	works_with: { dash: [5, 4] },
	client_of: { arrow: true, dash: [2, 3] },
	introduced_by: { arrow: true, dash: [2, 3] },
	member_of: {},
};

/** 絞り込み（プロジェクト・退役）を掛けたあとの人物 */
export function visiblePeople(people: PersonNote[], pjs: PjNote[], f: Filter): PersonNote[] {
	let list = f.retired ? people : people.filter((p) => !isRetired(p));
	if (f.pj) {
		const names = new Set(
			[...membership(people, pjs)].filter(([, ms]) => ms.some((m) => m.pj === f.pj)).map(([n]) => n),
		);
		list = list.filter((p) => names.has(p.name));
	}
	return list;
}

export function buildGraph(people: PersonNote[], pjs: PjNote[], f: Filter): PeopleGraph {
	const colors = pjColors(pjs);
	const ms = membership(people, pjs);
	const pjSel = f.pj && pjs.some((p) => p.name === f.pj) ? f.pj : "";
	const shown = visiblePeople(people, pjs, { ...f, pj: pjSel });
	const shownNames = new Set(shown.map((p) => p.name));
	const raw = collectEdges(people, pjs);

	const personNode = (p: PersonNote): GraphNode => {
		const mine = ms.get(p.name) ?? [];
		const ringPj = pjSel || mine[0]?.pj;
		return {
			id: personId(p.name),
			kind: "person",
			label: p.name,
			path: p.path,
			fill: isExternal(p) ? "#d9822b" : "#2f6d8f",
			ring: ringPj ? colors.get(ringPj) : undefined,
			dim: isRetired(p),
			always: true,
		};
	};
	const pjNode = (pj: PjNote, big = false): GraphNode => ({
		id: pjId(pj.name),
		kind: "project",
		label: pj.name,
		path: pj.path,
		shape: "square",
		ring: colors.get(pj.name),
		r: big ? 13 : 11,
		always: true,
	});
	const style = (e: RawEdge, a: string, b: string): GraphEdge => ({ a, b, label: REL_LABEL[e.rel], ...REL_STYLE[e.rel] });

	if (!pjSel) {
		// 関係者のいない PJ は全体の図では出さない（孤立するだけ。プルダウンからは選べる）
		const withMembers = pjs.filter((p) => shown.some((x) => (ms.get(x.name) ?? []).some((m) => m.pj === p.name)));
		const nodes: GraphNode[] = [...shown.map(personNode), ...withMembers.map((p) => pjNode(p))];
		const ids = new Set(nodes.map((n) => n.id));
		const edges: GraphEdge[] = [];
		for (const e of raw) {
			const a = personId(e.a);
			const b = e.rel === "member_of" ? pjId(e.b) : personId(e.b);
			if (ids.has(a) && ids.has(b)) edges.push(style(e, a, b));
		}
		return { nodes, edges, fixed: false, empty: "関係者がまだない（memory/people/）" };
	}

	// プロジェクトを選んだ: 関係者だけ。pj ノートの commands / reports_to を階層にして上から下へ
	const pj = pjs.find((p) => p.name === pjSel)!;
	const inSel = raw.filter((e) => e.rel !== "member_of" && shownNames.has(e.a) && shownNames.has(e.b));
	const pjArcs = hierArcs(inSel.filter((e) => e.pj === pjSel));
	const personIds = shown.map((p) => personId(p.name));
	const peers = inSel.filter((e) => e.rel === "works_with").map((e) => ({ a: personId(e.a), b: personId(e.b) }));
	const pos = hierLayout(personIds, pjArcs.map((a) => ({ from: personId(a.from), to: personId(a.to) })), peers);
	const hasHier = pjArcs.some((a) => shownNames.has(a.from) && shownNames.has(a.to));
	const tops = hasHier ? personIds.filter((id) => pos.get(id)?.level === 0 && pjArcs.some((a) => personId(a.from) === id)) : personIds;
	const shift = 1; // PJ ノードを最上段（level -1）に
	const nodes: GraphNode[] = shown.map((p) => {
		const q = pos.get(personId(p.name))!;
		return { ...personNode(p), x: q.x, y: (q.level + shift) * GAP_Y };
	});
	nodes.unshift({ ...pjNode(pj, true), x: 0, y: 0 });
	// プロジェクトのノートに書かれていない指揮・報告（人事上の reports_to など）は細い破線にして、階層とは区別する
	const edges: GraphEdge[] = inSel.map((e) => {
		const g = style(e, personId(e.a), personId(e.b));
		if (e.rel !== "commands" && e.rel !== "reports_to") return g;
		// PJ ノートの指揮・報告は階層（ホバーで全部下まで強調）。人事上のものは細い破線で、直下だけ
		if (e.pj !== pjSel) return { ...g, strong: false, dash: [4, 3] };
		return { ...g, down: e.rel === "commands" ? "ab" : "ba" };
	});
	for (const id of tops) edges.push({ a: pjId(pj.name), b: id, label: REL_LABEL.member_of, down: "ab" });
	return {
		nodes,
		edges,
		fixed: true,
		empty: "このプロジェクトの関係者がまだない（memory/pj/ の「## 関係者」）",
	};
}

// ───────── 表 ─────────

export type PeopleRow = {
	name: string;
	path: string;
	kind: string;
	org: string;
	role: string;
	slack: string;
	backlog: string;
	projects: string[];
	updated: string;
	retired: boolean;
};

export type SortKey = "name" | "kind" | "org" | "role" | "slack" | "backlog" | "projects" | "updated";
export const SORT_KEYS: SortKey[] = ["name", "kind", "org", "role", "slack", "backlog", "projects", "updated"];
export const SORT_LABEL: Record<SortKey, string> = {
	name: "氏名",
	kind: "社内・外部",
	org: "所属",
	role: "役割",
	slack: "Slack",
	backlog: "Backlog",
	projects: "参加プロジェクト",
	updated: "更新日",
};

/** Backlog 列の表記。未登録は「—未登録」、まだ探していなければ「未確認」 */
export function backlogLabel(p: PersonNote): string {
	const b = p.fm["backlog"] ?? "";
	const id = p.fm["backlog_user"] ?? "";
	if (b === "未登録") return "—未登録";
	if (b === "登録" || id) return id ? `登録（${id}）` : "登録";
	return "未確認";
}

export const slackLabel = (p: PersonNote) => p.fm["slack_name"] || p.fm["slack_id"] || "—";

/** orgText: 所属の表記（組織ノートの階層 `会社 / 部 / 課` など）。なければ fm の org をそのまま */
export function tableRows(people: PersonNote[], pjs: PjNote[], f: Filter, orgText?: (p: PersonNote) => string): PeopleRow[] {
	const ms = membership(people, pjs);
	const pjSel = f.pj && pjs.some((p) => p.name === f.pj) ? f.pj : "";
	return visiblePeople(people, pjs, { ...f, pj: pjSel }).map((p) => {
		const mine = ms.get(p.name) ?? [];
		const inPj = pjSel ? mine.find((m) => m.pj === pjSel) : undefined;
		return {
			name: p.name,
			path: p.path,
			kind: p.fm["kind"] || "—",
			org: (orgText ? orgText(p) : p.fm["org"]) || "—",
			role: inPj?.role || p.fm["role"] || "—",
			slack: slackLabel(p),
			backlog: backlogLabel(p),
			projects: mine.map((m) => m.pj),
			updated: p.fm["updated"] || "—",
			retired: isRetired(p),
		};
	});
}

/** 並べ替え。「—」と空は昇順・降順どちらでも最後 */
export function sortRows(rows: PeopleRow[], key: SortKey, dir: 1 | -1): PeopleRow[] {
	const val = (r: PeopleRow) => (key === "projects" ? r.projects.join("、") : r[key]);
	const blank = (s: string) => s === "" || s === "—";
	return [...rows].sort((a, b) => {
		const x = val(a);
		const y = val(b);
		if (blank(x) !== blank(y)) return blank(x) ? 1 : -1;
		const c = key === "updated" ? x.localeCompare(y) : x.localeCompare(y, "ja");
		return c * dir || a.name.localeCompare(b.name, "ja");
	});
}

// ───────── 詳細 ─────────

export type PersonDetail = {
	person: PersonNote;
	projects: { pj: string; role: string }[];
	/** 人物ノートの relation（PJ 以外）を人ごとにまとめた線 */
	relations: { rel: Rel; label: string; other: string; dir: "to" | "from" | "both" }[];
};

export function personDetail(person: PersonNote, people: PersonNote[], pjs: PjNote[]): PersonDetail {
	const ms = membership(people, pjs).get(person.name) ?? [];
	const relations: PersonDetail["relations"] = [];
	for (const e of collectEdges(people, pjs)) {
		if (e.rel === "member_of") continue;
		if (e.a === person.name) relations.push({ rel: e.rel, label: REL_LABEL[e.rel], other: e.b, dir: e.rel === "works_with" ? "both" : "to" });
		else if (e.b === person.name) relations.push({ rel: e.rel, label: REL_LABEL[e.rel], other: e.a, dir: e.rel === "works_with" ? "both" : "from" });
	}
	return { person, projects: ms, relations };
}
