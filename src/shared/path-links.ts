// ターミナル出力の中のパスらしい文字列を拾う（純粋関数。存在確認は bun 側 files.ts の filesProbe）。
// URL は除く。行番号付き（path:12 / path:12:3）は path と分ける。

export type PathCandidate = { start: number; end: number; text: string; path: string; line: number | null };

const TOKEN = /[^\s"'`<>()[\]{}|,;、。「」（）]+/g;
const MAX_PER_LINE = 12;

/** 1 行から候補を拾う。start/end は line 上の文字位置（end は含まない）で、行番号の部分は含めない */
export function findPathCandidates(line: string): PathCandidate[] {
	const out: PathCandidate[] = [];
	for (const m of line.matchAll(TOKEN)) {
		let tok = m[0];
		const start = m.index!;
		if (tok.includes("://") || /^[a-z][a-z0-9+.-]*:\/\//i.test(tok)) continue;
		let lineNo: number | null = null;
		const ln = /:(\d+)(?::\d+)?$/.exec(tok);
		if (ln) {
			lineNo = Number(ln[1]);
			tok = tok.slice(0, ln.index);
		}
		tok = tok.replace(/[.:!?…]+$/, "");
		if (!tok || tok === "/" || tok === "." || tok === "..") continue;
		// パスらしさ: / を含む、~ 始まり、または拡張子つきの 1 語（README.md）
		if (!(tok.includes("/") || tok.startsWith("~") || /^[^.].*\.[A-Za-z0-9]{1,8}$/.test(tok))) continue;
		if (/^v?\d+(\.\d+)+$/.test(tok)) continue; // バージョン番号
		out.push({ start, end: start + tok.length, text: tok, path: tok, line: lineNo });
		if (out.length >= MAX_PER_LINE) break;
	}
	return out;
}
