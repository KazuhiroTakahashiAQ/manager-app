// セッション間メッセージ（state/ui/handoff-*.json）の解釈。ファイル・ターミナルには触らない純関数だけを置く（hub.ts が使う）。
//
//   { "to": "main" | "system" | "tasks/<名>.md", "from": "mgr" | "system" | "<sub mgr のタイトル>", "brief": "…", "reply_to": "<to と同じ形式>" }
//
// - 従来の { "task": "tasks/…md", "brief": "…" } も読む（to = task、from = mgr）。
// - 本文の先頭に「[<from> から]」を付ける（brief が既に「[」で始まるなら付けない。従来の「[mgr から: 人の指示]」互換）。
// - reply_to があれば、返信のしかたを末尾に 1 行足す。

/** 宛先。main = mgr、system = システム改修 sub mgr、task = そのタスクの sub mgr */
export type Dest = { kind: "main" } | { kind: "system" } | { kind: "task"; taskPath: string };

export type Handoff = {
	dest: Dest;
	from: string;
	/** 宛先に貼る本文 */
	text: string;
	/** 従来の { task, brief } の形 */
	legacy: boolean;
	/** 届けるときに handoff-errors.log に残す注意（reply_to が読めないなど。本文は届ける） */
	warnings: string[];
};

export type HandoffResult = { ok: true; handoff: Handoff } | { ok: false; error: string };

const TASK_RE = /^tasks\/[^/]+\.md$/;

/** "main" / "system" / "tasks/<名>.md" を宛先にする。読めなければ null */
export function parseDest(v: unknown): Dest | null {
	if (typeof v !== "string") return null;
	const s = v.trim();
	if (s === "main") return { kind: "main" };
	if (s === "system") return { kind: "system" };
	if (TASK_RE.test(s) && !s.includes("\0")) return { kind: "task", taskPath: s };
	return null;
}

/** 宛先の表記（ログ・同じ宛先の順番待ちのキー） */
export function destKey(d: Dest): string {
	return d.kind === "task" ? d.taskPath : d.kind;
}

/**
 * JSON を読んだ値を解釈する。taskExists は tasks/… のノートがあるか（vault を見る関数を渡す）。
 * 宛先が不正・タスクノートがない・brief が空なら ok: false（呼び出し側がログに書いてファイルを消す）。
 */
export function interpretHandoff(raw: unknown, taskExists: (taskPath: string) => boolean): HandoffResult {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "JSON のオブジェクトでない" };
	const h = raw as Record<string, unknown>;
	const legacy = h["to"] === undefined && h["task"] !== undefined;
	const to = legacy ? h["task"] : h["to"];
	if (to === undefined) return { ok: false, error: "宛先（to）がない" };
	const dest = parseDest(to);
	if (!dest) return { ok: false, error: `宛先が不正: ${JSON.stringify(to)}（main / system / tasks/<名>.md）` };
	if (dest.kind === "task" && !taskExists(dest.taskPath)) return { ok: false, error: `宛先のタスクノートがない: ${dest.taskPath}` };

	const brief = typeof h["brief"] === "string" ? h["brief"].trim() : "";
	if (!brief) return { ok: false, error: `brief が空（宛先 ${destKey(dest)}）` };

	const from = oneLine(h["from"]) || (legacy ? "mgr" : "不明");
	const warnings: string[] = [];
	let replyLine = "";
	if (h["reply_to"] !== undefined && h["reply_to"] !== null && h["reply_to"] !== "") {
		const r = parseDest(h["reply_to"]);
		if (r) replyLine = `返信は state/ui/handoff-*.json の to に ${destKey(r)} を入れて送る`;
		else warnings.push(`reply_to が不正なので返信先の案内を付けなかった: ${JSON.stringify(h["reply_to"])}`);
	}

	const head = brief.startsWith("[") ? "" : `[${from} から]\n`;
	const text = `${head}${brief}${replyLine ? `\n\n${replyLine}` : ""}`;
	return { ok: true, handoff: { dest, from, text, legacy, warnings } };
}

/** from は 1 行・60 字まで（本文の見出しに使う） */
function oneLine(v: unknown): string {
	if (typeof v !== "string") return "";
	return v.replace(/[\r\n\t]+/g, " ").replace(/[[\]]/g, "").trim().slice(0, 60);
}
