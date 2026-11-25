// 「関係者」タブの組織の見方（DOM に触らない純関数）。組織は memory/org/ のノートで、parent で親を指して
// 会社→部→課→グループと任意の深さでネストする。人物の所属は PJ 参画とは独立。書式は vault の docs/schema.md。

import type { OrgNote, PersonNote } from "../shared/types";
import type { GraphEdge, GraphNode } from "./graph";
import { hierLayout, isRetired, isExternal, type PeopleGraph } from "./people-view";

export const orgId = (name: string) => `o:${name}`;

/** `[[名前]]` / `[[名前|別名]]` / 素の文字列 → 名前（bun/people.ts の linkName と同じ。mainview は bun を読まない） */
export function plainLink(v: string | undefined): string {
	const m = /^\s*\[\[(.+?)(?:\|.*?)?\]\]\s*$/.exec(v ?? "");
	return (m ? m[1]! : (v ?? "")).replace(/#.*$/, "").trim();
}

export type Affiliation = {
	/** 組織ノート名。ノートが見つからなければ書かれていた文字列そのまま */
	name: string;
	/** 組織ノートに解決できたか（できなければ文字列として表示） */
	resolved: boolean;
	/** fm の org（主所属） */
	primary: boolean;
	/** 組織での役職（主所属は fm post、兼務は belongs_to 行の `— 役職`） */
	post: string;
};

/** 人物の所属。主所属は fm org、兼務は `belongs_to [[組織]] — 役職`。重複はまとめる */
export function affiliations(p: PersonNote, orgs: OrgNote[]): Affiliation[] {
	const known = new Set(orgs.map((o) => o.name));
	const out: Affiliation[] = [];
	const add = (name: string, primary: boolean, post: string) => {
		if (!name) return;
		const hit = out.find((a) => a.name === name);
		if (hit) {
			hit.primary ||= primary;
			hit.post ||= post;
		} else out.push({ name, resolved: known.has(name), primary, post });
	};
	add(plainLink(p.fm["org"]), true, p.fm["post"] ?? "");
	for (const r of p.rels) if (r.rel === "belongs_to") add(r.to, false, r.note ?? "");
	return out;
}

/** 親の連鎖（循環は途中で切る）。最上位 → name の順 */
export function orgPath(name: string, orgs: OrgNote[]): string[] {
	const by = new Map(orgs.map((o) => [o.name, o]));
	const chain: string[] = [];
	let cur: string | undefined = name;
	while (cur && !chain.includes(cur)) {
		chain.unshift(cur);
		cur = by.get(cur)?.parent || undefined;
	}
	return chain;
}

/** 「会社 / 部 / 課」の表記。解決できない文字列はそのまま */
export const orgLabel = (name: string, orgs: OrgNote[]) => orgPath(name, orgs).join(" / ");

/** 自分と配下の組織名（循環・自己参照に耐える） */
export function descendants(name: string, orgs: OrgNote[]): Set<string> {
	const kids = new Map<string, string[]>();
	for (const o of orgs) if (o.parent) (kids.get(o.parent) ?? kids.set(o.parent, []).get(o.parent)!).push(o.name);
	const out = new Set<string>([name]);
	const stack = [name];
	while (stack.length) for (const k of kids.get(stack.pop()!) ?? []) if (!out.has(k)) (out.add(k), stack.push(k));
	return out;
}

/** 組織 sel（配下を含む）に所属する人物。sel が空なら全員 */
export function peopleIn(sel: string, people: PersonNote[], orgs: OrgNote[]): PersonNote[] {
	if (!sel) return people;
	const set = descendants(sel, orgs);
	return people.filter((p) => affiliations(p, orgs).some((a) => set.has(a.name)));
}

export type OrgTreeNode = {
	name: string;
	/** 階層名（会社 / 部 / 課 / グループ など。自由） */
	kind: string;
	side: string;
	path: string;
	resolved: boolean;
	/** この組織に直接所属する人数 */
	direct: number;
	/** 配下を含む人数（重複なし） */
	total: number;
	children: OrgTreeNode[];
};

/** 組織ツリー。親が見つからない・循環する組織は最上位にする。解決できない org 文字列は葉の最上位として足す */
export function orgTree(orgs: OrgNote[], people: PersonNote[], retired = false): OrgTreeNode[] {
	const list = retired ? people : people.filter((p) => !isRetired(p));
	const known = new Set(orgs.map((o) => o.name));
	const members = new Map<string, Set<string>>();
	for (const p of list) for (const a of affiliations(p, orgs)) (members.get(a.name) ?? members.set(a.name, new Set()).get(a.name)!).add(p.name);

	const by = new Map(orgs.map((o) => [o.name, o]));
	// 親の連鎖が循環する組織は最上位に引き上げる
	const parentOf = (o: OrgNote) => {
		if (!o.parent || !known.has(o.parent)) return "";
		let cur = o.parent;
		const seen = new Set([o.name]);
		while (cur) {
			if (seen.has(cur)) return "";
			seen.add(cur);
			cur = by.get(cur)?.parent ?? "";
			if (!known.has(cur)) break;
		}
		return o.parent;
	};
	const kids = new Map<string, OrgNote[]>();
	const roots: OrgNote[] = [];
	for (const o of orgs) {
		const par = parentOf(o);
		if (par) (kids.get(par) ?? kids.set(par, []).get(par)!).push(o);
		else roots.push(o);
	}
	const cmp = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "ja");
	const build = (o: OrgNote): OrgTreeNode => {
		const children = (kids.get(o.name) ?? []).sort(cmp).map(build);
		const all = new Set(members.get(o.name) ?? []);
		for (const c of children) for (const n of members.get(c.name) ?? []) all.add(n);
		// 子孫の人数は子の total ではなく名前の和集合で数える（重複所属を二重に数えない）
		const deep = new Set(all);
		const walk = (n: OrgTreeNode) => n.children.forEach((c) => (members.get(c.name)?.forEach((x) => deep.add(x)), walk(c)));
		children.forEach(walk);
		return {
			name: o.name,
			kind: o.fm["kind"] ?? "",
			side: o.fm["side"] ?? "",
			path: o.path,
			resolved: true,
			direct: members.get(o.name)?.size ?? 0,
			total: deep.size,
			children,
		};
	};
	const tree = roots.sort(cmp).map(build);
	const loose = [...members.keys()].filter((n) => !known.has(n)).sort((a, b) => a.localeCompare(b, "ja"));
	for (const n of loose) {
		const c = members.get(n)!.size;
		tree.push({ name: n, kind: "", side: "", path: "", resolved: false, direct: c, total: c, children: [] });
	}
	return tree;
}

