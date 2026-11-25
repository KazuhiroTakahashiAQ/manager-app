import { describe, expect, test } from "bun:test";
import type { OrgNote, PersonNote } from "../shared/types";
import { parseOrg, parsePerson } from "../bun/people";
import { affiliations, buildOrgGraph, descendants, orgLabel, orgPath, orgTree, peopleIn, treeRows } from "./org-view";
import { tableRows } from "./people-view";

const org = (name: string, parent = "", fm: Record<string, string> = {}): OrgNote => ({
	path: `memory/org/${name}.md`,
	name,
	fm: { type: "org", kind: "部", side: "社内", ...fm },
	parent,
	mtime: 1,
});
const person = (name: string, fm: Record<string, string> = {}, rels: PersonNote["rels"] = []): PersonNote => ({
	path: `memory/people/${name}.md`,
	name,
	fm: { kind: "社内", status: "現役", ...fm },
	rels,
	profile: [],
	mtime: 1,
});

const orgs = [org("AQ", "", { kind: "会社" }), org("開発部", "AQ"), org("第一課", "開発部", { kind: "課" }), org("AIグループ", "第一課", { kind: "グループ" }), org("営業部", "AQ")];
const people = [
	person("甲", { org: "[[AIグループ]]", post: "リーダー" }),
	person("乙", { org: "第一課" }, [{ rel: "belongs_to", to: "営業部", note: "兼務の担当" }]),
	person("丙", { org: "営業部" }),
	person("丁", { org: "どこかの会社" }),
	person("戊", { org: "AQ", status: "退役" }),
];

describe("parseOrg / parsePerson", () => {
	test("type: org だけ読み、parent の [[ ]] を外す。自己参照は最上位", () => {
		const o = parseOrg("memory/org/第一課.md", "---\ntype: org\nkind: 課\nparent: \"[[開発部]]\"\n---\n", 5)!;
		expect(o.parent).toBe("開発部");
		expect(o.name).toBe("第一課");
		expect(parseOrg("memory/org/x.md", "---\ntype: pj\n---\n")).toBeNull();
		expect(parseOrg("memory/org/自分.md", "---\ntype: org\nparent: 自分\n---\n")!.parent).toBe("");
	});
	test("belongs_to の役職を note に取る", () => {
		const p = parsePerson("memory/people/a.md", "---\nname: a\n---\n## Relations\n- belongs_to [[営業部]] — 課長\n- belongs_to [[別部]]\n");
		expect(p.rels).toEqual([{ rel: "belongs_to", to: "営業部", note: "課長" }, { rel: "belongs_to", to: "別部" }]);
	});
});

describe("所属の解決", () => {
	test("主所属 + 兼務。解決できない文字列はそのまま（resolved false）", () => {
		expect(affiliations(people[0]!, orgs)).toEqual([{ name: "AIグループ", resolved: true, primary: true, post: "リーダー" }]);
		expect(affiliations(people[1]!, orgs).map((a) => [a.name, a.primary, a.post])).toEqual([["第一課", true, ""], ["営業部", false, "兼務の担当"]]);
		expect(affiliations(people[3]!, orgs)[0]).toMatchObject({ name: "どこかの会社", resolved: false });
		expect(affiliations(person("空"), orgs)).toEqual([]);
	});
	test("階層の表記と、循環に耐える", () => {
		expect(orgLabel("AIグループ", orgs)).toBe("AQ / 開発部 / 第一課 / AIグループ");
		expect(orgLabel("どこかの会社", orgs)).toBe("どこかの会社");
		const loop = [org("A", "B"), org("B", "A")];
		expect(orgPath("A", loop).length).toBe(2);
		expect([...descendants("A", loop)].sort()).toEqual(["A", "B"]);
	});
});

describe("組織で絞る（配下を含む）", () => {
	test("部を選ぶと課・グループ・兼務の人も入る", () => {
		expect(peopleIn("開発部", people, orgs).map((p) => p.name)).toEqual(["甲", "乙"]);
		expect(peopleIn("営業部", people, orgs).map((p) => p.name)).toEqual(["乙", "丙"]);
		expect(peopleIn("AQ", people, orgs).map((p) => p.name)).toEqual(["甲", "乙", "丙", "戊"]);
		expect(peopleIn("どこかの会社", people, orgs).map((p) => p.name)).toEqual(["丁"]);
		expect(peopleIn("", people, orgs).length).toBe(5);
	});
	test("表の所属列は階層表記を渡せる。渡さなければ fm の org", () => {
		const rows = tableRows(peopleIn("開発部", people, orgs), [], { pj: "", retired: false }, (p) => affiliations(p, orgs).map((a) => orgLabel(a.name, orgs)).join("、"));
		expect(rows[0]!.org).toBe("AQ / 開発部 / 第一課 / AIグループ");
		expect(tableRows([people[2]!], [], { pj: "", retired: false })[0]!.org).toBe("営業部");
	});
});

describe("組織ツリー", () => {
	test("人数は直接と配下（重複なし）。退役は既定で数えない。未解決の文字列は最上位の葉", () => {
		const t = orgTree(orgs, people);
		const aq = t.find((n) => n.name === "AQ")!;
		expect(aq.direct).toBe(0);
		expect(aq.total).toBe(3); // 甲 乙 丙（戊は退役）
		const dev = aq.children.find((n) => n.name === "開発部")!;
		expect(dev.total).toBe(2);
		expect(aq.children.find((n) => n.name === "営業部")!.direct).toBe(2); // 丙 + 乙（兼務）
		expect(t.find((n) => n.name === "どこかの会社")).toMatchObject({ resolved: false, total: 1, children: [] });
		expect(orgTree(orgs, people, true).find((n) => n.name === "AQ")!.total).toBe(4);
	});
	test("親が見つからない組織・循環は最上位に", () => {
		expect(orgTree([org("孤児", "いない")], []).map((n) => n.name)).toEqual(["孤児"]);
		expect(orgTree([org("A", "B"), org("B", "A")], []).length).toBe(2);
	});
	test("折りたたむと配下の行を出さない", () => {
		const t = orgTree(orgs, people);
		expect(treeRows(t, new Set()).map((r) => r.node.name)).toContain("AIグループ");
		const rows = treeRows(t, new Set(["開発部"]));
		expect(rows.map((r) => r.node.name)).not.toContain("第一課");
		expect(rows.find((r) => r.node.name === "開発部")).toMatchObject({ depth: 1, open: false });
	});
});

describe("組織グラフ", () => {
	test("組織は親→子、人は主所属の下。兼務は破線。選んだ組織の配下だけ", () => {
		const g = buildOrgGraph(orgs, people, "開発部", false);
		expect(g.fixed).toBe(true);
		const ids = g.nodes.map((n) => n.id);
		expect(ids).toContain("o:第一課");
		expect(ids).not.toContain("o:営業部");
		expect(ids).toContain("p:乙");
		expect(g.edges.some((e) => e.a === "o:開発部" && e.b === "o:第一課" && e.arrow)).toBe(true);
		const y = (id: string) => g.nodes.find((n) => n.id === id)!.y!;
		expect(y("o:開発部")).toBeLessThan(y("o:第一課"));
		expect(y("o:第一課")).toBeLessThan(y("p:乙"));
		const all = buildOrgGraph(orgs, people, "", false);
		expect(all.edges.find((e) => e.a === "o:営業部" && e.b === "p:乙")!.dash).toBeTruthy();
		expect(all.nodes.map((n) => n.id)).toContain("o:どこかの会社");
	});
});
