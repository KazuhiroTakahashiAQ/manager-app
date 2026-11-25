// Claude / Shell のターミナル出力のパスを Cmd+クリックで File タブに開く（xterm の link provider）。
// 存在するものだけリンクにする（下線も出さない）。bun 側の filesProbe で確認し、結果は短時間キャッシュする。

import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { findPathCandidates } from "../shared/path-links";
import type { FileProbe } from "../shared/types";

const TTL_MS = 10_000;
const MAX_CACHE = 500;

export type TermLinkDeps = {
	probe(p: { id: string; tokens: string[] }): Promise<{ results: (FileProbe | null)[] }>;
	open(path: string, dir: boolean): void;
};

export function registerPathLinks(term: Terminal, id: string, deps: TermLinkDeps) {
	const cache = new Map<string, { at: number; hit: FileProbe | null }>();
	const resolve = async (tokens: string[]): Promise<(FileProbe | null)[]> => {
		const now = Date.now();
		const need = tokens.filter((t) => {
			const c = cache.get(t);
			return !c || now - c.at > TTL_MS;
		});
		if (need.length) {
			const { results } = await deps.probe({ id, tokens: need });
			if (cache.size > MAX_CACHE) cache.clear();
			need.forEach((t, i) => cache.set(t, { at: now, hit: results[i] ?? null }));
		}
		return tokens.map((t) => cache.get(t)?.hit ?? null);
	};
	const provider: ILinkProvider = {
		provideLinks(y, callback) {
			const line = term.buffer.active.getLine(y - 1);
			if (!line) return callback(undefined);
			// 文字位置 → 桁（全角は 2 桁）
			let text = "";
			const col: number[] = [];
			const wid: number[] = [];
			for (let x = 0; x < line.length; x++) {
				const cell = line.getCell(x);
				if (!cell || cell.getWidth() === 0) continue;
				const chars = cell.getChars() || " ";
				for (const ch of chars) {
					text += ch;
					col.push(x);
					wid.push(cell.getWidth());
				}
			}
			const cands = findPathCandidates(text);
			if (!cands.length) return callback(undefined);
			void resolve(cands.map((c) => c.path)).then((hits) => {
				const links: ILink[] = [];
				cands.forEach((c, i) => {
					const hit = hits[i];
					if (!hit) return;
					const last = c.end - 1;
					links.push({
						text: c.text,
						range: { start: { x: col[c.start]! + 1, y }, end: { x: col[last]! + wid[last]!, y } },
						decorations: { underline: true, pointerCursor: true },
						activate: (ev) => {
							if (ev.metaKey) deps.open(hit.path, hit.dir);
						},
					});
				});
				callback(links.length ? links : undefined);
			});
		},
	};
	term.registerLinkProvider(provider);
}
