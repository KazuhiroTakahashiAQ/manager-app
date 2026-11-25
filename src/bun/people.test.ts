import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Vault } from "./vault";
import { parsePerson, parsePj, sectionLines } from "./people";

const PERSON = `---
title: 石井智也
type: person
name: 石井智也
kind: 社内              # 社内 / 外部
org: アジアクエスト
role: 進行・先方窓口
slack_id: U03CQ2ANW4E
backlog_user: 1046467
backlog: 登録
status: 現役
updated: 2026-11-25
---
# 石井智也
## Observations
- [role] 進行を担う #slack
- [fact] 先方窓口

## Relations
- member_of [[PJ甲]]
- reports_to [[上長|別名]]
- works_with [[小甲達也#見出し]]
- relates_to [[プロフィール]]
- client_of
`;

const PJ = `---
title: PJ甲
type: pj
project: PJ甲
status: 進行中
customer: 甲社
---
## 要約（まずここだけ読む）
- 目的: 試す
- 現在: 進行中

## 関係者
書式の説明の地の文。
- member [[石井智也]] — 進行・窓口
- member [[荒川哲也]]
- commands [[石井智也]] -> [[荒川哲也]] — 根拠あり
- reports_to [[荒川哲也]] → [[石井智也]]
- works_with [[髙橋一広]] -> [[荒川哲也]]
- commands 壊れた行

## 依頼・情報提供の履歴
- member [[履歴の中は読まない]]
`;

describe("parsePerson", () => {
	const p = parsePerson("memory/people/石井智也.md", PERSON, 5);
	test("frontmatter", () => {
		expect(p.name).toBe("石井智也");
		expect(p.fm["kind"]).toBe("社内");
		expect(p.fm["backlog_user"]).toBe("1046467");
		expect(p.mtime).toBe(5);
	});
	test("relation は語彙のものだけ、別名と見出しは落とす", () => {
		expect(p.rels).toEqual([
			{ rel: "member_of", to: "PJ甲" },
			{ rel: "reports_to", to: "上長" },
			{ rel: "works_with", to: "小甲達也" },
		]);
	});
	test("プロフィールは Observations の行", () => {
		expect(p.profile).toEqual(["[role] 進行を担う #slack", "[fact] 先方窓口"]);
	});
});

describe("parsePj", () => {
	const j = parsePj("memory/pj/PJ甲.md", PJ)!;
	test("member（役割は任意）", () => {
		expect(j.members).toEqual([
			{ name: "石井智也", role: "進行・窓口" },
			{ name: "荒川哲也", role: "" },
		]);
	});
	test("commands / reports_to / works_with（-> と →、根拠）", () => {
		expect(j.links).toEqual([
			{ rel: "commands", from: "石井智也", to: "荒川哲也", note: "根拠あり" },
			{ rel: "reports_to", from: "荒川哲也", to: "石井智也", note: "" },
			{ rel: "works_with", from: "髙橋一広", to: "荒川哲也", note: "" },
		]);
	});
	test("要約は注記つきの見出しでも読める", () => {
		expect(j.summary).toEqual(["- 目的: 試す", "- 現在: 進行中"]);
	});
	test("type: pj 以外は null", () => {
		expect(parsePj("x.md", "---\ntype: pj-log\n---\n## 関係者\n")).toBeNull();
		expect(parsePj("x.md", "本文だけ")).toBeNull();
	});
	test("sectionLines は見出しがなければ空", () => {
		expect(sectionLines("# a", "関係者")).toEqual([]);
	});
});

describe("Vault.people / projects", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
	});
	test("列挙し、変更後の再読込（scan）に反映される", () => {
		const d = mkdtempSync(join(tmpdir(), "people-"));
		dirs.push(d);
		const root = join(d, "Manager");
		mkdirSync(join(root, "memory", "people"), { recursive: true });
		mkdirSync(join(root, "memory", "pj"), { recursive: true });
		writeFileSync(join(root, "memory", "people", "石井智也.md"), PERSON);
		writeFileSync(join(root, "memory", "pj", "PJ甲.md"), PJ);
		writeFileSync(join(root, "memory", "pj", "PJ甲_経緯.md"), "---\ntype: pj-log\n---\n");
		const v = new Vault(root);
		expect(v.people().map((p) => p.name)).toEqual(["石井智也"]);
		expect(v.projects().map((p) => p.name)).toEqual(["PJ甲"]);
		expect(v.scan().people).toHaveLength(1);
		writeFileSync(join(root, "memory", "people", "荒川哲也.md"), "---\ntype: person\nname: 荒川哲也\n---\n");
		expect(v.scan().people).toHaveLength(2);
	});
});

const REAL = "/Users/kazuhiro.takahashi/Documents/Obsidian Vault/Manager";
describe.skipIf(!existsSync(join(REAL, "memory", "people")))("実データ", () => {
	test("4 人 + 1 PJ を読める", () => {
		const v = new Vault(REAL);
		const people = v.people();
		expect(people.map((p) => p.name).sort()).toEqual(["小甲達也", "石井智也", "荒川哲也", "髙橋一広"].sort());
		const pj = v.projects().find((p) => p.name === "ダイダン施工図自動作成")!;
		expect(pj.members.map((m) => m.name)).toEqual(["髙橋一広", "石井智也", "荒川哲也", "小甲達也"]);
		expect(pj.links.map((l) => l.rel)).toEqual(["commands", "works_with", "works_with"]);
	});
});
