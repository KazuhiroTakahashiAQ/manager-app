// bun test src/bun  （セッション間メッセージの解釈と、compact の判定材料の純関数を確かめる）
import { describe, expect, test } from "bun:test";
import { autocompactEnv, compactInstruction, tokensFromTail } from "./compact";
import { interpretHandoff, parseDest } from "./handoff";
import type { AppSettings } from "./settings";

const exists = (p: string) => p === "tasks/見積.md";

describe("interpretHandoff", () => {
	test("従来の { task, brief } は mgr からの引き継ぎ", () => {
		const r = interpretHandoff({ task: "tasks/見積.md", brief: "目的: 見積を出す" }, exists);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.handoff.legacy).toBe(true);
		expect(r.handoff.from).toBe("mgr");
		expect(r.handoff.dest).toEqual({ kind: "task", taskPath: "tasks/見積.md" });
		expect(r.handoff.text).toBe("[mgr から]\n目的: 見積を出す");
	});

	test("brief が [ で始まるなら見出しを付けない（[mgr から: 人の指示] 互換）", () => {
		const r = interpretHandoff({ task: "tasks/見積.md", brief: "[mgr から: 人の指示]\n急いで" }, exists);
		expect(r.ok && r.handoff.text).toBe("[mgr から: 人の指示]\n急いで");
	});

	test("to: main / from: system と reply_to", () => {
		const r = interpretHandoff({ to: "main", from: "system", brief: "改修おわり", reply_to: "system" }, exists);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.handoff.dest).toEqual({ kind: "main" });
		expect(r.handoff.text).toBe("[system から]\n改修おわり\n\n返信は state/ui/handoff-*.json の to に system を入れて送る");
		expect(r.handoff.warnings).toEqual([]);
	});

	test("to: self（自己改善 sub mgr = self impl mgr）", () => {
		const r = interpretHandoff({ to: "self", from: "mgr", brief: "eod の結果を見て" }, exists);
		expect(r.ok && r.handoff.dest).toEqual({ kind: "self" });
		expect(parseDest("self")).toEqual({ kind: "self" });
	});

	test("to: system、from なしは「不明」", () => {
		const r = interpretHandoff({ to: "system", brief: "設定を直して" }, exists);
		expect(r.ok && r.handoff.dest.kind).toBe("system");
		expect(r.ok && r.handoff.text).toBe("[不明 から]\n設定を直して");
	});

	test("to が task より優先", () => {
		const r = interpretHandoff({ to: "main", task: "tasks/見積.md", from: "見積", brief: "x" }, exists);
		expect(r.ok && r.handoff.dest.kind).toBe("main");
		expect(r.ok && r.handoff.legacy).toBe(false);
	});

	test("不正な宛先・ないタスク・空の brief はエラー", () => {
		expect(interpretHandoff({ to: "boss", brief: "x" }, exists).ok).toBe(false);
		expect(interpretHandoff({ to: "tasks/../CLAUDE.md", brief: "x" }, exists).ok).toBe(false);
		expect(interpretHandoff({ to: "tasks/ない.md", brief: "x" }, exists).ok).toBe(false);
		expect(interpretHandoff({ to: "main", brief: "  " }, exists).ok).toBe(false);
		expect(interpretHandoff({ brief: "x" }, exists).ok).toBe(false);
		expect(interpretHandoff([1], exists).ok).toBe(false);
		expect(interpretHandoff(null, exists).ok).toBe(false);
	});

	test("reply_to が不正なら注意を返して本文は届ける", () => {
		const r = interpretHandoff({ to: "main", from: "見積", brief: "x", reply_to: "誰か" }, exists);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.handoff.text).toBe("[見積 から]\nx");
		expect(r.handoff.warnings.length).toBe(1);
	});

	test("from の改行・角括弧は落とす", () => {
		const r = interpretHandoff({ to: "main", from: "a]\nb", brief: "x" }, exists);
		expect(r.ok && r.handoff.text).toBe("[a b から]\nx");
	});

	test("parseDest", () => {
		expect(parseDest(" main ")).toEqual({ kind: "main" });
		expect(parseDest("tasks/a/b.md")).toBeNull();
		expect(parseDest(3)).toBeNull();
	});
});

describe("compact", () => {
	const line = (o: unknown) => JSON.stringify(o);
	const asst = (n: number, extra: Record<string, unknown> = {}) =>
		line({ type: "assistant", isSidechain: false, message: { model: "claude-sonnet-5-5", usage: { input_tokens: 2, cache_read_input_tokens: n, cache_creation_input_tokens: 10 } }, ...extra });

	test("末尾の assistant の usage を足す", () => {
		expect(tokensFromTail([asst(1000), line({ type: "user" }), asst(157430), ""].join("\n"))).toBe(157442);
	});

	test("サイドチェーンと <synthetic> は飛ばす", () => {
		const synthetic = line({ type: "assistant", message: { model: "<synthetic>", usage: { input_tokens: 0 } } });
		expect(tokensFromTail([asst(50000), asst(1, { isSidechain: true }), synthetic].join("\n"))).toBe(50012);
	});

	test("compact の境目より後に assistant がなければ compact 後の大きさ", () => {
		const b = line({ type: "system", subtype: "compact_boundary", compactMetadata: { postTokens: 7252 } });
		expect(tokensFromTail([asst(900000), b].join("\n"))).toBe(7252);
		expect(tokensFromTail([asst(900000), b, asst(9000)].join("\n"))).toBe(9012);
	});

	test("先頭の切れた境目の行は 0", () => {
		expect(tokensFromTail([asst(900000), '"isSidechain":false,"type":"system","subtype":"compact_boundary","content":"Conv'].join("\n"))).toBe(0);
	});

	test("記録がなければ null", () => {
		expect(tokensFromTail("")).toBeNull();
	});

	test("autocompactEnv は 0 なら付けない", () => {
		const s = { autocompactPct: 60, autocompactWindow: 200000 } as AppSettings;
		expect(autocompactEnv(s)).toEqual({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "60", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000" });
		expect(autocompactEnv({ ...s, autocompactPct: 0, autocompactWindow: 0 })).toEqual({});
		expect(autocompactEnv({ ...s, autocompactPct: 150, autocompactWindow: 50 })).toEqual({});
	});

	test("指示文は 1 行", () => {
		for (const k of ["main", "system", "self", "task"] as const) expect(compactInstruction(k, "tasks/見積.md")).not.toContain("\n");
	});
});
