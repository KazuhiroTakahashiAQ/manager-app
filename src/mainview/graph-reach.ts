// グラフのホバーで強調する範囲。直下（隣接）に加えて、階層の向きがあるエッジ（down）をたどった全子孫。
// 祖先側は従来どおり隣接だけ。循環があっても訪問済みで止まる。

export type ReachEdge = {
	a: string;
	b: string;
	/** 階層の向き。"ab" は a が上（親）、"ba" は b が上。なければ階層ではない（works_with や兼務など） */
	down?: "ab" | "ba";
};

export type Reach<E extends ReachEdge> = {
	/** 強調するノード（本人・隣接・全子孫） */
	nodes: Set<string>;
	/** 強調するエッジ（本人に触れるもの・子孫へたどったもの） */
	edges: Set<E>;
};

/** `start` の全子孫（本人を除く）。down のあるエッジだけ上から下へたどる */
export function descendants(start: string, edges: ReachEdge[]): Set<string> {
	const kids = new Map<string, string[]>();
	for (const e of edges) {
		if (!e.down) continue;
		const [p, c] = e.down === "ab" ? [e.a, e.b] : [e.b, e.a];
		(kids.get(p) ?? kids.set(p, []).get(p)!).push(c);
	}
	const seen = new Set<string>([start]);
	const out = new Set<string>();
	const stack = [start];
	while (stack.length) {
		for (const c of kids.get(stack.pop()!) ?? []) {
			if (seen.has(c)) continue;
			seen.add(c);
			out.add(c);
			stack.push(c);
		}
	}
	return out;
}

export function reach<E extends ReachEdge>(start: string, edges: E[]): Reach<E> {
	const sub = descendants(start, edges);
	const nodes = new Set<string>([start, ...sub]);
	const hit = new Set<E>();
	for (const e of edges) {
		if (e.a === start || e.b === start) {
			hit.add(e);
			nodes.add(e.a === start ? e.b : e.a);
		} else if (e.down) {
			const parent = e.down === "ab" ? e.a : e.b;
			if (sub.has(parent)) hit.add(e);
		}
	}
	return { nodes, edges: hit };
}
