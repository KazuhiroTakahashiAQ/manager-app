import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isUnanswered, unansweredCount } from "../shared/now";
import {
	parseNowJson,
	parseOptions,
	pickDoing,
	readNow,
	replyBrief,
	replyInquiry,
	replyValue,
	sectionMd,
	setFrontmatter,
	taskRefToPath,
} from "./now";

const dirs: string[] = [];
const mk = () => {
	const d = mkdtempSync(join(tmpdir(), "now-"));
	dirs.push(d);
	for (const s of ["tasks", "messages", "research", "state/ui"]) mkdirSync(join(d, s), { recursive: true });
	return d;
};
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const task = (status: string, due: string, extra = "") =>
	`---\ntype: task\nstatus: ${status}\ndue: ${due}\nnext_action: 次の一手\nwaiting_for: \n---\n## 背景\nx\n\n## 完了条件\n- 共有する\n\n## 手順\n- [ ] 調べる\n<!-- c -->\n\n## メモ\n${extra}`;

describe("共有の判定", () => {
	test("isUnanswered", () => {
		expect(isUnanswered({ from: "main", status: "未読" })).toBe(true);
		expect(isUnanswered({ from: "tasks/a.md", status: "対応中" })).toBe(true);
		expect(isUnanswered({ from: "main", status: "完了" })).toBe(false);
		expect(isUnanswered({ from: "", status: "未読" })).toBe(false);
		expect(isUnanswered({ status: "未読" })).toBe(false);
		expect(unansweredCount([{ fm: { from: "main", status: "未読" } }, { fm: { status: "未読" } }])).toBe(1);
	});
});

describe("now.json の解釈", () => {
	test("task は tasks/<名>.md と素の名前の両方", () => {
		expect(taskRefToPath("tasks/A_b.md")).toBe("tasks/A_b.md");
		expect(taskRefToPath("A_b")).toBe("tasks/A_b.md");
		expect(taskRefToPath("A_b.md")).toBe("tasks/A_b.md");
		expect(taskRefToPath("../x")).toBeNull();
		expect(taskRefToPath("tasks/a/b.md")).toBeNull();
		expect(taskRefToPath("")).toBeNull();
		expect(taskRefToPath(3)).toBeNull();
	});
	test("parseNowJson", () => {
		expect(parseNowJson('{"task":"X","reason":"r","set_by":"main"}')).toEqual({ task: "tasks/X.md", reason: "r" });
		expect(parseNowJson("{broken")).toBeNull();
		expect(parseNowJson("{}")).toBeNull();
	});
	test("pickDoing は期限が最も近い doing（期限なしは最後）", () => {
		const t = (path: string, status: string, due: string) => ({ path, fm: { status, due } });
		expect(pickDoing([t("tasks/a.md", "doing", "2026-12-01"), t("tasks/b.md", "doing", "2026-11-20"), t("tasks/c.md", "todo", "2026-11-01")])?.path).toBe("tasks/b.md");
		expect(pickDoing([t("tasks/a.md", "doing", ""), t("tasks/b.md", "doing", "2026-12-31")])?.path).toBe("tasks/b.md");
		expect(pickDoing([t("tasks/a.md", "todo", "")])).toBeNull();
	});
});

describe("本文・frontmatter", () => {
	test("sectionMd はコメントを除く", () => {
		const body = "## 完了条件\n- a\n\n## 手順\n- [ ] b\n<!-- c -->\n\n## メモ\nz";
		expect(sectionMd(body, "完了条件")).toBe("- a");
		expect(sectionMd(body, "手順")).toBe("- [ ] b");
		expect(sectionMd(body, "なし")).toBe("");
	});
	test("parseOptions: 1 行と列の両方", () => {
		expect(parseOptions('---\noptions: [はい, "いいえ, 後で", \'保留\']\nfrom: main\n---\n')).toEqual(["はい", "いいえ, 後で", "保留"]);
		expect(parseOptions("---\noptions:\n  - A\n  - \"B\"\nfrom: x\n---\n")).toEqual(["A", "B"]);
		expect(parseOptions("---\noptions: []\n---\n")).toEqual([]);
		expect(parseOptions("---\nfrom: x\n---\n")).toEqual([]);
	});
	test("setFrontmatter は置き換えと追加", () => {
		const src = "---\nstatus: 未読\nreply: \n---\n本文\nstatus: x";
		expect(setFrontmatter(src, "status", "完了")).toBe("---\nstatus: 完了\nreply: \n---\n本文\nstatus: x");
		expect(setFrontmatter("---\na: 1\n---\nb", "reply", '"x"')).toBe('---\na: 1\nreply: "x"\n---\nb');
		expect(setFrontmatter("本文だけ", "a", "b")).toBe("本文だけ");
	});
	test("replyValue は 1 行の YAML 文字列", () => {
		expect(replyValue("はい\n理由: a #b ")).toBe('"はい 理由: a #b"');
	});
});

