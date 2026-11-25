import { describe, expect, test } from "bun:test";
import type { PersonNote, PjNote } from "../shared/types";
import {
	GAP_X,
	GAP_Y,
	backlogLabel,
	buildGraph,
	collectEdges,
	hierLayout,
	membership,
	personDetail,
	personId,
	pjId,
	sortRows,
	tableRows,
} from "./people-view";

const person = (name: string, fm: Record<string, string> = {}, rels: PersonNote["rels"] = []): PersonNote => ({
	path: `memory/people/${name}.md`,
	name,
	fm: { kind: "社内", status: "現役", ...fm },
	rels,
	profile: [],
	mtime: 1,
});
const pj = (name: string, members: string[], links: PjNote["links"] = []): PjNote => ({
	path: `memory/pj/${name}.md`,
	name,
	fm: { type: "pj", project: name },
	summary: [],
	members: members.map((m) => ({ name: m, role: `${m}の役` })),
	links,
	mtime: 1,
});

const people = [
	person("石井", { org: "AQ", slack_name: "Ishii", backlog: "登録", backlog_user: "1", updated: "2026-11-25" }, [
		{ rel: "member_of", to: "甲" },
		{ rel: "works_with", to: "小甲" },
		{ rel: "reports_to", to: "不明な人" },
	]),
	person("荒川", { org: "AQ", backlog: "未登録", updated: "2026-11-20" }, [{ rel: "member_of", to: "甲" }]),
	person("小甲", { kind: "外部", org: "他社", backlog: "未確認" }, [{ rel: "works_with", to: "石井" }]),
	person("旧人", { status: "退役" }),
	person("別人", {}, [{ rel: "member_of", to: "乙" }]),
];
const pjs = [
	pj("甲", ["石井", "荒川", "小甲"], [
		{ rel: "commands", from: "石井", to: "荒川", note: "" },
		{ rel: "works_with", from: "石井", to: "小甲", note: "" },
	]),
	pj("乙", ["別人"]),
];

describe("エッジの収集", () => {
	const edges = collectEdges(people, pjs);
	test("見つからない相手は捨て、同じ組は 1 本（works_with は向き無視）", () => {
		expect(edges.filter((e) => e.rel === "works_with")).toHaveLength(1);
		expect(edges.some((e) => e.b === "不明な人")).toBe(false);
		expect(edges.filter((e) => e.rel === "member_of" && e.b === "甲")).toHaveLength(3);
	});
	test("PJ ノート由来には pj が付く", () => {
		expect(edges.find((e) => e.rel === "commands")?.pj).toBe("甲");
		expect(edges.find((e) => e.rel === "works_with")?.pj).toBe("甲");
	});
});

describe("所属", () => {
	test("PJ の member 行と member_of をまとめる", () => {
		const ms = membership(people, pjs);
		expect(ms.get("石井")).toEqual([{ pj: "甲", role: "石井の役" }]);
		expect(ms.get("別人")).toEqual([{ pj: "乙", role: "別人の役" }]);
		expect(ms.get("旧人")).toBeUndefined();
	});
});

describe("グラフ（全体）", () => {
	const g = buildGraph(people, pjs, { pj: "", retired: false });
	test("退役を隠し、人物と PJ のノード", () => {
		expect(g.nodes.map((n) => n.id).sort()).toEqual([personId("別人"), personId("小甲"), personId("石井"), personId("荒川"), pjId("乙"), pjId("甲")].sort());
		expect(g.fixed).toBe(false);
	});
	test("社内/外部の色、PJ の縁取り、PJ は別形", () => {
		const n = (id: string) => g.nodes.find((x) => x.id === id)!;
		expect(n(personId("石井")).fill).not.toBe(n(personId("小甲")).fill);
		expect(n(personId("石井")).ring).toBe(n(pjId("甲")).ring);
		expect(n(pjId("甲")).shape).toBe("square");
		expect(n(personId("石井")).kind).toBe("person");
	});
	test("commands は矢印、works_with は破線で矢印なし", () => {
		const cmd = g.edges.find((e) => e.label === "指示")!;
		expect([cmd.a, cmd.b, cmd.arrow]).toEqual([personId("石井"), personId("荒川"), true]);
		const wk = g.edges.find((e) => e.label === "協働")!;
		expect(wk.arrow).toBeUndefined();
		expect(wk.dash).toBeDefined();
	});
	test("関係者のいない PJ は全体の図に出さない", () => {
		const g2 = buildGraph(people, [...pjs, pj("丙", [])], { pj: "", retired: false });
		expect(g2.nodes.some((n) => n.id === pjId("丙"))).toBe(false);
	});
	test("退役を含めると増える（薄く出す）", () => {
		const g2 = buildGraph(people, pjs, { pj: "", retired: true });
		expect(g2.nodes.find((n) => n.id === personId("旧人"))?.dim).toBe(true);
	});
});

