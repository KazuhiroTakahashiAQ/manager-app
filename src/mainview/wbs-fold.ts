// WBS（ガントチャート）の親を畳む・開く。DOM に触れない部分だけ（テストできるように）

/** 表の 1 行。木を深さ優先で並べた順に渡す（親の直後に子孫が続く） */
export type FoldRow = { key: string; depth: number };

/** 各行の子孫の数（孫以降を含む）。0 なら子のない行 */
export function descendantCounts(rows: readonly FoldRow[]): number[] {
	const out = rows.map(() => 0);
	const stack: number[] = []; // 祖先の行番号
	rows.forEach((r, i) => {
		while (stack.length && rows[stack[stack.length - 1]!]!.depth >= r.depth) stack.pop();
		for (const a of stack) out[a]!++;
		stack.push(i);
	});
	return out;
}

/** 畳まれた祖先を持つ行は true（隠す）。隠れた行自身の畳み状態は見ない */
export function hiddenFlags(rows: readonly FoldRow[], collapsed: ReadonlySet<string>): boolean[] {
	let hideDeeperThan = Infinity; // 見えている中で一番浅い、畳まれた親の深さ
	return rows.map((r) => {
		if (r.depth > hideDeeperThan) return true;
		hideDeeperThan = collapsed.has(r.key) ? r.depth : Infinity;
		return false;
	});
}

/** localStorage の値を読む。壊れていても空で始める */
export function parseCollapsed(raw: string | null): Set<string> {
	try {
		const v: unknown = JSON.parse(raw ?? "[]");
		return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
	} catch {
		return new Set();
	}
}

/** 保存する値。いま表にある親だけ残す（消えたタスクの分を溜めない） */
export function serializeCollapsed(collapsed: ReadonlySet<string>, parents: Iterable<string>): string {
	const keep = new Set(parents);
	return JSON.stringify([...collapsed].filter((k) => keep.has(k)).sort());
}