describe("readNow", () => {
	test("now.json のタスクを出す（素の名前）。reason つき・仮でない", () => {
		const d = mk();
		writeFileSync(join(d, "tasks", "T1.md"), task("todo", "2026-11-30"));
		writeFileSync(join(d, "research", "T1.md"), "x");
		writeFileSync(join(d, "state/ui/now.json"), '{"task":"T1","reason":"今これ","set_by":"main","set_at":"x"}');
		const f = readNow(d).focus!;
		expect(f.taskPath).toBe("tasks/T1.md");
		expect(f.provisional).toBe(false);
		expect(f.reason).toBe("今これ");
		expect(f.nextAction).toBe("次の一手");
		expect(f.goalMd).toBe("- 共有する");
		expect(f.stepsMd).toBe("- [ ] 調べる");
		expect(f.research).toBe("research/T1.md");
	});
	test("now.json がなければ doing の最も近い期限を仮で出す", () => {
		const d = mk();
		writeFileSync(join(d, "tasks", "A.md"), task("doing", "2026-12-10"));
		writeFileSync(join(d, "tasks", "B.md"), task("doing", "2026-11-18"));
		writeFileSync(join(d, "tasks", "C.md"), task("todo", "2026-11-01"));
		const f = readNow(d).focus!;
		expect(f.taskPath).toBe("tasks/B.md");
		expect(f.provisional).toBe(true);
		expect(f.research).toBeNull();
	});
	test("now.json のタスクがなければ仮に落ち、理由を note に", () => {
		const d = mk();
		writeFileSync(join(d, "tasks", "A.md"), task("doing", ""));
		writeFileSync(join(d, "state/ui/now.json"), '{"task":"消えた"}');
		const f = readNow(d).focus!;
		expect(f.taskPath).toBe("tasks/A.md");
		expect(f.provisional).toBe(true);
		expect(f.note).toContain("消えた");
	});
	test("何もなければ focus は null。now.json は書き換えない", () => {
		const d = mk();
		expect(readNow(d).focus).toBeNull();
		const p = join(d, "state/ui/now.json");
		writeFileSync(p, '{"task":"x"}');
		readNow(d);
		expect(readFileSync(p, "utf-8")).toBe('{"task":"x"}');
	});
	test("問い合わせは from があって未読・対応中のものだけ", () => {
		const d = mk();
		const m = (name: string, fmText: string) => writeFileSync(join(d, "messages", name), `---\ntype: message\nkind: 確認\n${fmText}\n---\n## 要件\n聞きたい`);
		m("2026-11-16-1000-a.md", "status: 未読\nfrom: main\noptions: [はい, いいえ]");
		m("2026-11-16-1100-b.md", "status: 対応中\nfrom: tasks/T.md\noptions: []");
		m("2026-11-16-1200-c.md", "status: 完了\nfrom: main");
		m("2026-11-16-1300-d.md", "status: 未読\nfrom: ");
		const q = readNow(d).inquiries;
		expect(q.map((x) => x.title)).toEqual(["b", "a"]);
		expect(q[1]?.options).toEqual(["はい", "いいえ"]);
		expect(q[0]?.options).toEqual([]);
		expect(q[1]?.bodyMd).toContain("聞きたい");
	});
});

describe("replyInquiry", () => {
	const msg = (d: string, from: string, status = "未読") => {
		const p = "messages/2026-11-16-1000-q.md";
		writeFileSync(join(d, p), `---\ntype: message\nkind: 確認\nstatus: ${status}\nreply: \nfrom: ${from}\noptions: [はい]\n---\n## 要件\n本文`);
		return p;
	};
	const handoffs = (d: string) => readdirSync(join(d, "state/ui")).filter((f) => /^handoff-.*\.json$/.test(f));

	test("宛先が開いていれば reply・完了・handoff", () => {
		const d = mk();
		const p = msg(d, "tasks/T.md");
		const r = replyInquiry(d, p, "はい", (dest) => dest.kind === "task" && dest.taskPath === "tasks/T.md", new Date(2026, 10, 16, 21, 5, 9));
		expect(r).toEqual({ ok: true, delivered: true });
		const note = readFileSync(join(d, p), "utf-8");
		expect(note).toContain('reply: "はい"');
		expect(note).toContain("status: 完了");
		expect(note).toContain("本文");
		expect(handoffs(d)).toEqual(["handoff-20261116-210509-reply.json"]);
		const h = JSON.parse(readFileSync(join(d, "state/ui", handoffs(d)[0]!), "utf-8"));
		expect(h.to).toBe("tasks/T.md");
		expect(h.brief).toBe(replyBrief(p, "q", "はい"));
		expect(readNow(d).inquiries).toEqual([]);
	});
	test("宛先が閉じていれば対応中のまま reply に残し、handoff は置かない", () => {
		const d = mk();
		const p = msg(d, "system");
		expect(replyInquiry(d, p, "いいえ", () => false)).toEqual({ ok: true, delivered: false });
		expect(readFileSync(join(d, p), "utf-8")).toContain("status: 対応中");
		expect(handoffs(d)).toEqual([]);
		const q = readNow(d).inquiries[0]!;
		expect(q.reply).toBe("いいえ");
		expect(q.status).toBe("対応中");
	});
	test("worker など宛先にできない from は届けず対応中のまま", () => {
		const d = mk();
		const p = msg(d, "worker:researcher");
		expect(replyInquiry(d, p, "はい", () => true).delivered).toBe(false);
		expect(handoffs(d)).toEqual([]);
	});
	test("不正なパス・空の返信・片付いた問い合わせは拒否", () => {
		const d = mk();
		const p = msg(d, "main");
		expect(replyInquiry(d, "../x.md", "a", () => true).ok).toBe(false);
		expect(replyInquiry(d, "tasks/a.md", "a", () => true).ok).toBe(false);
		expect(replyInquiry(d, p, "  ", () => true).ok).toBe(false);
		const done = msg(d, "main", "完了");
		expect(replyInquiry(d, done, "a", () => true).ok).toBe(false);
	});
});