describe("グラフ（プロジェクトで絞る）", () => {
	const g = buildGraph(people, pjs, { pj: "甲", retired: false });
	test("その PJ の関係者と PJ だけ", () => {
		expect(g.nodes.map((n) => n.id).sort()).toEqual([personId("小甲"), personId("石井"), personId("荒川"), pjId("甲")].sort());
		expect(g.fixed).toBe(true);
	});
	test("指揮の上が上、PJ が最上段、弧のない人は最下段", () => {
		const y = (id: string) => g.nodes.find((n) => n.id === id)!.y!;
		expect(y(pjId("甲"))).toBe(0);
		expect(y(personId("石井"))).toBe(GAP_Y);
		expect(y(personId("荒川"))).toBe(2 * GAP_Y);
		expect(y(personId("小甲"))).toBe(3 * GAP_Y);
	});
	test("PJ からは階層の最上位にだけ線を引く", () => {
		const fromPj = g.edges.filter((e) => e.a === pjId("甲"));
		expect(fromPj.map((e) => e.b)).toEqual([personId("石井")]);
	});
	test("存在しない PJ は全体に戻る", () => {
		expect(buildGraph(people, pjs, { pj: "無い", retired: false }).fixed).toBe(false);
	});
});

describe("階層レイアウト", () => {
	test("最長経路の深さで層に分ける", () => {
		const m = hierLayout(["a", "b", "c", "d"], [
			{ from: "a", to: "b" },
			{ from: "b", to: "c" },
			{ from: "a", to: "c" },
		]);
		expect([m.get("a")!.level, m.get("b")!.level, m.get("c")!.level, m.get("d")!.level]).toEqual([0, 1, 2, 3]);
	});
	test("同じ層は左右に並び、中心に寄る", () => {
		const m = hierLayout(["r", "x", "y"], [
			{ from: "r", to: "x" },
			{ from: "r", to: "y" },
		]);
		expect(m.get("x")!.x).toBe(-GAP_X / 2);
		expect(m.get("y")!.x).toBe(GAP_X / 2);
		expect(m.get("r")!.x).toBe(0);
	});
	test("循環があっても止まる", () => {
		const m = hierLayout(["a", "b"], [
			{ from: "a", to: "b" },
			{ from: "b", to: "a" },
		]);
		expect(m.get("a")!.level).toBe(0);
		expect(m.get("b")!.level).toBe(1);
	});
	test("弧がなければ全員同じ行", () => {
		const m = hierLayout(["a", "b"], []);
		expect(m.get("a")!.y).toBe(0);
		expect(m.get("b")!.y).toBe(0);
	});
	test("reports_to は報告先が上（hierArcs 経由）", () => {
		const g = buildGraph(
			[person("上"), person("下")],
			[pj("P", ["上", "下"], [{ rel: "reports_to", from: "下", to: "上", note: "" }])],
			{ pj: "P", retired: false },
		);
		expect(g.nodes.find((n) => n.id === personId("上"))!.y!).toBeLessThan(g.nodes.find((n) => n.id === personId("下"))!.y!);
	});
});

describe("表", () => {
	const rows = tableRows(people, pjs, { pj: "", retired: false });
	test("列の値（未登録・未確認の表記）", () => {
		const r = (n: string) => rows.find((x) => x.name === n)!;
		expect(r("石井")).toMatchObject({ kind: "社内", org: "AQ", slack: "Ishii", backlog: "登録（1）", projects: ["甲"], updated: "2026-11-25" });
		expect(r("荒川").backlog).toBe("—未登録");
		expect(r("小甲").backlog).toBe("未確認");
		expect(r("小甲").slack).toBe("—");
		expect(rows.some((x) => x.name === "旧人")).toBe(false);
	});
	test("プロジェクトで絞ると役割はその PJ のもの", () => {
		const r = tableRows(people, pjs, { pj: "甲", retired: false });
		expect(r.map((x) => x.name).sort()).toEqual(["小甲", "石井", "荒川"]);
		expect(r.find((x) => x.name === "石井")!.role).toBe("石井の役");
	});
	test("並べ替え（昇順・降順、空は最後）", () => {
		expect(sortRows(rows, "updated", 1).map((x) => x.name).slice(0, 2)).toEqual(["荒川", "石井"]);
		expect(sortRows(rows, "updated", -1).map((x) => x.name).slice(0, 2)).toEqual(["石井", "荒川"]);
		expect(sortRows(rows, "updated", -1).at(-1)!.updated).toBe("—");
		expect(sortRows(rows, "name", 1).map((x) => x.name)).toEqual([...rows.map((x) => x.name)].sort((a, b) => a.localeCompare(b, "ja")));
	});
	test("backlogLabel", () => {
		expect(backlogLabel(person("x", { backlog: "登録" }))).toBe("登録");
		expect(backlogLabel(person("x", {}))).toBe("未確認");
	});
});

describe("詳細", () => {
	test("所属プロジェクトと関係（PJ 以外）", () => {
		const d = personDetail(people[0]!, people, pjs);
		expect(d.projects).toEqual([{ pj: "甲", role: "石井の役" }]);
		expect(d.relations.map((r) => [r.label, r.other, r.dir]).sort()).toEqual([["協働", "小甲", "both"], ["指示", "荒川", "to"]].sort());
		expect(personDetail(people[1]!, people, pjs).relations).toEqual([{ rel: "commands", label: "指示", other: "石井", dir: "from" }]);
	});
});