/** 組織ツリーの表示行（折りたたみを反映した平らな並び）。collapsed に入っている組織の配下は出さない */
export function treeRows(tree: OrgTreeNode[], collapsed: Set<string>): { node: OrgTreeNode; depth: number; open: boolean }[] {
	const out: { node: OrgTreeNode; depth: number; open: boolean }[] = [];
	const walk = (n: OrgTreeNode, depth: number) => {
		const open = !collapsed.has(n.name);
		out.push({ node: n, depth, open });
		if (open) n.children.forEach((c) => walk(c, depth + 1));
	};
	tree.forEach((n) => walk(n, 0));
	return out;
}

/**
 * 組織のグラフ（PJ の階層とは別モード）。組織ノードを親→子の矢印で上から下に、人物は主所属（なければ最初の所属）の
 * 下にぶら下げ、兼務は細い破線。sel があればその組織と配下だけ。
 */
export function buildOrgGraph(orgs: OrgNote[], people: PersonNote[], sel: string, retired: boolean): PeopleGraph {
	const known = new Set(orgs.map((o) => o.name));
	const scope = sel ? descendants(sel, orgs) : null;
	const shown = (retired ? people : people.filter((p) => !isRetired(p))).filter((p) => (scope ? affiliations(p, orgs).some((a) => scope.has(a.name)) : true));
	const orgNames = new Set<string>();
	for (const o of orgs) if (!scope || scope.has(o.name)) orgNames.add(o.name);
	const nodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	const arcs: { from: string; to: string }[] = [];
	const loose = new Set<string>();
	const placed = new Map<string, string>(); // 人 → 主な所属の id
	for (const p of shown) {
		const affs = affiliations(p, orgs).filter((a) => !scope || scope.has(a.name));
		for (const a of affs) if (!a.resolved) loose.add(a.name);
		const main = affs.find((a) => a.primary) ?? affs[0];
		if (main) placed.set(p.name, orgId(main.name));
	}
	for (const n of orgNames) {
		const o = orgs.find((x) => x.name === n)!;
		nodes.push({ id: orgId(n), kind: "project", label: n, path: o.path, shape: "diamond", fill: o.fm["side"] === "外部" ? "#d9822b" : "#2f6d8f", r: 12, always: true });
		if (o.parent && orgNames.has(o.parent) && known.has(o.parent)) {
			arcs.push({ from: orgId(o.parent), to: orgId(n) });
			edges.push({ a: orgId(o.parent), b: orgId(n), arrow: true, strong: true, label: "配下", down: "ab" });
		}
	}
	for (const n of loose) nodes.push({ id: orgId(n), kind: "project", label: n, shape: "diamond", dim: true, r: 10, always: true });
	for (const p of shown) {
		nodes.push({ id: `p:${p.name}`, kind: "person", label: p.name, path: p.path, fill: isExternal(p) ? "#d9822b" : "#2f6d8f", dim: isRetired(p), always: true });
		const main = placed.get(p.name);
		for (const a of affiliations(p, orgs)) {
			const id = orgId(a.name);
			if (!nodes.some((x) => x.id === id)) continue;
			if (id === main) {
				arcs.push({ from: id, to: `p:${p.name}` });
				edges.push({ a: id, b: `p:${p.name}`, label: a.post || "所属", down: "ab" });
			} else edges.push({ a: id, b: `p:${p.name}`, dash: [4, 3], label: a.post ? `兼務 ${a.post}` : "兼務" });
		}
	}
	const pos = hierLayout(nodes.map((n) => n.id), arcs);
	for (const n of nodes) {
		const q = pos.get(n.id);
		if (q) ((n.x = q.x), (n.y = q.y));
	}
	return { nodes, edges, fixed: true, empty: "組織がまだない（memory/org/）" };
}
