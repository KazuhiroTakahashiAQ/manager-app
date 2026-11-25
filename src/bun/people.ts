// memory/people/（人物ノート）と memory/pj/（プロジェクトノート）の読み取り。書式は vault の docs/schema.md
// 「人物ノートとプロジェクトの関係者」。md が正で、BM の SQLite は読まない。

import type { OrgNote, PersonNote, PjNote } from "../shared/types";
import { parseNote } from "./vault";

/** 人物ノートの relation 語彙（これ以外の行は拾わない） */
const PERSON_REL = /^-\s+(member_of|belongs_to|reports_to|works_with|client_of|introduced_by)\s+\[\[(.+?)(\|.*?)?\]\](?:\s+[—–-]+\s*(.*))?/;
const PJ_MEMBER = /^-\s+member\s+\[\[(.+?)(?:\|.*?)?\]\](?:\s+[—–-]+\s*(.*))?$/;
const PJ_LINK = /^-\s+(commands|reports_to|works_with)\s+\[\[(.+?)(?:\|.*?)?\]\]\s+(?:->|→)\s+\[\[(.+?)(?:\|.*?)?\]\](?:\s+[—–-]+\s*(.*))?$/;

/** [[名前#見出し]] → 名前 */
function target(s: string): string {
	return s.replace(/#.*$/, "").trim();
}

/** `## <見出し>` から次の `## ` までの行。見出しは前方一致（「## 要約（まずここだけ読む…）」のような注記つきも拾う） */
export function sectionLines(body: string, heading: string): string[] {
	const lines = body.split("\n");
	const start = lines.findIndex((l) => l.trim().startsWith(`## ${heading}`) || l.trim().startsWith(`##${heading}`));
	if (start < 0) return [];
	const out: string[] = [];
	for (const l of lines.slice(start + 1)) {
		if (/^##\s/.test(l)) break;
		out.push(l);
	}
	return out;
}

const nameOf = (path: string) => path.split("/").pop()!.replace(/\.md$/, "");

export function parsePerson(path: string, text: string, mtime = 0): PersonNote {
	const { fm, body } = parseNote(text);
	const rels: PersonNote["rels"] = [];
	for (const l of body.split("\n")) {
		const m = PERSON_REL.exec(l.trim());
		if (m) rels.push({ rel: m[1]!, to: target(m[2]!), ...(m[4]?.trim() ? { note: m[4].trim() } : {}) });
	}
	const profile = sectionLines(body, "Observations")
		.map((l) => l.trim())
		.filter((l) => l.startsWith("- "))
		.map((l) => l.slice(2))
		.slice(0, 8);
	return { path, name: fm["name"] || fm["title"] || nameOf(path), fm, rels, profile, mtime };
}

/** type: pj のノートだけ PjNote にする（経緯ログ pj-log などは null）。name は `[[…]]` が指すノート名（ファイル名） */
export function parsePj(path: string, text: string, mtime = 0): PjNote | null {
	const { fm, body } = parseNote(text);
	if (fm["type"] !== "pj") return null;
	const members: PjNote["members"] = [];
	const links: PjNote["links"] = [];
	for (const raw of sectionLines(body, "関係者")) {
		const l = raw.trim();
		const m = PJ_MEMBER.exec(l);
		if (m) {
			members.push({ name: target(m[1]!), role: (m[2] ?? "").trim() });
			continue;
		}
		const k = PJ_LINK.exec(l);
		if (k) links.push({ rel: k[1] as PjNote["links"][number]["rel"], from: target(k[2]!), to: target(k[3]!), note: (k[4] ?? "").trim() });
	}
	const summary = sectionLines(body, "要約")
		.map((l) => l.trimEnd())
		.filter((l) => l.trim() && !l.trim().startsWith("<!--"))
		.slice(0, 12);
	return { path, name: nameOf(path), fm, summary, members, links, mtime };
}

/** `[[名前]]` / `[[名前|別名]]` / 素の文字列 → ノート名。空は "" */
export function linkName(v: string | undefined): string {
	const m = /^\s*\[\[(.+?)(?:\|.*?)?\]\]\s*$/.exec(v ?? "");
	return target(m ? m[1]! : (v ?? ""));
}

/** type: org のノートだけ OrgNote にする。parent は `[[親]]` でも素の名前でもよい */
export function parseOrg(path: string, text: string, mtime = 0): OrgNote | null {
	const { fm } = parseNote(text);
	if (fm["type"] !== "org") return null;
	const name = nameOf(path);
	const parent = linkName(fm["parent"]);
	return { path, name, fm, parent: parent === name ? "" : parent, mtime };
}
