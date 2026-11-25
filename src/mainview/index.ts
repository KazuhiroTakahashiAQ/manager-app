import Electrobun, { Electroview } from "electrobun/view";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { initDrop } from "./drop";
import { FileTab } from "./file-tab";
import { registerPathLinks } from "./term-links";
import { IdeaGraph, type GraphEdge, type GraphNode } from "./graph";
import { PeopleTab } from "./people-tab";
import { PEOPLE_LABEL, PEOPLE_TAB } from "./people-view";
import { childLabel, clampNameW, NAME_W_KEY, parseNameW } from "./wbs-name";
import { descendantCounts,hiddenFlags, parseCollapsed, serializeCollapsed, type FoldRow } from "./wbs-fold";
import { isRunActive, noteBusy, parseBusyAt, parseRunFold, reconcileRunFold, serializeBusyAt, serializeRunFold, setRunOpen } from "./runs-fold";
import { linePosition, lineSvg, ownLinePosition, parseLineOpts, progressRatio, rolledUpPosition, type PosNode, type Pt } from "./wbs-progress";
import { rowKindClass, runKindClass } from "./seg";
import { tabColor } from "./tab-color";
import { VTABS_DEFAULT, WAIT_LABEL, clampVtabsW, parseVtabsW, tipPosition, vtabsWFromPointer } from "./vtabs";
import { MIN_SIZE, clampRatio, gridFlex, ratioFromPointer } from "./layout";
import { docLabel, dynamicDocTabs } from "./doc-tabs";
import { SHEET_LABEL, SHEET_TAB, type SheetState, sheetHtml, sheetZoomMessage, sheetZoomStep, shouldRefreshSheet } from "./sheet-tab";
import { NOW_LABEL, NOW_TAB, canSendReply, nowBadge, shouldRefreshNow } from "./now-tab";
import { unansweredCount } from "../shared/now";
import { RELOAD_KEY, decodeReloadState, encodeReloadState, pickTerm } from "./reload-state";
import type { ActivitySpan, Doc, Inquiry, Item, LinkInfo, LookaheadTask, ManagerRPC, NowView, TermInfo, VaultState, WorkerInfo } from "../shared/types";

// ───────── RPC ─────────

const rpc = Electroview.defineRPC<ManagerRPC>({
	maxRequestTime: 15000,
	handlers: {
		requests: {},
		messages: {
			termData: ({ id, data }) => onTermData(id, data),
			shellData: ({ id, data }) => shellTvs.get(id)?.term.write(data),
			termsChanged: (list) => onTerms(list),
			workersChanged: (list) => {
				workers = list;
				renderTabs();
				renderBoard();
			},
			linksChanged: (map) => {
				links = map;
				renderBoard();
			},
			handoff: ({ id, title, from, focus }) => {
				// mgr からタスクの sub mgr への引き継ぎ・指示は、受け渡し先を前に出す（従来どおり）
				if (focus) {
					void showTerm(id);
					toast(`「${title}」の sub mgr に渡した`);
					return;
				}
				// それ以外（sub mgr から mgr への報告、システム改修 sub mgr への依頼など）は人の画面を奪わず知らせるだけ
				toast(`${from} から「${title}」に届いた`, () => void showTerm(id));
			},
			nudged: ({ summary }) => {
				toast(`mgr が話しかける: ${summary}`, () => void showTerm("main"));
			},
			stateChanged: ({ paths }) => onStateChanged(paths),
			notice: ({ text, action }) => {
				toast(text, action ? () => void api.openExternal({ url: action.url }) : undefined, { label: action?.label, sticky: true });
			},
			toast: ({ text }) => toast(text),
		},
	},
});
const electrobun = new Electrobun.Electroview({ rpc });
const api = electrobun.rpc!.request;
const post = electrobun.rpc!.send;

// ───────── DOM ─────────

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const dateEl = $("date");
const factsEl = $("facts");
const boardEl = $("board");
const readerEl = $("reader");
const readerPath = $("reader-path");
const readerScroll = $("reader-scroll");
const propsEl = $("props");
const docEl = $("doc");
const tabsEl = $("tabs");
const wstripEl = $("wstrip");
const stackEl = $("stack");
const modesEl = $("modes");
const footEl = $("dock-foot");
const pinBtn = $<HTMLButtonElement>("pin");
const toastEl = $("toast");

// ───────── 画面ごとの好み（localStorage。使えなくても動く） ─────────

function load(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}
function store(key: string, value: string) {
	try {
		localStorage.setItem(key, value);
	} catch {
		// 保存できなくても続ける
	}
}

const TERM_FONT = '"JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "JetBrains Mono", "SF Mono", Menlo, "Hiragino Sans", monospace';
const DEFAULT_FONT_SIZE = 11;
let termFontSize = Number(load("termFontSize")) || DEFAULT_FONT_SIZE;

// ───────── 状態 ─────────

let state: VaultState | null = null;
let terms: TermInfo[] = [];
let currentId = "main";
let current: Doc | null = null;
let briefDoc: Doc | null = null;
let goalsDoc: Doc | null = null;

const esc = (s: string) =>
	s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function md(text: string): string {
	const pre = text
		.replace(/!\[\[([^\]]+)\]\]/g, (_m, t: string) => `<span class="embed">埋め込み: ${esc(t)}</span>`)
		.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t: string, alias?: string) => {
			const label = alias ?? t.split("/").pop()!.replace(/#.*/, "");
			return `<a href="#" data-wiki="${esc(t)}">${esc(label)}</a>`;
		});
	const html = marked.parse(pre, { gfm: true, breaks: true, async: false }) as string;
	return DOMPurify.sanitize(html);
}

// ───────── タスクの読み方（WBS と準備） ─────────

const fm = (it: Item, k: string) => it.fm[k] ?? "";
const titleOf = (it: Item) => it.name.replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, "");
const CLOSED = ["done", "dropped"];
const isOpenTask = (t: Item) => !CLOSED.includes(fm(t, "status"));
const isOpenMsg = (m: Item) => ["未読", "対応中"].includes(fm(m, "status"));
const prioRank = (p: string) => (p === "高" ? 0 : p === "中" ? 1 : 2);
const parentOf = (t: Item) => fm(t, "parent").replace(/^\[\[|\]\]$/g, "").replace(/\.md$/, "").split("/").pop() ?? "";
const md5 = (d: string) => (d ? d.slice(5).replace("-", "/") : "");

type Ready = "未定義" | "定義中" | "着手可";

/** 完了条件・手順・期限のうち、まだないもの */
function missing(t: Item): string[] {
	const out: string[] = [];
	if (!t.prep?.goal) out.push("完了条件");
	if (!t.prep?.steps) out.push("手順");
	if (!fm(t, "due")) out.push("期限");
	return out;
}

/** ready は manager が書く。空なら本文から推す */
function readiness(t: Item): Ready {
	const r = fm(t, "ready");
	if (r === "未定義" || r === "定義中" || r === "着手可") return r;
	const m = missing(t).length;
	return m === 0 ? "着手可" : m === 3 ? "未定義" : "定義中";
}

/** 準備（完了条件・手順・期限を決め切る）の期限。prep_due がなければ 着手日の前営業日、なければ期限の 3 営業日前 */
function prepDue(t: Item): string {
	if (fm(t, "prep_due")) return fm(t, "prep_due");
	if (fm(t, "start")) return backBiz(fm(t, "start"), 1);
	if (fm(t, "due")) return backBiz(fm(t, "due"), 3);
	return "";
}

function dueLabel(due: string, today: string, suffix = "まで"): { text: string; hot: boolean } | null {
	if (!due) return null;
	if (due < today) return { text: `${md5(due)} 過ぎ`, hot: true };
	if (due === today) return { text: `今日${suffix}`, hot: true };
	return { text: `${md5(due)} ${suffix}`, hot: false };
}

function byDue(a: Item, b: Item) {
	return (fm(a, "due") || "9999").localeCompare(fm(b, "due") || "9999") || prioRank(fm(a, "priority")) - prioRank(fm(b, "priority"));
}

// ───────── 盤面 ─────────

let renderPending = false;
function renderBoard() {
	if (!state) return;
	// グラフを掴んでいる間は DOM を作り直さない（離したら描き直す）
	if (graph.dragging) {
		renderPending = true;
		return;
	}
	renderPending = false;
	const s = state;
	dateEl.textContent = new Date(`${s.today}T00:00`).toLocaleDateString("ja-JP", { month: "long", day: "numeric", weekday: "short" });

	const open = s.tasks.filter(isOpenTask);
	const doing = open.filter((t) => fm(t, "status") === "doing");
	const notReady = open.filter((t) => fm(t, "status") !== "waiting" && readiness(t) !== "着手可");
	const facts = [`進行中 ${doing.length}/3`, `準備中 ${notReady.length}`];
	if (s.inboxCount) facts.push(`inbox ${s.inboxCount}`);
	factsEl.textContent = facts.join("　");

	boardEl.innerHTML = [decideHtml(s, open), selfHtml(s), prepHtml(s, notReady), ganttHtml(s), ideasHtml(s), agentsHtml(s), lowerHtml(s)].join("");
	mountGraph();
	peopleTab.setData(s.people, s.projects, s.orgs);
	drawProgressLine();
}

function decideHtml(s: VaultState, open: Item[]): string {
	const msgs = s.messages
		.filter(isOpenMsg)
		.sort((a, b) => prioRank(fm(a, "priority")) - prioRank(fm(b, "priority")) || (fm(a, "due") || "9").localeCompare(fm(b, "due") || "9"));
	const hot = open.filter((t) => fm(t, "due") && fm(t, "due") <= s.today && fm(t, "status") !== "waiting").sort(byDue);
	const rows = [
		...msgs.map((m) => row(m, `${fm(m, "kind")}${fm(m, "priority") === "高" ? "・急ぎ" : ""}`, m.summary, dueLabel(fm(m, "due"), s.today))),
		...hot.map((t) => row(t, "期限", fm(t, "next_action"), dueLabel(fm(t, "due"), s.today))),
	];
	if (!rows.length) return "";
	return `<section class="decide ${foldCls("decide")}" data-key="decide"><h2 data-fold="decide">今日決めること<span class="n">${rows.length}</span></h2><div class="fold-body">${rows.join("")}</div></section>`;
}

/** ジョブの最終実行を「最終実行 / 結果」の 2 項目にまとめる */
function jobResult(job: Item | undefined): { last: string; result: string; bad: boolean } {
	const f = job?.fm ?? {};
	const last = f["last_run"] ?? "";
	const st = f["last_status"] ?? "";
	const note = f["last_note"] ?? "";
	const result = !job ? "ジョブ未設定" : !last ? "まだ実行なし" : st === "ok" ? "実行済み" : st === "skipped" ? `スキップ${note ? `（${note}）` : ""}` : st === "error" ? "エラー" : st;
	return { last: last ? last.replace("T", " ") : "—", result, bad: st === "error" || !job };
}

/** self impl mgr のカード：自動 eod と週次の自己改善（weekly-improve）の最終実行・結果、人の判断待ちの提案。ここから固定タブ「自己改善」に入る */
function selfHtml(s: VaultState): string {
	const eod = jobResult(s.jobs.find((j) => j.name === "eod"));
	const wk = jobResult(s.jobs.find((j) => j.name === "weekly-improve"));
	const msgs = s.messages.filter((m) => isOpenMsg(m) && fm(m, "from") === "self").length;
	const line = (label: string, facts: string[], bad: boolean, btn = "") =>
		`<div class="selfrow${bad ? " bad" : ""}"><span class="sf">${esc(label)}</span><span class="sf">${facts.map(esc).join("</span><span class=\"sf\">")}</span>${btn}</div>`;
	return `<section class="selfmgr" data-key="selfmgr">
		<h2>自己改善<span class="note">self impl mgr · 自動 eod（毎日 3:00）・週次の自己改善（土日 4:00）</span></h2>
		${line("eod", [`最終実行 ${eod.last}`, `結果 ${eod.result}`, `判断待ちの提案 ${msgs}`, `retro 提案 ${s.retroPending}`], eod.bad, '<button class="selfgo" type="button" data-term="self">自己改善タブを開く</button>')}
		${line("週次", [`最終実行 ${wk.last}`, `結果 ${wk.result}`], wk.bad)}
	</section>`;
}

/** 着手の準備：完了条件・手順・期限がそろっていないタスクを、準備の期限順に */
function prepHtml(s: VaultState, notReady: Item[]): string {
	const list = [...notReady].sort((a, b) => (prepDue(a) || "9999").localeCompare(prepDue(b) || "9999"));
	const body = list.length
		? list
				.map((t) => {
					const pd = prepDue(t);
					const label = dueLabel(pd, s.today, "までに準備");
					const lack = missing(t);
					return row(t, readiness(t), lack.length ? `${lack.join("・")}が未定` : "manager の確認待ち", label ?? { text: "準備の期限なし", hot: false }, true, recoHtml(lookOf(t)));
				})
				.join("")
		: `<p class="none">すべて着手できる状態</p>`;
	return `<section class="prep ${foldCls("prep")}" data-key="prep">
		<h2 data-fold="prep">着手の準備<span class="n">${list.length || ""}</span><span class="note">完了条件・手順・期限がそろってから本着手する</span></h2>
		<div class="fold-body">${body}</div>
	</section>`;
}

function row(it: Item, kind: string, sub: string, due: { text: string; hot: boolean } | null, prep = false, reco = ""): string {
	return `<div class="row${reco ? " has-reco" : ""}">
		<button class="open" type="button" data-open="${esc(it.path)}">
			<span class="kind ${prep ? `ready-${esc(kind)}` : rowKindClass(kind, false)}">${esc(kind)}</span>
			<span class="t">${esc(titleOf(it))}</span>
			<span class="s">${esc(sub)}</span>
		</button>
		${it.fm["type"] === "task" ? taskBadges(it) : ""}
		${due ? `<span class="due${due.hot ? " hot" : ""}">${esc(due.text)}</span>` : ""}
		<button class="ask" type="button" data-ask="${esc(it.path)}"${prep ? ' data-prep="1"' : ""}>話す</button>
		${it.fm["type"] === "task" && termOfTask(it.path) ? `<button class="deep" type="button" data-deep="${esc(it.path)}">sub mgr</button>` : ""}
	</div>${reco}`;
}

// ───────── アイデア・下調べ・先読み（夜のジョブと manager が書く） ─────────

const OPEN_IDEA = ["新規", "温め中"];
const isOpenIdea = (i: Item) => OPEN_IDEA.includes(fm(i, "status") || "新規");
const ideaTitle = (i: Item) => fm(i, "title") || i.name.replace(/^\d{8}-/, "");

/** tasks/<名>.md の形にそろえる（[[…]]・拡張子なしも受ける） */
function taskRef(raw: string): string {
	let t = raw.replace(/^\[\[|\]\]$/g, "").replace(/\|.*$/, "").trim();
	if (!t) return "";
	if (!t.endsWith(".md")) t += ".md";
	return `tasks/${t.split("/").pop()}`;
}
const taskName = (path: string) => path.replace(/^tasks\//, "").replace(/\.md$/, "");

function ideasOf(taskPath: string): Item[] {
	return (state?.ideas ?? []).filter((i) => isOpenIdea(i) && taskRef(fm(i, "task")) === taskPath);
}
function researchOf(t: Item): Item | undefined {
	return state?.research.find((r) => r.name === t.name || taskRef(fm(r, "task")) === t.path);
}
function lookOf(t: Item): LookaheadTask | undefined {
	return state?.lookahead?.tasks.find((x) => taskRef(x.task) === t.path);
}

/** タスクに添える小さな印：アイデアの数・下調べ・重い */
function taskBadges(t: Item): string {
	const ids = ideasOf(t.path);
	const r = researchOf(t);
	const la = lookOf(t);
	const out: string[] = [];
	if (ids.length) out.push(`<button class="tb tb-idea" type="button" data-ideas="${esc(t.path)}" title="${esc(ids.map(ideaTitle).join("\n"))}">アイデア ${ids.length}</button>`);
	if (r) out.push(`<button class="tb tb-research" type="button" data-open="${esc(r.path)}" title="${esc(`下調べ（${fm(r, "status") || "下調べ済"}・${fm(r, "updated")}）`)}">下調べ</button>`);
	if (la?.heavy && isOpenTask(t)) out.push(`<span class="tb heavy" title="${esc(la.simplify ? `絞る案: ${la.simplify}` : "重い")}">重い</span>`);
	return out.length ? `<span class="tbs">${out.join("")}</span>` : "";
}

/** 先読みの推奨（着手の準備の行の下に控えめに） */
function recoHtml(la: LookaheadTask | undefined): string {
	if (!la) return "";
	const parts = [
		la.start_reco ? `推奨開始 ${md5(la.start_reco)}` : "",
		la.prep_due_reco ? `準備 ${md5(la.prep_due_reco)} まで` : "",
		la.effort_h ? `約 ${la.effort_h}h` : "",
	].filter(Boolean);
	const simplify = la.heavy && la.simplify ? `<span class="simplify">絞る案: ${esc(la.simplify)}</span>` : "";
	if (!parts.length && !simplify) return "";
	return `<div class="reco" title="${esc([la.input, la.output, la.reason].filter(Boolean).join("\n"))}"><span>${esc(parts.join("・"))}</span>${simplify}</div>`;
}

/** アイデアを route（タスク / 目標 / 単独）ごとに。実行は後回しなので、新規・温め中だけ */
let ideaFocus = "";
function ideasHtml(s: VaultState): string {
	const list = s.ideas.filter(isOpenIdea);
	const routes: [string, string][] = [
		["タスク", "タスクに紐づく"],
		["目標", "目標に効く"],
		["単独", "単独"],
	];
	const routeOf = (i: Item) => (["タスク", "目標"].includes(fm(i, "route")) ? fm(i, "route") : "単独");
	const body = list.length
		? routes
				.map(([key, label]) => {
					const items = list.filter((i) => routeOf(i) === key);
					if (!items.length) return "";
					return `<div class="igroup"><h3>${esc(label)}<span class="n">${items.length}</span></h3>${items
						.map((i) => {
							const tp = taskRef(fm(i, "task"));
							const to = key === "タスク" && tp ? taskName(tp) : key === "目標" ? fm(i, "goal") : fm(i, "project");
							const hl = ideaFocus && tp === ideaFocus ? " hl" : "";
							return `<div class="idea${hl}">
								<button class="open" type="button" data-open="${esc(i.path)}" title="${esc(i.summary)}">
									<span class="ist ist-${esc(fm(i, "status") || "新規")}">${esc(fm(i, "status") || "新規")}</span>
									<span class="t">${esc(ideaTitle(i))}</span>
									<span class="s">${esc(to)}</span>
								</button>
								<span class="src">${esc([fm(i, "source"), md5(fm(i, "created").slice(0, 10))].filter(Boolean).join(" · "))}</span>
								<button class="ask" type="button" data-ask="${esc(i.path)}">話す</button>
							</div>`;
						})
						.join("")}</div>`;
				})
				.join("")
		: `<p class="none">まだない。思いつきは mgr・sub mgr のどこで話しても、ここに積まれる</p>`;
	const graphMode = ideasView === "graph";
	return `<section class="ideas ${foldCls("ideas")}" data-key="ideas">
		<h2 data-fold="ideas">アイデア<span class="n">${list.length || ""}</span><span class="note">実行は後回し。関係するタスクがあればそこに紐づける</span>
			<span class="vt"><button type="button" data-iview="list" aria-pressed="${!graphMode}">一覧</button><button type="button" data-iview="graph" aria-pressed="${graphMode}">グラフ</button><button type="button" class="link" data-btab="${GRAPH_TAB}">大きく開く</button></span>
		</h2>
		<div class="fold-body">${graphMode ? `<div class="igraph-slot" id="igraph-slot"></div>${GRAPH_LEGEND}` : body}</div>
	</section>`;
}

/** タスクの「アイデア n」：1 件ならそのノート、複数ならアイデア欄のそのタスクの分を目立たせる */
function showIdeasOf(taskPath: string) {
	const ids = ideasOf(taskPath);
	if (ids.length === 1) return void openDoc(ids[0]!.path);
	ideaFocus = taskPath;
	ideasView = "list";
	store("ideasView", ideasView);
	folded.delete("ideas");
	store("folded", JSON.stringify([...folded]));
	renderBoard();
	boardEl.querySelector(".ideas .idea.hl")?.scrollIntoView({ block: "center", behavior: "smooth" });
	setTimeout(() => {
		ideaFocus = "";
		boardEl.querySelectorAll(".ideas .idea.hl").forEach((el) => el.classList.remove("hl"));
	}, 4000);
}

// ───────── アイデアのグラフ（盤面のアイデア欄と、ノートのタブ「アイデアのグラフ」で同じものを使う） ─────────

const GRAPH_TAB = "graph:ideas";
const GRAPH_LEGEND = `<p class="igraph-legend"><span class="lg idea">アイデア</span><span class="lg task">タスク</span><span class="lg goal">目標</span><span class="lg project">PJ</span><span class="hint">ドラッグで動かす・ホイールで拡大・ダブルクリックで全体・押すと開く</span></p>`;
let ideasView: "list" | "graph" = load("ideasView") === "graph" ? "graph" : "list";

const graph = new IdeaGraph(
	(n) => {
		if (n.path) void openDoc(n.path);
	},
	() => {
		if (renderPending) renderBoard();
	},
);
const graphTabEl = document.createElement("div");
graphTabEl.className = "reader-graph";
graphTabEl.hidden = true;
readerEl.appendChild(graphTabEl);
const peopleTab = new PeopleTab({
	openNote: (path) => void openDoc(path),
	talk: (path, text) => pasteQuote(path, "", text),
	load,
	store,
});
const peopleTabEl = peopleTab.el;
readerEl.appendChild(peopleTabEl);
const sheetTabEl = document.createElement("div");
sheetTabEl.className = "reader-sheet";
sheetTabEl.hidden = true;
readerEl.appendChild(sheetTabEl);

/** goals.md の「## 四半期目標」の番号付き・箇条書きの項目（空は除く） */
function goalNames(doc: Doc | null): string[] {
	if (!doc) return [];
	const lines = doc.body.split("\n");
	const i = lines.findIndex((l) => /^##\s*四半期目標/.test(l.trim()));
	if (i < 0) return [];
	const out: string[] = [];
	for (const l of lines.slice(i + 1)) {
		if (/^##\s/.test(l)) break;
		const m = /^\s*(?:\d+[.)]|[-*])\s+(.+)$/.exec(l);
		if (m && m[1]!.trim()) out.push(m[1]!.trim());
	}
	return out;
}

/** ノード: アイデア・紐づくタスク（と親）・目標・PJ。エッジ: アイデア→タスク/目標/PJ、タスク→親/PJ */
function graphData(s: VaultState): { nodes: GraphNode[]; edges: GraphEdge[] } {
	const nodes = new Map<string, GraphNode>();
	const edges = new Map<string, GraphEdge>();
	const link = (a: string, b: string) => a !== b && edges.set(`${a}>${b}`, { a, b });
	const byName = new Map(s.tasks.map((t) => [t.name, t]));
	const project = (name: string) => {
		const id = `pj:${name}`;
		if (!nodes.has(id)) nodes.set(id, { id, kind: "project", label: name });
		return id;
	};
	const goal = (name: string) => {
		const id = `goal:${name}`;
		if (!nodes.has(id)) nodes.set(id, { id, kind: "goal", label: name, path: "goals.md" });
		return id;
	};
	const task = (t: Item): string => {
		const id = `task:${t.path}`;
		if (nodes.has(id)) return id;
		nodes.set(id, { id, kind: "task", label: titleOf(t), status: fm(t, "status"), path: t.path });
		const parent = byName.get(parentOf(t));
		if (parent && parent !== t) link(id, task(parent));
		if (fm(t, "project")) link(id, project(fm(t, "project")));
		return id;
	};
	for (const g of goalNames(goalsDoc)) goal(g);
	for (const i of s.ideas) {
		const id = `idea:${i.path}`;
		nodes.set(id, { id, kind: "idea", label: ideaTitle(i), status: fm(i, "status") || "新規", path: i.path });
		const t = s.tasks.find((x) => x.path === taskRef(fm(i, "task")));
		if (t) link(id, task(t));
		if (fm(i, "goal")) link(id, goal(fm(i, "goal")));
		if (fm(i, "project")) link(id, project(fm(i, "project")));
	}
	return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** 見えている場所（ノートのタブか、アイデア欄）にグラフを置いて描く */
function mountGraph() {
	if (!state) return;
	const host = current?.path === GRAPH_TAB ? graphTabEl : boardEl.querySelector<HTMLElement>("#igraph-slot");
	if (!host) return;
	graph.setData(...Object.values(graphData(state)) as [GraphNode[], GraphEdge[]], "アイデアがまだない（ideas/）");
	if (graph.el.parentElement !== host) host.appendChild(graph.el);
	graph.refresh();
}

function openGraphTab() {
	rememberScroll();
	if (!docTabs.some((t) => t.path === GRAPH_TAB)) docTabs.push({ path: GRAPH_TAB, label: "アイデアのグラフ", scroll: 0 });
	current = { path: GRAPH_TAB, fm: {}, body: "", mtime: 0 };
	readerEl.hidden = false;
	readerScroll.hidden = true;
	graphTabEl.hidden = false;
	sheetTabEl.hidden = true;
	peopleTab.setVisible(false);
	readerPath.textContent = "アイデアのグラフ（アイデア・紐づくタスク・目標・PJ）";
	$("talk-about").hidden = true;
	$("open-obsidian").hidden = true;
	renderDocTabs();
	mountGraph();
	graphTabEl.querySelector(".igraph-legend") ?? graphTabEl.insertAdjacentHTML("beforeend", GRAPH_LEGEND);
}

/** 「関係者」タブ（人物ノート・PJ の関係者をグラフと表で。中身は people-tab.ts） */
function openPeopleTab() {
	rememberScroll();
	if (!docTabs.some((t) => t.path === PEOPLE_TAB)) docTabs.push({ path: PEOPLE_TAB, label: PEOPLE_LABEL, scroll: 0 });
	current = { path: PEOPLE_TAB, fm: {}, body: "", mtime: 0 };
	readerEl.hidden = false;
	readerScroll.hidden = true;
	graphTabEl.hidden = true;
	sheetTabEl.hidden = true;
	if (state) peopleTab.setData(state.people, state.projects, state.orgs);
	peopleTab.setVisible(true);
	readerPath.textContent = "関係者（memory/people の人物と memory/pj の関係者。グラフと表を切り替え、プロジェクトで絞る）";
	$("talk-about").hidden = true;
	$("open-obsidian").hidden = true;
	renderDocTabs();
}

// ───────── エージェント（対話・worker・定期実行・アプリの見張り） ─────────

const SKILL_PATH = ".claude/skills/manager-app/SKILL.md";

/** description の先頭 1 文 */
const firstSentence = (s: string) => (s.match(/^[^。.!?！？]*[。.!?！？]?/)?.[0] ?? s).slice(0, 80);

function agentsHtml(s: VaultState): string {
	const termState = (list: TermInfo[]) => {
		if (!list.length) return "なし";
		const busy = list.filter((t) => t.active).length;
		const up = list.filter((t) => t.running).length;
		return busy ? `作業中${list.length > 1 ? ` ${busy}` : ""}` : up ? `起動中${list.length > 1 ? ` ${up}` : ""}` : "休止";
	};
	const row = (o: { name: string; role: string; model: string; state: string; path: string; off?: boolean; busy?: boolean; title?: string }) =>
		`<div class="ag${o.off ? " off" : ""}"><button class="open" type="button" data-open="${esc(o.path)}" title="${esc(o.title ?? o.path)}"><span class="nm">${esc(o.name)}</span><span class="rl">${esc(o.role)}</span></button><span class="md">${esc(o.model)}</span><span class="st${o.busy ? " busy" : ""}">${esc(o.state)}</span></div>`;
	const group = (label: string, rows: string[]) => (rows.length ? `<div class="agroup"><h3>${esc(label)}<span class="n">${rows.length}</span></h3>${rows.join("")}</div>` : "");

	const main = terms.filter((t) => t.kind === "main");
	const sys = terms.filter((t) => t.kind === "system");
	const slf = terms.filter((t) => t.kind === "self");
	const subs = terms.filter((t) => t.kind === "task");

	const talk = [
		row({ name: "mgr", role: "人の窓口とルーティング。人と話し、sub mgr・worker に振る", model: main[0]?.model ?? "sonnet", state: termState(main), busy: main.some((t) => t.active), path: SKILL_PATH }),
		row({
			name: "システム改修",
			role: "sub mgr。manager システム自体の改修。実作業は worker system-engineer に出す",
			model: sys[0]?.model ?? "sonnet",
			state: termState(sys),
			busy: sys.some((t) => t.active),
			path: SKILL_PATH,
		}),
		row({
			name: "自己改善",
			role: "sub mgr（self impl mgr）。自動 eod の結果の受け取り・retro・改善提案。業務タスクとシステム改修は扱わない",
			model: slf[0]?.model ?? "sonnet",
			state: termState(slf),
			busy: slf.some((t) => t.active),
			path: SKILL_PATH,
		}),
		row({
			name: `sub mgr${subs.length ? ` ×${subs.length}` : ""}`,
			role: subs.length ? subs.map((t) => t.title).join("、") : "タスク 1 件の段取り（並行タスクが 3 件以上で mgr が立てる）",
			model: subs[0]?.model ?? "sonnet",
			state: termState(subs),
			busy: subs.some((t) => t.active),
			path: SKILL_PATH,
		}),
	];

	const workerRows = s.agents.map((a) => {
		const name = fm(a, "name") || a.name;
		const tools = fm(a, "tools");
		const canWrite = !tools || /\b(Write|Edit|Bash|NotebookEdit)\b/.test(tools);
		const running = workers.filter((w) => w.type === name && w.state === "running").length;
		return row({
			name,
			role: `${canWrite ? "書ける" : "読むだけ"}。${firstSentence(fm(a, "description"))}`,
			model: fm(a, "model") || "継承",
			state: running ? `作業中 ${running}` : "待機",
			busy: running > 0,
			path: a.path,
			title: fm(a, "description"),
		});
	});

	const jobRows = s.jobs.map((j) => {
		const on = fm(j, "enabled") !== "false";
		const last = fm(j, "last_status");
		return row({
			name: titleOf(j),
			role: `${fm(j, "title") || ""} ${fm(j, "time")} ${fm(j, "days")}`.trim(),
			model: fm(j, "model") || (fm(j, "script") ? "script" : "-"),
			state: on ? (last ? `前回 ${last}` : "有効") : "無効",
			off: !on,
			path: j.path,
			title: fm(j, "last_run") ? `前回 ${fm(j, "last_run")}（${last}）` : j.path,
		});
	});

	const st = s.docs.find((d) => d.path === "settings/manager-app.md");
	const set = (k: string) => (st ? st.fm[k] !== "false" : true);
	const watchRows = [
		row({ name: "声かけ（pulse）", role: "規則で見張り、きっかけがあれば mgr に合図を送る（LLM なし）", model: "なし", state: set("nudge") ? "有効" : "無効", off: !set("nudge"), path: "settings/manager-app.md" }),
		row({ name: "活動の記録（activity）", role: "前面ウィンドウを採り、脱線・停滞の材料にする（分類は haiku）", model: "haiku", state: set("activity") ? "有効" : "無効", off: !set("activity"), path: "settings/manager-app.md" }),
	];

	return `<section class="agents ${foldCls("agents")}" data-key="agents">
		<h2 data-fold="agents">エージェント<span class="note">押すと定義ファイルを開く</span></h2>
		<div class="fold-body">${group("対話", talk)}${group("worker（サブエージェント）", workerRows)}${group("定期実行", jobRows)}${group("アプリの見張り", watchRows)}</div>
	</section>`;
}

// ───────── 日付 ─────────

const DAY_MS = 86_400_000;
const toDate = (s: string) => new Date(`${s}T00:00`);
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (s: string, n: number) => ymd(new Date(toDate(s).getTime() + n * DAY_MS));
const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / DAY_MS);
const holidayOf = (s: string) => state?.holidays[s] ?? "";
const isOff = (s: string) => {
	const w = toDate(s).getDay();
	return w === 0 || w === 6 || !!holidayOf(s);
};
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

/** 見積（4h / 2d）を営業日数に */
function estimateDays(t: Item): number {
	const m = /^(\d+(?:\.\d+)?)\s*([hd])$/i.exec(fm(t, "estimate").trim());
	if (!m) return 0;
	const n = Number(m[1]);
	return Math.max(1, Math.ceil(m[2]!.toLowerCase() === "h" ? n / 8 : n));
}

/** 営業日で n 日戻る（土日・祝日を飛ばす） */
function backBiz(date: string, n: number): string {
	let d = date;
	while (n > 0) {
		d = addDays(d, -1);
		if (!isOff(d)) n--;
	}
	return d;
}

// ───────── ガントチャート（WBS） ─────────

const GANTT_BEFORE = 2;
const GANTT_AFTER = 14;

type GanttRow = { t: Item; depth: number; children: Item[] };

function wbsRows(s: VaultState): GanttRow[] {
	const all = s.tasks.filter((t) => fm(t, "status") !== "inbox");
	const byName = new Map(all.map((t) => [t.name, t]));
	const kids = new Map<string, Item[]>();
	const roots: Item[] = [];
	for (const t of all) {
		const p = parentOf(t);
		if (p && byName.has(p) && p !== t.name) (kids.get(p) ?? kids.set(p, []).get(p)!).push(t);
		else roots.push(t);
	}
	const order = (a: Item, b: Item) =>
		(fm(a, "wbs") || "~").localeCompare(fm(b, "wbs") || "~", undefined, { numeric: true }) || byDue(a, b);
	const rows: GanttRow[] = [];
	const seen = new Set<string>();
	const walk = (t: Item, depth: number) => {
		if (seen.has(t.name)) return;
		seen.add(t.name);
		const children = (kids.get(t.name) ?? []).sort(order);
		// 閉じたものは、開いている親の下でだけ薄く出す
		if (!isOpenTask(t) && depth === 0) return;
		rows.push({ t, depth, children });
		for (const c of children) walk(c, depth + 1);
	};
	for (const r of roots.sort(order)) walk(r, 0);
	return rows;
}

function ganttHtml(s: VaultState): string {
	const rows = wbsRows(s);
	const from = addDays(s.today, -GANTT_BEFORE);
	const days = Array.from({ length: GANTT_BEFORE + GANTT_AFTER + 1 }, (_, i) => addDays(from, i));
	const n = days.length;
	const head = days
		.map((d) => {
			const hol = holidayOf(d);
			const cls = [isOff(d) ? "off" : "", d === s.today ? "today" : "", toDate(d).getDate() === 1 ? "month" : ""].join(" ");
			return `<div class="gd ${cls}" title="${esc(hol || d)}"><span class="dn">${toDate(d).getDate() === 1 || d === from ? `${toDate(d).getMonth() + 1}/` : ""}${toDate(d).getDate()}</span><span class="dw">${hol ? "祝" : WEEK[toDate(d).getDay()]}</span></div>`;
		})
		.join("");
	const stripes = days.map((d) => `<i class="${isOff(d) ? "off" : ""}${d === s.today ? " today" : ""}"></i>`).join("");
	const fr: FoldRow[] = rows.map((r) => ({ key: r.t.path, depth: r.depth }));
	const kids = descendantCounts(fr);
	const hidden = hiddenFlags(fr, wbsCollapsed);
	// 進捗線の位置。子を持つ親は自分の進捗ではなく、開いている子孫の末端のうち最も遅れている位置に合わせる（表示時に計算。frontmatter は書かない）
	const plans = rows.map((r) => rowPlan(r.t, r.children, s.today, from, n));
	const nodes = new Map<string, PosNode>(rows.map((r, i) => [r.t.name, { own: plans[i]!.own, closed: !isOpenTask(r.t), children: [] }]));
	for (const r of rows) nodes.get(r.t.name)!.children = r.children.flatMap((c) => nodes.get(c.name) ?? []);
	const kidsX = rows.map((r) => rolledUpPosition({ ...nodes.get(r.t.name)!, own: null }));
	const body = rows.map((r, i) => ganttRow(r, plans[i]!, kidsX[i]!, s.today, from, n, stripes, kids[i]!, hidden[i]!)).join("");
	return `<section class="gantt ${foldCls("gantt")}" data-key="gantt" style="--days:${n};--name-w:${nameW}px">
		<h2 data-fold="gantt">WBS<span class="note">${esc(md5(from))}〜${esc(md5(days[n - 1]!))}。斜線は準備、帯は作業（着手〜期限）、◆は期限</span>${wbsAllHtml(fr, kids)}${rows.length ? lineOptsHtml() : ""}</h2>
		<div class="fold-body">${
			rows.length
				? `<div class="gwrap${lineOpts.color ? "" : " mono"}" data-today="${daysBetween(from, s.today)}">
					<div class="gh"><div class="gname">作業<span class="gresize" data-gresize title="ドラッグで作業列の幅を変える（ダブルクリックで既定）"></span></div><div class="gdays">${head}</div></div>${body}
					<svg class="pline" aria-hidden="true"${lineOpts.line ? "" : ' style="display:none"'}></svg>
				</div>
				<div class="glegend"><span><i class="l-line"></i>進捗線（各タスクの現在位置を結ぶ）</span><span><i class="l-beh"></i>今日より左 = 予定より遅れ</span><span><i class="l-ahd"></i>今日より右 = 予定より先行</span><span><i class="l-roll"></i>塗りの丸 = 親（子のうち最も遅れている位置）</span><span>帯の塗り = 進捗の割合</span></div>`
				: '<p class="none">タスクがない</p>'
		}</div>
	</section>`;
}

// 作業列の幅（ヘッダ右端をドラッグ。localStorage に保つ）
let nameW = parseNameW(load(NAME_W_KEY));

boardEl.addEventListener("pointerdown", (e) => {
	const h = (e.target as HTMLElement).closest<HTMLElement>("[data-gresize]");
	const sec = h?.closest<HTMLElement>(".gantt");
	if (!h || !sec) return;
	e.preventDefault();
	const x0 = e.clientX;
	const w0 = nameW;
	h.setPointerCapture(e.pointerId);
	const move = (ev: PointerEvent) => {
		nameW = clampNameW(w0 + ev.clientX - x0);
		sec.style.setProperty("--name-w", `${nameW}px`);
	};
	const up = () => {
		h.removeEventListener("pointermove", move);
		h.removeEventListener("pointerup", up);
		h.removeEventListener("pointercancel", up);
		store(NAME_W_KEY, String(nameW));
		drawProgressLine();
	};
	h.addEventListener("pointermove", move);
	h.addEventListener("pointerup", up);
	h.addEventListener("pointercancel", up);
});
boardEl.addEventListener("dblclick", (e) => {
	const sec = (e.target as HTMLElement).closest<HTMLElement>("[data-gresize]")?.closest<HTMLElement>(".gantt");
	if (!sec) return;
	nameW = parseNameW(null);
	sec.style.setProperty("--name-w", `${nameW}px`);
	store(NAME_W_KEY, String(nameW));
	drawProgressLine();
});

// 親を畳むと子孫の行を隠す（状態は localStorage の wbsCollapsed にタスクのパスで保つ。既定は開く）
const wbsCollapsed = parseCollapsed(load("wbsCollapsed"));

/** 見出しの「すべて畳む / すべて開く」。親がなければ出さない */
function wbsAllHtml(fr: FoldRow[], kids: number[]): string {
	const parents = fr.filter((_, i) => kids[i]! > 0);
	if (!parents.length) return "";
	const anyOpen = parents.some((p) => !wbsCollapsed.has(p.key));
	return `<button class="link gall" type="button" data-wbs-all="${anyOpen ? "fold" : "open"}">${anyOpen ? "すべて畳む" : "すべて開く"}</button>`;
}

function wbsToggleHtml(path: string, title: string, kids: number): string {
	if (!kids) return '<span class="gtw" aria-hidden="true"></span>';
	const open = !wbsCollapsed.has(path);
	return `<button class="gtw" type="button" data-wbs-toggle="${esc(path)}" aria-expanded="${open}" aria-label="${esc(`${title} の子 ${kids} 件を${open ? "畳む" : "開く"}`)}">${open ? "▾" : "▸"}</button>`;
}

/** 畳み状態を表に当てる（描き直さないので、押したボタンのフォーカスが残る） */
function applyWbsFold() {
	const rowEls = [...boardEl.querySelectorAll<HTMLElement>(".gantt .grow[data-wbs]")];
	const fr: FoldRow[] = rowEls.map((el) => ({ key: el.dataset.wbs!, depth: Number(el.dataset.depth) || 0 }));
	const hidden = hiddenFlags(fr, wbsCollapsed);
	rowEls.forEach((el, i) => (el.hidden = hidden[i]!));
	const parents: string[] = [];
	for (const b of boardEl.querySelectorAll<HTMLButtonElement>(".gantt [data-wbs-toggle]")) {
		const key = b.dataset.wbsToggle!;
		const open = !wbsCollapsed.has(key);
		parents.push(key);
		b.setAttribute("aria-expanded", String(open));
		b.textContent = open ? "▾" : "▸";
		b.setAttribute("aria-label", (b.getAttribute("aria-label") ?? "").replace(/(畳む|開く)$/, open ? "畳む" : "開く"));
	}
	const all = boardEl.querySelector<HTMLButtonElement>(".gantt [data-wbs-all]");
	if (all) {
		const anyOpen = parents.some((k) => !wbsCollapsed.has(k));
		all.dataset.wbsAll = anyOpen ? "fold" : "open";
		all.textContent = anyOpen ? "すべて畳む" : "すべて開く";
	}
	store("wbsCollapsed", serializeCollapsed(wbsCollapsed, parents));
	drawProgressLine();
}

// ───────── WBS の進捗線（イナズマ線） ─────────
// ヘッダー下端の今日から出て、見えている行の目印（.gpos）を上から順に結び、下端の今日に戻る。
// 位置は実際の DOM から取る（行の高さを計算しない）。描き直し・畳み・大きさの変化のたびに引き直す。

const lineOpts = parseLineOpts(load("wbsProgressLine"));

function lineOptsHtml(): string {
	const box = (k: "line" | "color", label: string) =>
		`<label class="gopt"><input type="checkbox" data-pline="${k}"${lineOpts[k] ? " checked" : ""}>${label}</label>`;
	return `<span class="gopts">${box("line", "進捗線を表示")}${box("color", "遅れ・先行で色を変える")}</span>`;
}

let lineObserved: Element | null = null;
const lineRO = new ResizeObserver(() => drawProgressLine());

function drawProgressLine() {
	const wrap = boardEl.querySelector<HTMLElement>(".gantt .gwrap");
	if (wrap !== lineObserved) {
		lineRO.disconnect();
		if (wrap) lineRO.observe(wrap);
		lineObserved = wrap;
	}
	if (!wrap) return;
	const svg = wrap.querySelector<SVGSVGElement>(":scope > .pline");
	const headDays = wrap.querySelector<HTMLElement>(":scope > .gh .gdays");
	if (!svg || !headDays) return;
	wrap.classList.toggle("mono", !lineOpts.color);
	svg.style.display = lineOpts.line ? "" : "none";
	if (!lineOpts.line) return;
	const gr = wrap.getBoundingClientRect();
	if (!gr.width || !gr.height) return; // 畳んでいる・まだ出ていない（開いたら ResizeObserver で引く）
	const hr = headDays.getBoundingClientRect();
	const n = headDays.children.length || 1;
	const todayX = hr.left - gr.left + (Number(wrap.dataset.today) + 0.5) * (hr.width / n);
	const pts: Pt[] = [{ x: todayX, y: hr.bottom - gr.top }];
	for (const el of wrap.querySelectorAll<HTMLElement>(".grow .gpos")) {
		if (el.closest<HTMLElement>(".grow")?.hidden) continue; // 畳んだ親の子は飛ばす
		const r = el.getBoundingClientRect();
		pts.push({ x: r.left - gr.left, y: r.top - gr.top, rollup: el.classList.contains("rollup") });
	}
	pts.push({ x: todayX, y: gr.height });
	svg.setAttribute("viewBox", `0 0 ${gr.width} ${gr.height}`);
	svg.innerHTML = lineSvg(pts, todayX);
}

boardEl.addEventListener("change", (e) => {
	const t = e.target as HTMLElement;
	const k = t.dataset?.pline;
	if (!(t instanceof HTMLInputElement) || (k !== "line" && k !== "color")) return;
	lineOpts[k] = t.checked;
	store("wbsProgressLine", JSON.stringify(lineOpts));
	drawProgressLine();
});

function toggleWbs(path: string) {
	if (wbsCollapsed.has(path)) wbsCollapsed.delete(path);
	else wbsCollapsed.add(path);
	applyWbsFold();
}

function setAllWbs(fold: boolean) {
	for (const b of boardEl.querySelectorAll<HTMLElement>(".gantt [data-wbs-toggle]")) {
		if (fold) wbsCollapsed.add(b.dataset.wbsToggle!);
		else wbsCollapsed.delete(b.dataset.wbsToggle!);
	}
	applyWbsFold();
}

type RowPlan = { start: string; due: string; progress: number; /** 自身の線の位置。予定がなければ null */ own: number | null };

/** 行の予定（着手・期限）と進捗。帯の塗りと、子のない行の進捗線で同じ値を使う */
function rowPlan(t: Item, children: Item[], today: string, from: string, n: number): RowPlan {
	const due = fm(t, "due");
	const est = estimateDays(t);
	const start = fm(t, "start") || (due && est ? backBiz(due, est - 1) : "");
	const progress = progressRatio({
		explicit: fm(t, "progress"),
		childrenDone: children.filter((c) => fm(c, "status") === "done").length,
		childrenTotal: children.length,
		stepsDone: t.prep?.stepsDone ?? 0,
		stepsTotal: t.prep?.stepsTotal ?? 0,
		done: fm(t, "status") === "done",
	});
	const pos = (d: string) => daysBetween(from, d);
	const own = ownLinePosition({ todayIdx: pos(today), startIdx: start ? pos(start) : null, dueIdx: due ? pos(due) : null, ratio: progress, n });
	return { start, due, progress, own };
}

/** kidsX は子の実績で決めた線の位置（rolledUpPosition）。null なら自身の進捗で引く */
function ganttRow({ t, depth }: GanttRow, { start, due, progress }: RowPlan, kidsX: number | null, today: string, from: string, n: number, stripes: string, kids: number, hidden: boolean): string {
	const closed = !isOpenTask(t);
	const r = readiness(t);
	const pos = (d: string) => daysBetween(from, d);
	const clip = (i: number) => Math.min(Math.max(i, 0), n - 1);
	const pct = (i: number) => `${(i / n) * 100}%`;
	const bars: string[] = [];

	// 準備：着手可でなければ、今日から準備の期限まで斜線
	const pd = prepDue(t);
	if (!closed && r !== "着手可" && pd) {
		const a = pos(today);
		const b = pos(pd);
		if (b < a) bars.push(`<span class="gbar prep late" style="left:${pct(clip(a))};width:${pct(1)}" title="準備の期限 ${esc(md5(pd))} を過ぎている"></span>`);
		else if (b >= 0 && a < n) bars.push(`<span class="gbar prep" style="left:${pct(clip(a))};width:${pct(clip(b) - clip(a) + 1)}" title="準備の期限 ${esc(md5(pd))}"></span>`);
	}
	// 作業：着手〜期限
	if (start && due && start <= due) {
		const a = pos(start);
		const b = pos(due);
		if (b >= 0 && a < n) {
			const late = !closed && due < today;
			const cls = ["gbar", "work", `st-${fm(t, "status")}`, late ? "late" : "", a < 0 ? "cut-l" : "", b >= n ? "cut-r" : ""].join(" ");
			bars.push(`<span class="${cls}" style="left:${pct(clip(a))};width:${pct(clip(b) - clip(a) + 1)}" title="${esc(`${md5(start)}〜${md5(due)}`)}"><b style="width:${Math.round(progress * 100)}%"></b></span>`);
		}
	}
	// 先読みの推奨開始日（控えめな印）
	const la = lookOf(t);
	if (!closed && la?.start_reco) {
		const b = pos(la.start_reco);
		if (b >= 0 && b < n) bars.push(`<span class="greco${la.heavy ? " heavy" : ""}" style="left:${pct(b)}" title="${esc(`推奨開始 ${md5(la.start_reco)}${la.effort_h ? `（約 ${la.effort_h}h）` : ""}${la.heavy && la.simplify ? `\n絞る案: ${la.simplify}` : ""}`)}"></span>`);
	}
	// 期限
	if (due) {
		const b = pos(due);
		if (b >= 0 && b < n) bars.push(`<span class="gms${!closed && due < today ? " late" : ""}" style="left:${pct(b + 0.5)}" title="期限 ${esc(md5(due))}"></span>`);
		else if (b < 0 && !closed) bars.push(`<span class="gedge l late" title="期限 ${esc(md5(due))} を過ぎている">◀ ${esc(md5(due))}</span>`);
		else if (b >= n) bars.push(`<span class="gedge r" title="期限 ${esc(md5(due))}">${esc(md5(due))} ▶</span>`);
	}

	// 進捗線の目印（開いている行だけ。完了・取り消しは線を通さない）。子を持つ親は子の最遅に合わせる
	if (!closed) {
		const x = kidsX ?? linePosition({ todayIdx: pos(today), startIdx: start ? pos(start) : null, dueIdx: due ? pos(due) : null, ratio: progress, n });
		bars.push(`<span class="gpos${kidsX !== null ? " rollup" : ""}" style="left:${pct(x)}"></span>`);
	}

	const term = termOfTask(t.path);
	const mark = term ? (term.active ? '<span class="mk busy" title="作業中"></span>' : term.unread ? '<span class="mk unread" title="返事あり"></span>' : '<span class="mk room" title="sub mgr あり"></span>') : "";
	// 子は「親名_」の接頭辞を除いた自分の作業名だけ出す（階層はインデントと wbs 番号で示す）
	const label = depth > 0 ? childLabel(titleOf(t), parentOf(t)) : titleOf(t);
	return `<div class="grow${closed ? " closed" : ""}${term && term.id === currentId ? " active" : ""}" data-wbs="${esc(t.path)}" data-depth="${depth}"${hidden ? " hidden" : ""}>
		<div class="gname" style="--depth:${depth}">
			${wbsToggleHtml(t.path, label, kids)}
			<span class="code">${esc(fm(t, "wbs"))}</span>
			<button class="open" type="button" data-open="${esc(t.path)}" title="${esc(fm(t, "next_action"))}">${mark}<span class="ready ready-${r}" title="${r}"></span><span class="gtitle" title="${esc(titleOf(t))}">${esc(label)}</span></button>
			${kids ? `<span class="gkids" title="子孫 ${kids} 件（孫以降を含む）">${kids}</span>` : ""}
			${taskBadges(t)}
			${closed ? "" : `<span class="acts"><button class="ask" type="button" data-ask="${esc(t.path)}">話す</button>${term ? `<button class="deep" type="button" data-deep="${esc(t.path)}">sub mgr</button>` : ""}</span>`}
		</div>
		<div class="gdays">${stripes}${bars.join("")}</div>
	</div>`;
}

// ───────── 今日のタイムライン ─────────

const HOUR_PX = 36;

/** 予定の種類。色で見分ける（凡例と同じ順） */
const EV_KINDS = [
	{ key: "pj", label: "案件" },
	{ key: "internal", label: "社内会議" },
	{ key: "talk", label: "面談・相談" },
	{ key: "learn", label: "勉強会・イベント" },
	{ key: "other", label: "その他" },
] as const;
type EvKind = (typeof EV_KINDS)[number]["key"];

function eventKind(title: string, projects: string[]): EvKind {
	if (/勉強会|セミナー|イベント|ハンズオン|LT|研修/.test(title)) return "learn";
	if (/面談|1on1|1on1|相談|ヒアリング|引き継ぎ|引継ぎ/i.test(title)) return "talk";
	if (projects.some((p) => p && title.includes(p)) || /分科会|顧客|お客様|打合せ|打ち合わせ|【TBD】|\[TBD\]/.test(title)) return "pj";
	if (/【社内】|社内|定例|MTG|課会|部会|朝会|Daily|振り返り/i.test(title)) return "internal";
	return "other";
}

/** 予定に付いた Meet・メモ・録画（詳細はブリーフ側。ここでは開くための印だけ） */
function evLinks(e: VaultState["plan"]["events"][number]): string {
	const out: string[] = [];
	if (e.meet) {
		const name = /teams\.microsoft/.test(e.meet) ? "Teams" : /zoom\.us/.test(e.meet) ? "Zoom" : "Meet";
		out.push(`<a class="evl meet" href="${esc(e.meet)}" title="${name} に参加">${name}</a>`);
	}
	for (const l of e.links) out.push(`<a class="evl" href="${esc(l.url)}" title="${esc(l.title)}">${esc(l.kind)}</a>`);
	return out.length ? `<span class="evls">${out.join("")}</span>` : "";
}

const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** 現在時刻の線を 1 分ごとに動かす。範囲の外に出たら描き直す */
setInterval(() => {
	const tl = document.querySelector<HTMLElement>(".tl[data-today='1']");
	if (!tl) return;
	const d = new Date();
	const min = d.getHours() * 60 + d.getMinutes();
	const startH = Number(tl.dataset.start);
	const endH = Number(tl.dataset.end);
	if (min < startH * 60 || min > endH * 60 || hm(d) === "00:00") return renderBoard();
	const line = tl.querySelector<HTMLElement>(".now");
	if (!line) return renderBoard();
	// 文を選んでいる最中は描き直さず、線だけ動かす（選択の操作を邪魔しない）
	const selecting = !window.getSelection()?.isCollapsed;
	if (!selecting) return renderBoard(); // 終わった予定・進行中の予定の見た目も合わせる
	line.style.top = `${((min - startH * 60) / 60) * HOUR_PX}px`;
	line.querySelector("span")!.textContent = hm(d);
}, 60_000);

function timelineHtml(s: VaultState): string {
	// 案件名はタスクの project から拾う（社内は除く）
	const projects = [...new Set(s.tasks.map((t) => fm(t, "project")).filter((p) => p && p !== "社内"))];
	const plan = s.plan;
	const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
	const evs = plan.events
		.map((e) => ({ ...e, a: toMin(e.start), b: Math.max(toMin(e.end), toMin(e.start) + 15) }))
		.sort((x, y) => x.a - y.a || y.b - x.b);
	// 9:00〜21:00。外に予定があれば、また今日なら今の時刻まで広げる
	const nowD = new Date();
	const nowMin0 = nowD.getHours() * 60 + nowD.getMinutes();
	const isToday = plan.date === s.today;
	const startH = Math.min(9, ...evs.map((e) => Math.floor(e.a / 60)), ...(isToday ? [Math.floor(nowMin0 / 60)] : []));
	const endH = Math.max(21, ...evs.map((e) => Math.ceil(e.b / 60)), ...(isToday ? [Math.floor(nowMin0 / 60) + 1] : []));
	// 重なりは横に並べる
	const lanes: number[] = [];
	const placed = evs.map((e) => {
		let lane = lanes.findIndex((end) => end <= e.a);
		if (lane < 0) lane = lanes.push(0) - 1;
		lanes[lane] = e.b;
		return { ...e, lane };
	});
	const groupLanes = (e: (typeof placed)[number]) =>
		Math.max(...placed.filter((o) => o.a < e.b && o.b > e.a).map((o) => o.lane)) + 1;
	const hours = Array.from({ length: endH - startH + 1 }, (_, i) => startH + i);
	const now = new Date();
	const nowMin = now.getHours() * 60 + now.getMinutes();
	const showNow = isToday && nowMin >= startH * 60 && nowMin <= endH * 60;
	const y = (min: number) => ((min - startH * 60) / 60) * HOUR_PX;
	return `<div class="timeline">
		${plan.allDay.length ? `<div class="allday">${plan.allDay.map((a) => `<span>${esc(a)}</span>`).join("")}</div>` : ""}
		<div class="tl" data-start="${startH}" data-end="${endH}" data-today="${isToday ? 1 : 0}" style="height:${(endH - startH) * HOUR_PX}px">
			${hours.map((h) => `<div class="hr" style="top:${(h - startH) * HOUR_PX}px"><span>${h}:00</span></div>`).join("")}
			<div class="evs">
				${placed
					.map((e) => {
						const lanesN = groupLanes(e);
						const past = plan.date === s.today && e.b <= nowMin;
						const ongoing = plan.date === s.today && e.a <= nowMin && nowMin < e.b;
						const kind = eventKind(e.title, projects);
						return `<div class="ev k-${kind}${e.status === "辞退" ? " declined" : ""}${e.status === "未回答" ? " pending" : ""}${past ? " past" : ""}${ongoing ? " ongoing" : ""}" style="top:${y(e.a)}px;height:${Math.max(y(e.b) - y(e.a) - 2, 16)}px;left:${(e.lane / lanesN) * 100}%;width:${100 / lanesN}%" title="${esc(`${e.start}-${e.end} ${e.title}${e.status ? `（${e.status}）` : ""}${e.note ? `\n${e.note}` : ""}`)}"><span class="tm">${esc(e.start)}</span> ${esc(e.title)}${evLinks(e)}</div>`;
					})
					.join("")}
				${showNow ? `<div class="now" style="top:${y(nowMin)}px"><span>${hm(now)}</span></div>` : ""}
			</div>
		</div>
		${
			plan.events.length
				? `<div class="legend">${EV_KINDS.filter((k) => placed.some((e) => eventKind(e.title, projects) === k.key))
						.map((k) => `<span class="k-${k.key}">${k.label}</span>`)
						.join("")}<span class="pending">未回答</span></div>`
				: '<p class="none">予定なし（calendar/upcoming.md）</p>'
		}
	</div>`;
}

// ───────── 実行状況（mgr / sub mgr / worker） ─────────

let workers: WorkerInfo[] = [];

const ago = (t: number) => {
	const m = Math.round((Date.now() - t) / 60000);
	return m < 1 ? "今" : m < 60 ? `${m} 分前` : `${Math.round(m / 60)} 時間前`;
};
const WSTATE: Record<WorkerInfo["state"], string> = { running: "作業中", done: "完了", stalled: "止まっている", failed: "失敗", killed: "止めた" };

// ───────── タブの 1 段下の worker の帯（今のタブの worker をチップで、ほかのタブは数のバッジ） ─────────
// 消える時機: 完了は 60 秒、失敗・止めたはそのタブを見て離れるまで（最大 30 分）、止まっているは 30 分。

const DONE_SHOW_MS = 60_000;
const END_SHOW_MS = 30 * 60_000;
/** タブを離れた時刻。これより前に終わった失敗・止めたは見たものとして消す */
const leftAt = new Map<string, number>();
/** 盤面の実行状況で目立たせている worker */
let workerFocus = "";
let workerFocusTimer = 0;
let stripKey = "";
let stripHtml = "";

function stripWorkers(termId: string, now: number): WorkerInfo[] {
	return workers
		.filter((w) => {
			if (w.termId !== termId) return false;
			const since = now - w.endedAt;
			if (w.state === "running") return true;
			if (w.state === "done") return since < DONE_SHOW_MS;
			if (w.state === "stalled") return since < END_SHOW_MS;
			return since < END_SHOW_MS && w.endedAt > (leftAt.get(termId) ?? 0);
		})
		.sort((a, b) => a.startedAt - b.startedAt);
}

const STRIP_ORDER: WorkerInfo["state"][] = ["failed", "killed", "stalled", "running", "done"];

/** ほかのタブに付ける「worker n」 */
function workerBadge(termId: string, now: number): string {
	const ws = stripWorkers(termId, now);
	if (!ws.length) return "";
	const worst = STRIP_ORDER.find((s) => ws.some((w) => w.state === s))!;
	const tip = STRIP_ORDER.map((s) => [s, ws.filter((w) => w.state === s).length] as const)
		.filter(([, n]) => n)
		.map(([s, n]) => `${WSTATE[s]} ${n}`)
		.join(" / ");
	return `<span class="wn ${worst}" title="worker ${esc(tip)}">worker ${ws.length}</span>`;
}

function renderStrip(now: number) {
	const ws = stripWorkers(currentId, now);
	const cur = terms.find((t) => t.id === currentId);
	// 上段は今のレイヤー（mgr / sub mgr / システム）のラベル。worker はその下に横並び
	const label = cur ? `<div class="wlayer"><span class="role">${ROLE[cur.kind]}</span>${cur.kind === "task" ? `<span class="label">${esc(cur.title)}</span>` : ""}</div>` : "";
	const chips = ws
		.map(
			(w) =>
				`<button class="wchip ${w.state}" type="button" data-wid="${esc(w.id)}" data-wterm="${esc(w.termId)}"><span class="wm"></span><span class="ty">${esc(w.type)}</span>${w.description ? `<span class="de">${esc(w.description)}</span>` : ""}</button>`,
		)
		.join("");
	const html = label + (chips ? `<div class="wchips">${chips}</div>` : "");
	// 中身が同じなら触らない（ホバー中の説明を消さない）
	if (stripHtml !== html) wstripEl.innerHTML = stripHtml = html;
	wstripEl.hidden = !html;
}

/** 表示中の帯・バッジの形。変わったときだけ描き直す */
function workersKey(now: number): string {
	return `${currentId}@${terms.map((t) => `${t.id}:${stripWorkers(t.id, now).map((w) => w.id + w.state).join(",")}`).join("|")}`;
}

const dur = (ms: number) => {
	const m = Math.max(0, Math.round(ms / 60000));
	return m < 1 ? "1 分未満" : m < 60 ? `${m} 分` : `${Math.floor(m / 60)} 時間 ${m % 60} 分`;
};

/** チップのホバー：経過時間と直近のツール */
function chipTip(w: WorkerInfo): string {
	const now = Date.now();
	const when =
		w.state === "running"
			? `${dur(now - w.startedAt)} 経過`
			: w.state === "stalled"
				? `${dur(now - w.updatedAt)} 更新なし（${dur(w.updatedAt - w.startedAt)} 動いた）`
				: `${dur(w.endedAt - w.startedAt)} で${WSTATE[w.state]}（${ago(w.endedAt)}）`;
	return [
		`${w.type}：${WSTATE[w.state]}`,
		w.description,
		when,
		w.lastTool ? `直近のツール: ${toolName(w.lastTool)}` : "",
		"押すと盤面の実行状況で示す",
	]
		.filter(Boolean)
		.join("\n");
}

wstripEl.addEventListener("mouseover", (e) => {
	const c = (e.target as HTMLElement).closest<HTMLElement>("[data-wid]");
	const w = c && workers.find((x) => x.id === c.dataset.wid);
	if (c && w) c.title = chipTip(w);
});
wstripEl.addEventListener("click", (e) => {
	const c = (e.target as HTMLElement).closest<HTMLElement>("[data-wid]");
	if (c) void focusWorker(c.dataset.wterm!, c.dataset.wid!);
});

/** 親タブに切り替え、盤面の実行状況でその worker を目立たせる */
async function focusWorker(termId: string, id: string) {
	if (termId !== currentId) await showTerm(termId);
	if (current) closeDoc();
	workerFocus = id;
	openRun(termId);
	folded.delete("runs");
	store("folded", JSON.stringify([...folded]));
	renderBoard();
	boardEl.querySelector(".runs .w.hl")?.scrollIntoView({ block: "center", behavior: "smooth" });
	clearTimeout(workerFocusTimer);
	workerFocusTimer = window.setTimeout(() => {
		workerFocus = "";
		boardEl.querySelectorAll(".runs .w.hl").forEach((el) => el.classList.remove("hl"));
	}, 4000);
}

// 完了・止まっているの消える時機に合わせて見直す（変わったときだけ描き直す）
setInterval(() => {
	if (workersKey(Date.now()) !== stripKey) renderTabs();
}, 5000);

let links: Record<string, LinkInfo[]> = {};

/** vault 内は vault 相対、ホーム配下は ~/ で短く */
function shortPath(abs: string): string {
	const root = state ? state.managerDir.replace(/\/[^/]+$/, "") : "";
	if (root && abs.startsWith(root + "/")) return abs.slice(root.length + 1);
	return abs.replace(/^\/Users\/[^/]+/, "~");
}

function linksHtml(list: LinkInfo[] | undefined): string {
	if (!list?.length) return "";
	return `<ul class="lks">${list
		.slice(0, 8)
		.map((l) => {
			const sub = l.kind === "url" ? l.target.replace(/^https?:\/\//, "") : shortPath(l.target);
			return `<li class="lk ${l.kind}"><button class="link" type="button" data-lk="${l.kind}" data-target="${esc(l.target)}" title="${esc(l.target)}"><span class="via">${esc(l.via)}</span><span class="nm">${esc(l.label)}</span>${l.title && l.title !== l.label ? `<span class="ti">${esc(l.title)}</span>` : ""}</button><span class="pt">${esc(sub)}</span></li>`;
		})
		.join("")}</ul>`;
}

const ROLE: Record<TermInfo["kind"], string> = { main: "mgr", system: "システム", self: "自己改善", task: "sub mgr" };
const ACT_LABEL: Record<ActivitySpan["label"], string> = { task: "タスク", related: "関連の仕事", off: "関係ないこと", idle: "離席" };

// 各セッションの行は、会話が続いている間は開き、途切れたら畳む（判定と開閉の規則は runs-fold.ts）。
// 手で開閉したものは、次に判定が変わるまで自動では戻さない。状態は localStorage の runsFold / runsBusyAt に保つ。
let runFold = parseRunFold(load("runsFold"));
let lastBusyAt = parseBusyAt(load("runsBusyAt"));
let busyNow = new Set<string>();
/** 最後に描いた判定（期限切れで判定が変わったら描き直すため） */
let runsActiveKey = "";

function trackBusy() {
	({ lastBusyAt, busy: busyNow } = noteBusy(lastBusyAt, busyNow, terms, Date.now()));
	store("runsBusyAt", serializeBusyAt(lastBusyAt, terms.map((t) => t.id)));
}

function runActiveFlags(now: number): { key: string; active: boolean }[] {
	return terms.map((t) => ({
		key: t.id,
		active: isRunActive(
			{ running: t.running, busy: t.active, lastBusyAt: lastBusyAt.get(t.id) ?? 0, workerRunning: workers.some((w) => w.termId === t.id && w.state === "running") },
			now,
		),
	}));
}
const activeKey = (flags: { key: string; active: boolean }[]) => flags.map((f) => `${f.key}:${f.active ? 1 : 0}`).join(",");

function reconcileRuns(now: number) {
	const flags = runActiveFlags(now);
	runsActiveKey = activeKey(flags);
	if (!terms.length) return; // セッションがまだ届いていなければ、保存した開閉を消さない
	runFold = reconcileRunFold(runFold, flags);
	store("runsFold", serializeRunFold(runFold));
}

function runToggleHtml(key: string, title: string, open: boolean, has: boolean): string {
	if (!has) return '<span class="gtw" aria-hidden="true"></span>';
	return `<button class="gtw" type="button" data-rfold="${esc(key)}" aria-expanded="${open}" aria-label="${esc(`${title} の中身を${open ? "畳む" : "開く"}`)}">${open ? "▾" : "▸"}</button>`;
}

/** 手で開閉する（描き直さないので、押したボタンのフォーカスが残る） */
function toggleRun(key: string) {
	setRun(key, !(runFold.get(key)?.open ?? true));
}

/** worker の帯から来たときは、手で開いたのと同じ扱いで開く */
function openRun(key: string) {
	setRun(key, true);
}

function setRun(key: string, open: boolean) {
	runFold = setRunOpen(runFold, key, open);
	store("runsFold", serializeRunFold(runFold));
	const li = boardEl.querySelector<HTMLElement>(`.runs > li[data-rkey="${CSS.escape(key)}"]`);
	if (!li) return;
	li.classList.toggle("rfolded", !open);
	const b = li.querySelector<HTMLButtonElement>(":scope > [data-rfold]");
	if (!b) return;
	b.setAttribute("aria-expanded", String(open));
	b.textContent = open ? "▾" : "▸";
	b.setAttribute("aria-label", (b.getAttribute("aria-label") ?? "").replace(/(畳む|開く)$/, open ? "畳む" : "開く"));
}

// 最後の出力から RUN_ACTIVE_MS が過ぎても知らせは来ないので、30 秒ごとに判定を見直し、変わったときだけ描き直す
setInterval(() => {
	if (activeKey(runActiveFlags(Date.now())) !== runsActiveKey) renderBoard();
}, 30_000);

/** 活動の記録の最後の 1 区間 */
function activityLine(a: ActivitySpan | null): string {
	if (!a) return "";
	const what = [a.task, a.app, a.summary].filter(Boolean).join(" · ");
	return `<p class="act"><span class="role">活動</span><span class="tm">${esc(a.from)}–${esc(a.to)}</span><span class="lb lb-${esc(a.label)}">${esc(ACT_LABEL[a.label] ?? a.label)}</span><span class="sm" title="${esc(what)}">${esc(what)}</span></p>`;
}

function runsHtml(s: VaultState): string {
	reconcileRuns(Date.now());
	const shown = workers.filter((w) => w.state !== "done" || Date.now() - w.updatedAt < 2 * 60 * 60 * 1000);
	const items = terms
		.map((t) => {
			const all = shown.filter((w) => w.termId === t.id);
			// 帯のチップから来た worker は 7 件目より後でも出す
			const ws = all.slice(0, 6);
			const hl = workerFocus && !ws.some((w) => w.id === workerFocus) ? all.find((w) => w.id === workerFocus) : undefined;
			if (hl) ws.push(hl);
			const own = links[t.id];
			if (t.kind !== "task" && !ws.length && !t.active && !own?.length) return "";
			const st = t.active ? "作業中" : !t.running ? "休止" : t.unread ? "返事あり" : "待機";
			const open = runFold.get(t.id)?.open ?? true;
			const name = t.kind === "main" ? "全体" : t.title;
			const nl = Math.min(own?.length ?? 0, 8);
			const sum = [ws.length ? `worker ${ws.length}` : "", nl ? `ファイル・URL ${nl}` : ""].filter(Boolean).join(" · ");
			return `<li class="run ${runKindClass(t.kind)}${open ? "" : " rfolded"}" data-rkey="${esc(t.id)}">
				${runToggleHtml(t.id, name, open, !!sum)}<span class="role">${ROLE[t.kind]}</span><button class="link" type="button" data-term="${esc(t.id)}">${esc(name)}</button>
				<span class="rsum">${esc(sum)}</span><span class="st ${t.active ? "busy" : ""}">${st}</span>
				${linksHtml(own)}
				${
					ws.length
						? `<ul class="ws">${ws
								.map(
									(w) =>
										`<li class="w ${w.state}${w.id === workerFocus ? " hl" : ""}" data-wid="${esc(w.id)}"><div class="wh"><span class="role">worker</span><span class="ty">${esc(w.type)}</span><span class="de">${esc(w.description)}</span><span class="st">${WSTATE[w.state]}${w.state === "running" && w.lastTool ? ` · ${esc(toolName(w.lastTool))}` : ` · ${ago(w.updatedAt)}`}</span></div>${linksHtml(links[`worker:${w.id}`])}</li>`,
								)
								.join("")}</ul>`
						: ""
				}
			</li>`;
		})
		.filter(Boolean)
		.join("");
	return `<div class="${foldCls("runs")}" data-key="runs"><h2 data-fold="runs">実行状況</h2><div class="fold-body">${activityLine(s.activity)}${items ? `<ul class="runs">${items}</ul>` : '<p class="none">動いている sub mgr・worker はない</p>'}</div></div>`;
}

/** 実行状況のリンク：md はアプリ内のタブ、ほかのファイルは既定のアプリ、URL はブラウザ */
function openLink(kind: string, target: string) {
	if (kind === "url") return void api.openExternal({ url: target });
	if (/\.md$/i.test(target)) return void openDoc(target);
	void api.openPath({ path: target }).then((r) => !r.ok && toast(`開けなかった: ${target}`));
}

function toolName(name: string): string {
	return name.replace(/^mcp__(claude_ai_)?[^_]*?__/, "").replace(/^GAIA_[A-Za-z_]+?_MCP__/, "");
}

function lowerHtml(s: VaultState): string {
	const brief = s.briefs.find((b) => b.name === s.today);
	const jobs = s.jobs.filter((j) => fm(j, "enabled") !== "false");
	const slack = s.docs.find((x) => x.path === "slack/index.md");
	const link = (path: string, label: string, sub: string) =>
		`<li><button class="link" type="button" data-open="${esc(path)}">${esc(label)}</button><span>${esc(sub)}</span></li>`;
	return `<section class="lower">
		<div class="brief ${foldCls("brief")}" data-key="brief">
			<h2 data-fold="brief">今日のブリーフ${brief ? `<button class="link" type="button" data-open="${esc(brief.path)}">全文</button>` : ""}</h2>
			<div class="fold-body">${
				`<div class="brief-body">${timelineHtml(s)}${
					brief && briefDoc?.path === brief.path
						? `<div class="excerpt md">${md(briefExcerpt(briefDoc.body))}</div>`
						: `<p class="none">ブリーフはまだない。<button class="link" type="button" data-run="/gm">朝ブリーフを作る</button></p>`
				}</div>`
			}</div>
		</div>
		<div class="running">
			${runsHtml(s)}
			<div class="${foldCls("running")}" data-key="running">
			<h2 data-fold="running">動いているもの</h2>
			<div class="fold-body">
			<ul class="facts-list">
				${slack ? link("slack/index.md", "Slack", slack.summary) : ""}
				${link("inbox.md", "inbox", `未振り分け ${s.inboxCount} 件`)}
				${jobs.map((j) => link(j.path, titleOf(j), `${fm(j, "time")} ${fm(j, "days")}`.trim())).join("")}
				${link("goals.md", "目標", "四半期の目標と PJ")}
			</ul>
			${
				s.briefs.length > 1
					? `<h3>前のブリーフ</h3><p class="older">${s.briefs
							.filter((b) => b.name !== s.today)
							.slice(0, 5)
							.map((b) => `<button class="link" type="button" data-open="${esc(b.path)}">${esc(md5(b.name))}</button>`)
							.join("")}</p>`
					: ""
			}
			</div>
			</div>
		</div>
	</section>`;
}

function briefExcerpt(body: string): string {
	const lines = body.split("\n");
	const start = Math.max(0, lines.findIndex((l) => /^##\s/.test(l)));
	return lines.slice(start, start + 14).join("\n");
}

// ───────── 折りたたみ（見出しを押す。状態は次回も保つ） ─────────

const folded = new Set<string>(JSON.parse(load("folded") ?? "[]") as string[]);
function foldCls(key: string) {
	return `fold${folded.has(key) ? " folded" : ""}`;
}

boardEl.addEventListener("click", (e) => {
	const t = e.target as HTMLElement;
	const fold = t.closest<HTMLElement>("[data-fold]");
	if (fold && !t.closest("button, a, label, input")) {
		const key = fold.dataset.fold!;
		if (folded.has(key)) folded.delete(key);
		else folded.add(key);
		store("folded", JSON.stringify([...folded]));
		fold.parentElement?.classList.toggle("folded", folded.has(key));
		return;
	}
	const wt = t.closest<HTMLElement>("[data-wbs-toggle]");
	if (wt) return toggleWbs(wt.dataset.wbsToggle!);
	const rt = t.closest<HTMLElement>("[data-rfold]");
	if (rt) return toggleRun(rt.dataset.rfold!);
	const wa = t.closest<HTMLElement>("[data-wbs-all]");
	if (wa) return setAllWbs(wa.dataset.wbsAll === "fold");
	const ask = t.closest<HTMLElement>("[data-ask]");
	if (ask) return talkAbout(ask.dataset.ask!, ask.dataset.prep === "1");
	const deep = t.closest<HTMLElement>("[data-deep]");
	if (deep) return openTaskTerm(deep.dataset.deep!);
	const lk = t.closest<HTMLElement>("[data-lk]");
	if (lk) return openLink(lk.dataset.lk!, lk.dataset.target!);
	const term = t.closest<HTMLElement>("[data-term]");
	if (term) return void showTerm(term.dataset.term!);
	const iview = t.closest<HTMLElement>("[data-iview]");
	if (iview) {
		ideasView = iview.dataset.iview === "graph" ? "graph" : "list";
		store("ideasView", ideasView);
		folded.delete("ideas");
		store("folded", JSON.stringify([...folded]));
		return renderBoard();
	}
	const gopen = t.closest<HTMLElement>("[data-btab]");
	if (gopen?.dataset.btab === GRAPH_TAB) return openGraphTab();
	const ideas = t.closest<HTMLElement>("[data-ideas]");
	if (ideas) return showIdeasOf(ideas.dataset.ideas!);
	const run = t.closest<HTMLElement>("[data-run]");
	if (run) return void showTerm("main").then(() => typeLine(run.dataset.run!));
	const open = t.closest<HTMLElement>("[data-open]");
	if (open) openDoc(open.dataset.open!);
});

// ───────── ノート（ダッシュボードとタブで切り替える） ─────────

type DocTab = { path: string; label: string; scroll: number };
let docTabs: DocTab[] = [];
const boardTabsEl = $("board-tabs");
const isVaultPath = (p: string) => !p.startsWith("/");

async function openDoc(path: string, keepScroll = false) {
	if (path === GRAPH_TAB) return openGraphTab();
	if (path === PEOPLE_TAB) return openPeopleTab();
	if (path === NOW_TAB) return openNow(keepScroll);
	if (path === SHEET_TAB) return openSheet();
	const doc = await api.readDoc({ path });
	if (!doc) return toast(`開けなかった: ${path}`);
	rememberScroll();
	let tab = docTabs.find((t) => t.path === doc.path);
	const reopen = !!tab;
	if (!tab) {
		tab = { path: doc.path, label: docLabel(doc.path), scroll: 0 };
		docTabs.push(tab);
	}
	const sameDoc = current?.path === doc.path;
	current = doc;
	readerEl.hidden = false;
	readerScroll.hidden = false;
	graphTabEl.hidden = true;
	sheetTabEl.hidden = true;
	peopleTab.setVisible(false);
	readerPath.textContent = isVaultPath(doc.path) ? doc.path : shortPath(doc.path);
	$("open-obsidian").textContent = isVaultPath(doc.path) ? "Obsidian で開く" : "既定のアプリで開く";
	const today = state?.today ?? "";
	propsEl.innerHTML = Object.entries(doc.fm)
		.filter(([k, v]) => v !== "" && !["permalink", "title"].includes(k))
		.map(([k, v]) => {
			const hot = k === "due" && v <= today && !["done", "dropped", "完了"].includes(doc.fm["status"] ?? "");
			return `<dt>${esc(k)}</dt><dd class="${hot ? "hot" : ""}">${esc(v)}</dd>`;
		})
		.join("");
	docEl.innerHTML = md(doc.body);
	readerScroll.scrollTop = keepScroll && sameDoc ? tab.scroll : reopen ? tab.scroll : 0;
	renderDocTabs();
}

// ───────── 「今」タブ（集中用。フォーカスのタスクと、人への問い合わせだけ） ─────────

/** 返信欄の書きかけ（再描画しても消さない） */
const replyDrafts = new Map<string, string>();
let nowSending = false;

function nowFocusHtml(f: NonNullable<NowView["focus"]>): string {
	const today = state?.today ?? "";
	const hot = f.due && f.due <= today && !["done", "dropped"].includes(f.status);
	const row = (k: string, v: string, cls = "") => (v ? `<dt>${k}</dt><dd class="${cls}">${esc(v)}</dd>` : "");
	const flag = f.provisional
		? `<p class="now-flag">仮 — mgr がまだ決めていないので、doing で期限が最も近いタスクを出している${f.note ? `（${esc(f.note)}）` : ""}</p>`
		: "";
	const section = (h: string, body: string) => (body ? `<h3>${h}</h3><div class="now-md">${md(body)}</div>` : `<h3>${h}</h3><p class="now-empty">未記入</p>`);
	const related = [
		f.research ? `<a href="#" data-open="${esc(f.research)}">下調べ（${esc(f.research)}）</a>` : "",
		`<a href="#" data-open="${esc(f.taskPath)}">タスクノート</a>`,
	]
		.filter(Boolean)
		.join(" ・ ");
	return `<section class="now-focus">${flag}<h2 class="now-title">${esc(f.title)}</h2>
<dl class="now-props">${row("次の一手", f.nextAction)}${row("期限", f.due, hot ? "hot" : "")}${row("待ち", f.waitingFor)}${row("状態", f.status)}</dl>
${f.reason ? `<p class="now-reason">${esc(f.reason)}</p>` : ""}
${section("完了条件", f.goalMd)}${section("手順", f.stepsMd)}
<p class="now-related">関連: ${related}</p></section>`;
}

function nowInquiryHtml(q: Inquiry): string {
	const p = esc(q.path);
	const input = q.options.length
		? `<div class="now-opts">${q.options.map((o) => `<button type="button" class="now-opt" data-now-opt="${esc(o)}" data-now-path="${p}">${esc(o)}</button>`).join("")}</div>`
		: `<div class="now-answer"><textarea class="now-input" rows="2" data-now-input="${p}" placeholder="返信（Cmd+Enter で送る）">${esc(replyDrafts.get(q.path) ?? "")}</textarea><button type="button" class="now-send" data-now-send="${p}">送る</button></div>`;
	const pending = q.reply ? `<p class="now-pending">返信済み・宛先のセッションが閉じていて未配達: ${esc(q.reply)}</p>` : "";
	return `<article class="now-q"><header><span class="now-from">${esc(q.from)}</span><span class="now-qtitle">${esc(q.title)}</span><a href="#" class="now-qopen" data-open="${p}">ノート</a></header>
<div class="now-md">${md(q.bodyMd)}</div>${pending}${input}</article>`;
}

function nowHtml(v: NowView): string {
	const focus = v.focus ? nowFocusHtml(v.focus) : `<section class="now-focus"><p class="now-empty">いま決まっているタスクがない（now.json も doing のタスクもない）</p></section>`;
	const inq = v.inquiries.length
		? `<section class="now-inquiries"><h3>問い合わせ（${v.inquiries.length}）</h3>${v.inquiries.map(nowInquiryHtml).join("")}</section>`
		: "";
	return `<div class="now">${focus}${inq}</div>`;
}

async function openNow(keepScroll = false) {
	const view = await api.now({});
	rememberScroll();
	let tab = docTabs.find((t) => t.path === NOW_TAB);
	const reopen = !!tab;
	if (!tab) {
		tab = { path: NOW_TAB, label: NOW_LABEL, scroll: 0 };
		docTabs.push(tab);
	}
	const sameDoc = current?.path === NOW_TAB;
	const focused = document.activeElement instanceof HTMLTextAreaElement && docEl.contains(document.activeElement) ? document.activeElement.dataset["nowInput"] : undefined;
	current = { path: NOW_TAB, fm: {}, body: "", mtime: 0 };
	readerEl.hidden = false;
	readerScroll.hidden = false;
	graphTabEl.hidden = true;
	sheetTabEl.hidden = true;
	peopleTab.setVisible(false);
	$("talk-about").hidden = true;
	$("open-obsidian").hidden = true;
	readerPath.textContent = "今（読み取りのみ。決めるのは mgr、問い合わせへの返信だけここでできる）";
	propsEl.innerHTML = "";
	docEl.innerHTML = nowHtml(view);
	readerScroll.scrollTop = keepScroll && sameDoc ? tab.scroll : reopen ? tab.scroll : 0;
	if (focused) docEl.querySelector<HTMLTextAreaElement>(`textarea[data-now-input="${CSS.escape(focused)}"]`)?.focus();
	renderDocTabs();
}

// ───────── 「シート」タブ（sheet-preview のハブを iframe で出す。起動はしない） ─────────

/** ハブの状態（bun 側が ping する。views:// からは CORS で読めないので画面側では確かめない） */
async function sheetState(): Promise<SheetState> {
	try {
		return (await api.sheetHub({})).state;
	} catch {
		return "down";
	}
}

async function openSheet() {
	rememberScroll();
	if (!docTabs.some((t) => t.path === SHEET_TAB)) docTabs.push({ path: SHEET_TAB, label: SHEET_LABEL, scroll: 0 });
	current = { path: SHEET_TAB, fm: {}, body: "", mtime: 0 };
	readerEl.hidden = false;
	readerScroll.hidden = true;
	graphTabEl.hidden = true;
	sheetTabEl.hidden = false;
	peopleTab.setVisible(false);
	$("talk-about").hidden = true;
	$("open-obsidian").hidden = true;
	readerPath.textContent = "シート（sheet-preview のハブ。読み取りタブ）";
	renderDocTabs();
	sheetTabEl.innerHTML = "";
	const alive = await sheetState();
	if (current?.path !== SHEET_TAB) return; // 確認中に別のタブへ移った
	sheetTabEl.innerHTML = sheetHtml(alive);
}
sheetTabEl.addEventListener("click", (e) => {
	if ((e.target as HTMLElement).closest("[data-sheet-recheck]")) void openSheet();
});

async function sendReply(path: string, text: string) {
	if (nowSending || !canSendReply(text)) return;
	nowSending = true;
	try {
		const r = await api.replyInquiry({ path, text });
		if (!r.ok) toast(`返信できなかった: ${r.error ?? "不明"}`);
		else {
			replyDrafts.delete(path);
			toast(r.delivered ? "届けた（問い合わせは完了にした）" : "宛先のセッションが閉じているので、対応中のまま reply に残した（次に開いたとき処理される）");
		}
	} catch {
		toast("返信できなかった");
	} finally {
		nowSending = false;
	}
	await refreshState();
	if (current?.path === NOW_TAB) await openNow(true);
}

docEl.addEventListener("input", (e) => {
	const t = e.target as HTMLElement;
	if (t instanceof HTMLTextAreaElement && t.dataset["nowInput"]) replyDrafts.set(t.dataset["nowInput"], t.value);
});
docEl.addEventListener("keydown", (e) => {
	const t = e.target as HTMLElement;
	if (t instanceof HTMLTextAreaElement && t.dataset["nowInput"] && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
		e.preventDefault();
		void sendReply(t.dataset["nowInput"], t.value);
	}
});
docEl.addEventListener("click", (e) => {
	const el = e.target as HTMLElement;
	const opt = el.closest<HTMLElement>("[data-now-opt]");
	if (opt) return void sendReply(opt.dataset["nowPath"]!, opt.dataset["nowOpt"]!);
	const send = el.closest<HTMLElement>("[data-now-send]");
	if (send) {
		const ta = docEl.querySelector<HTMLTextAreaElement>(`textarea[data-now-input="${CSS.escape(send.dataset["nowSend"]!)}"]`);
		if (ta) void sendReply(send.dataset["nowSend"]!, ta.value);
	}
});

function rememberScroll() {
	const tab = current && docTabs.find((t) => t.path === current!.path);
	if (tab) tab.scroll = readerScroll.scrollTop;
}

/** ダッシュボードに戻る（タブは残す） */
function closeDoc() {
	rememberScroll();
	current = null;
	readerEl.hidden = true;
	peopleTab.setVisible(false);
	renderDocTabs();
	mountGraph(); // アイデア欄がグラフなら、そこへ戻す
}

async function closeDocTab(path: string) {
	const i = docTabs.findIndex((t) => t.path === path);
	if (i < 0) return;
	docTabs.splice(i, 1);
	if (current?.path !== path) return renderDocTabs();
	current = null;
	const next = docTabs[i] ?? docTabs[i - 1];
	if (next) await openDoc(next.path);
	else closeDoc();
}

function renderDocTabs() {
	boardTabsEl.innerHTML =
		`<button class="btab" type="button" data-btab="" aria-current="${current === null}">ダッシュボード</button>` +
		`<button class="btab btab-now" type="button" data-btab="${NOW_TAB}" aria-current="${current?.path === NOW_TAB}" title="いま集中すること（未回答の問い合わせ件数がバッジ）">${NOW_LABEL}${nowBadgeHtml()}</button>` +
		`<button class="btab btab-sheet" type="button" data-btab="${SHEET_TAB}" aria-current="${current?.path === SHEET_TAB}" title="スプレッドシートのプレビュー（sheet-preview のハブ）">${SHEET_LABEL}</button>` +
		dynamicDocTabs(docTabs)
			.map(
				(t) =>
					`<button class="btab" type="button" data-btab="${esc(t.path)}" aria-current="${current?.path === t.path}" title="${esc(t.path)}"><span class="label">${esc(t.label)}</span><span class="x" data-bclose="${esc(t.path)}" title="閉じる">×</span></button>`,
			)
			.join("") +
	(docTabs.some((t) => t.path === GRAPH_TAB) ? "" : `<button class="btab gopen" type="button" data-btab="${GRAPH_TAB}" title="アイデア・タスク・目標・PJ のつながりを大きく見る">アイデアのグラフ</button>`) +
		(docTabs.some((t) => t.path === PEOPLE_TAB) ? "" : `<button class="btab gopen" type="button" data-btab="${PEOPLE_TAB}" title="関係者の人物と、プロジェクトでの指揮命令系統・関係をグラフと表で見る">${PEOPLE_LABEL}</button>`);
}
function nowBadgeHtml(): string {
	const b = nowBadge(unansweredCount(state?.messages ?? []));
	return b ? `<span class="now-badge" aria-label="未回答の問い合わせ ${esc(b)} 件">${b}</span>` : "";
}
boardTabsEl.addEventListener("click", (e) => {
	const el = e.target as HTMLElement;
	const close = el.closest<HTMLElement>("[data-bclose]");
	if (close) return void closeDocTab(close.dataset.bclose!);
	const b = el.closest<HTMLElement>("[data-btab]");
	if (!b) return;
	if (b.dataset.btab) void openDoc(b.dataset.btab);
	else closeDoc();
});

$("reader-close").addEventListener("click", () => current && void closeDocTab(current.path));
$("talk-about").addEventListener("click", () => current && pasteQuote(current.path, "", firstLines(current)));
$("open-obsidian").addEventListener("click", () => {
	if (!current) return;
	if (isVaultPath(current.path)) void api.openInObsidian({ path: current.path });
	else void api.openPath({ path: current.path });
});
document.addEventListener("keydown", (e) => {
	if (e.key !== "Escape") return;
	if (!pinBtn.hidden) return hidePin();
	if (current && !stackEl.contains(document.activeElement)) closeDoc();
});
renderDocTabs();

function firstLines(doc: Doc): string {
	const keys = ["status", "ready", "next_action", "due"].filter((k) => doc.fm[k]);
	const head = keys.map((k) => `${k}: ${doc.fm[k]}`).join(" / ");
	return head || doc.body.trim().split("\n").find((l) => l.trim() && !l.startsWith("#"))?.slice(0, 120) || "";
}

// リンク（ノート共通）
document.addEventListener("click", (e) => {
	const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a");
	if (!a || stackEl.contains(a)) return;
	e.preventDefault();
	if (a.dataset.wiki) openDoc(a.dataset.wiki);
	else if (a.href && !a.href.startsWith("views://")) api.openExternal({ url: a.href });
});

// ───────── 選んだ文：ターミナルの入力欄に貼る ─────────

/** 参照をターミナルに貼る（送信はしない。続きを書いて Enter） */
function pasteQuote(path: string, heading: string, text: string) {
	const where = heading ? `${path} › ${heading}` : path;
	const quoted = text
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n");
	paste(`[参照] ${where}\n${quoted}\n`);
}

function talkAbout(path: string, prep: boolean) {
	const it = state && [...state.tasks, ...state.messages, ...state.briefs, ...state.jobs, ...state.docs, ...state.ideas, ...state.research].find((i) => i.path === path);
	if (!it) return;
	const text = it.fm["next_action"] ? `next_action: ${it.fm["next_action"]}` : it.summary;
	// sub mgr がいればそこで話す
	const term = termOfTask(path);
	const go = term && term.id !== currentId ? showTerm(term.id) : Promise.resolve();
	void go.then(() => {
		pasteQuote(path, "", text);
		if (prep) paste(`このタスクを着手できる状態にしたい。足りないもの（${missing(it).join("・") || "確認"}）を一緒に決めて`);
	});
}

let pendingQuote: { path: string; heading: string; text: string } | null = null;
document.addEventListener("mouseup", (e) => {
	if ((e.target as HTMLElement).closest("#pin")) return;
	setTimeout(() => {
		const sel = window.getSelection();
		const text = sel?.toString().trim() ?? "";
		if (!sel || sel.isCollapsed || !text) return hidePin();
		const node = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
		const inDoc = node?.closest("#doc");
		const inBrief = node?.closest(".brief .excerpt");
		const container = (inDoc ?? inBrief) as HTMLElement | null;
		if (!container) return hidePin();
		pendingQuote = {
			path: inDoc ? current?.path ?? "" : briefDoc?.path ?? "ブリーフ",
			heading: nearestHeading(node!, container),
			text: text.slice(0, 1200),
		};
		const r = sel.getRangeAt(0).getBoundingClientRect();
		pinBtn.hidden = false;
		const w = pinBtn.offsetWidth;
		pinBtn.style.left = `${Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8)}px`;
		pinBtn.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 40)}px`;
	}, 0);
});
function hidePin() {
	pinBtn.hidden = true;
	pendingQuote = null;
}
pinBtn.addEventListener("click", () => {
	if (pendingQuote) pasteQuote(pendingQuote.path, pendingQuote.heading, pendingQuote.text);
	window.getSelection()?.removeAllRanges();
	hidePin();
});

function nearestHeading(node: Element, container: HTMLElement): string {
	let el: Element | null = node;
	while (el && el.parentElement !== container) el = el.parentElement;
	for (let sib = el; sib; sib = sib.previousElementSibling) {
		if (/^H[1-4]$/.test(sib.tagName)) return `${"#".repeat(Number(sib.tagName[1]))} ${sib.textContent?.trim() ?? ""}`;
	}
	return "";
}

// ───────── ターミナル ─────────

type TV = { term: Terminal; fit: FitAddon; el: HTMLDivElement; attached: boolean };
const tvs = new Map<string, TV>();
const termOfTask = (path: string) => terms.find((t) => t.taskPath === path);

const THEME = {
	background: "rgba(0, 0, 0, 0)", // ガラスのカード（.dock）を透かす

	foreground: "#e2e6dc",
	cursor: "#e2e6dc",
	cursorAccent: "#1b201c",
	selectionBackground: "#4f5c4a",
};

function ensureTV(id: string): TV {
	let tv = tvs.get(id);
	if (tv) return tv;
	const el = document.createElement("div");
	el.className = "term";
	el.hidden = true;
	stackEl.appendChild(el);
	const term = new Terminal({
		fontFamily: TERM_FONT,
		fontSize: termFontSize,
		lineHeight: 1.15,
		theme: THEME,
		allowTransparency: true,
		allowProposedApi: true,
		scrollback: 5000,
		macOptionIsMeta: true,
		cursorBlink: false,
	});
	const fit = new FitAddon();
	term.loadAddon(fit);
	term.loadAddon(new Unicode11Addon());
	term.unicode.activeVersion = "11";
	term.open(el);
	registerPathLinks(term, id, linkDeps(id));
	term.onData((data) => post.termInput({ id, data }));
	// Shift+Enter は改行（claude では Option+Enter と同じ ESC+CR）。
	// xterm は keydown のあと keypress でも Enter を送るので、Shift+Enter のイベントはすべて止め、送るのは keydown の 1 回だけにする。
	// 日本語入力の確定中（isComposing）は IME に任せる。
	term.attachCustomKeyEventHandler((e) => {
		if (e.key === "Enter" && e.shiftKey && !e.isComposing && !e.metaKey && !e.ctrlKey && !e.altKey) {
			if (e.type === "keydown") {
				e.preventDefault();
				post.termInput({ id, data: "\x1b\r" });
			}
			return false;
		}
		// 文字の大きさの操作と Ctrl+Tab（タブ切り替え）は端末に送らない（document 側で処理する）
		if (e.metaKey && (e.code === "Minus" || e.code === "Equal" || e.code === "Digit0")) return false;
		if (e.ctrlKey && e.key === "Tab") return false;
		if (e.metaKey && (e.code === "KeyW" || e.code === "BracketLeft" || e.code === "BracketRight")) return false;
		return true;
	});
	term.onResize(({ cols, rows }) => post.termResize({ id, cols, rows }));
	tv = { term, fit, el, attached: false };
	tvs.set(id, tv);
	return tv;
}

// ───────── ドッキングシェル（claude タブごとに 1 つ。ボタンで claude と切り替える。bun/shell.ts） ─────────
// claude とは別の RPC（shellOpen / shellInput / shellResize / shellData）で動かす。claude の入力中・出力中の判定には混ざらない。

type ShellTV = { term: Terminal; fit: FitAddon; el: HTMLDivElement; opened: boolean };
const shellTvs = new Map<string, ShellTV>();
/** シェルを前に出している claude タブ id */
const shellOn = new Set<string>();
/** File タブを前に出している claude タブ id（起点はそのタブの claude の cwd。bun/files.ts） */
const fileOn = new Set<string>();
const fileEl = document.createElement("div");
fileEl.hidden = true;
stackEl.appendChild(fileEl);
const fileTab = new FileTab(fileEl, api);

function ensureShellTV(id: string): ShellTV {
	let tv = shellTvs.get(id);
	if (tv) return tv;
	const el = document.createElement("div");
	el.className = "term shell";
	el.hidden = true;
	stackEl.appendChild(el);
	const term = new Terminal({
		fontFamily: TERM_FONT,
		fontSize: termFontSize,
		lineHeight: 1.15,
		theme: THEME,
		allowTransparency: true,
		allowProposedApi: true,
		scrollback: 1500,
		macOptionIsMeta: true,
		cursorBlink: false,
	});
	const fit = new FitAddon();
	term.loadAddon(fit);
	term.loadAddon(new Unicode11Addon());
	term.unicode.activeVersion = "11";
	term.open(el);
	registerPathLinks(term, id, linkDeps(id));
	term.onData((data) => post.shellInput({ id, data }));
	term.attachCustomKeyEventHandler((e) => {
		if (e.metaKey && (e.code === "Minus" || e.code === "Equal" || e.code === "Digit0" || e.code === "KeyJ")) return false;
		if (e.ctrlKey && e.key === "Tab") return false;
		if (e.metaKey && (e.code === "KeyW" || e.code === "BracketLeft" || e.code === "BracketRight")) return false;
		return true;
	});
	term.onResize(({ cols, rows }) => post.shellResize({ id, cols, rows }));
	tv = { term, fit, el, opened: false };
	shellTvs.set(id, tv);
	return tv;
}

/** 今のタブの表示（claude / シェル）を反映する。初めてシェルを出すときだけ起動を頼む */
async function applyMode() {
	const id = currentId;
	const on = shellOn.has(id);
	const files = fileOn.has(id);
	for (const [tid, tv] of tvs) tv.el.hidden = files || on || tid !== id;
	for (const [tid, tv] of shellTvs) tv.el.hidden = files || !on || tid !== id;
	fileEl.hidden = !files;
	if (!files) void fileTab.closeQuickLook();
	if (files) {
		await fileTab.show(id);
	} else if (on) {
		const tv = ensureShellTV(id);
		tv.el.hidden = false;
		fitCurrent();
		requestAnimationFrame(fitCurrent);
		if (!tv.opened) {
			tv.opened = true;
			const { buffer } = await api.shellOpen({ id, cols: tv.term.cols, rows: tv.term.rows });
			tv.term.reset();
			tv.term.write(buffer);
		}
		if (shellOn.has(id) && currentId === id) tv.term.focus();
	} else {
		const tv = tvs.get(id);
		if (tv) tv.el.hidden = false;
		fitCurrent();
		requestAnimationFrame(fitCurrent);
		tv?.term.focus();
	}
	renderModes();
}

function setMode(mode: "claude" | "shell" | "file"): Promise<void> {
	shellOn.delete(currentId);
	fileOn.delete(currentId);
	if (mode === "shell") shellOn.add(currentId);
	if (mode === "file") fileOn.add(currentId);
	return applyMode();
}

/** ターミナルのパスを Cmd+クリック: File タブへ切り替え、そのディレクトリ（ファイルなら親）で選択して見せる */
function openPathInFileTab(id: string, path: string) {
	if (id !== currentId) return;
	void setMode("file").then(() => fileTab.go(path));
}
const linkDeps = (id: string) => ({ probe: api.filesProbe, open: (p: string) => openPathInFileTab(id, p) });
function setShell(on: boolean) {
	void setMode(on ? "shell" : "claude");
}

function renderModes() {
	const on = shellOn.has(currentId);
	const files = fileOn.has(currentId);
	modesEl.innerHTML =
		`<button type="button" class="mode" data-mode="claude" aria-current="${!on && !files}" title="Claude（⌘J で切り替え）">Claude</button>` +
		`<button type="button" class="mode" data-mode="shell" aria-current="${on}" title="このタブの Shell（⌘J で切り替え）">Shell</button>` +
		`<button type="button" class="mode" data-mode="file" aria-current="${files}" title="claude の cwd 起点のファイル一覧（Space でプレビュー）">File</button>`;
}
modesEl.addEventListener("click", (e) => {
	const b = (e.target as HTMLElement).closest<HTMLElement>("[data-mode]");
	if (b) setMode(b.dataset.mode as "claude" | "shell" | "file");
});

async function showTerm(id: string) {
	if (!terms.some((t) => t.id === id)) return;
	if (id !== currentId) leftAt.set(currentId, Date.now());
	currentId = id;
	const tv = ensureTV(id);
	await applyMode();
	if (!tv.attached) {
		const { buffer } = await api.attach({ id, cols: tv.term.cols, rows: tv.term.rows });
		tv.term.reset();
		tv.term.write(buffer);
		tv.attached = true;
	}
	post.termFocus({ id });
	if (!shellOn.has(id) && !fileOn.has(id)) tv.term.focus();
	renderTabs();
	renderFoot();
	renderBoard();
}

function onTermData(id: string, data: string) {
	const tv = tvs.get(id);
	if (tv?.attached) tv.term.write(data);
}

function paste(text: string) {
	if (shellOn.has(currentId) || fileOn.has(currentId)) setShell(false); // claude に貼る
	const tv = tvs.get(currentId);
	if (!tv) return;
	tv.term.paste(text);
	tv.term.focus();
}

/** 1 行打って Enter（スラッシュコマンド用） */
function typeLine(text: string) {
	if (shellOn.has(currentId) || fileOn.has(currentId)) setShell(false);
	post.termInput({ id: currentId, data: text });
	setTimeout(() => post.termInput({ id: currentId, data: "\r" }), 60);
	tvs.get(currentId)?.term.focus();
}

/** 今のターミナルを枠に合わせ直す（隠れているタブは showTerm で表示するときに合わせる） */
function fitCurrent() {
	const tv = shellOn.has(currentId) ? shellTvs.get(currentId) : tvs.get(currentId);
	// 寸法 0（畳んでいる・レイアウト確定前）で fit すると行数が 1〜2 になって表示が崩れるので何もしない
	if (tv && !tv.el.hidden && stackEl.clientWidth > 0 && stackEl.clientHeight > 20) tv.fit.fit();
}
// 境界のドラッグ・配置の切り替え・ウィンドウの大きさの変化はすべてここで拾う
new ResizeObserver(() => fitCurrent()).observe(stackEl);

// ───────── 文字の大きさ（⌘- で小さく、⌘⇧- で大きく、⌘0 で戻す） ─────────
// 最後に触った側（ダッシュボード / ターミナル）に効く。

const boardMain = document.querySelector<HTMLElement>(".board")!;
const ZOOMS = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.7];
let boardZoom = Number(load("boardZoom")) || 1;
let lastArea: "board" | "term" = "term";

document.addEventListener("pointerdown", (e) => {
	const t = e.target as HTMLElement;
	if (boardMain.contains(t)) lastArea = "board";
	else if (t.closest(".dock")) lastArea = "term";
	appEl.dataset.focus = lastArea;
}, true);
document.addEventListener("focusin", (e) => {
	if (stackEl.contains(e.target as Node)) lastArea = "term";
	appEl.dataset.focus = lastArea;
});

function applyBoardZoom() {
	// zoom は WebKit で効き、レイアウトごと拡大縮小する（transform と違って崩れない）
	(boardMain.style as CSSStyleDeclaration & { zoom: string }).zoom = String(boardZoom);
	// iframe（シートタブ）は zoom の分だけ表示領域が縮む（0.8 倍なら 80%）。逆数の zoom を CSS 変数で渡して打ち消す
	boardMain.style.setProperty("--board-zoom", String(boardZoom));
}

function setBoardZoom(step: number | "reset") {
	if (step === "reset") boardZoom = 1;
	else {
		const i = ZOOMS.findIndex((z) => z >= boardZoom - 0.001);
		const next = ZOOMS[Math.min(Math.max((i < 0 ? ZOOMS.length - 1 : i) + step, 0), ZOOMS.length - 1)]!;
		boardZoom = next;
	}
	store("boardZoom", String(boardZoom));
	applyBoardZoom();
	toast(`ダッシュボード ${Math.round(boardZoom * 100)}%`);
}
applyBoardZoom();

function setTermFont(size: number) {
	termFontSize = Math.min(Math.max(size, 8), 24);
	store("termFontSize", String(termFontSize));
	for (const tv of tvs.values()) tv.term.options.fontSize = termFontSize;
	for (const tv of shellTvs.values()) tv.term.options.fontSize = termFontSize;
	const tv = shellOn.has(currentId) ? shellTvs.get(currentId) : tvs.get(currentId);
	if (tv && !tv.el.hidden) tv.fit.fit();
	toast(`ターミナルの文字 ${termFontSize}px`);
}

// ───────── キー操作 ─────────
//   Ctrl+Tab / Ctrl+Shift+Tab : いまの側（ダッシュボード / ターミナル）のタブを次へ / 前へ
//   ⌘W                        : ダッシュボード側で開いているノートのタブを閉じる
//   ⌘[ / ⌘]                   : ダッシュボード（ノート）/ ターミナルにフォーカスを移す

function focusArea(area: "board" | "term") {
	lastArea = area;
	appEl.dataset.focus = area;
	if (area === "term") {
		(shellOn.has(currentId) ? shellTvs : tvs).get(currentId)?.term.focus();
		return;
	}
	(document.activeElement as HTMLElement | null)?.blur();
	(current ? readerScroll : boardEl).focus({ preventScroll: true });
}

function cycleBoardTab(dir: 1 | -1) {
	const tabs = ["", ...docTabs.map((t) => t.path)];
	if (tabs.length < 2) return;
	const i = tabs.indexOf(current?.path ?? "");
	const next = tabs[(i + dir + tabs.length) % tabs.length]!;
	if (next) void openDoc(next).then(() => focusArea("board"));
	else {
		closeDoc();
		focusArea("board");
	}
}

function cycleTerm(dir: 1 | -1) {
	if (terms.length < 2) return;
	const i = terms.findIndex((t) => t.id === currentId);
	void showTerm(terms[(i + dir + terms.length) % terms.length]!.id);
}

document.addEventListener(
	"keydown",
	(e) => {
		if (e.altKey) return;
		const ctrlTab = e.ctrlKey && !e.metaKey && e.key === "Tab";
		const cmd = e.metaKey && !e.ctrlKey;
		if (ctrlTab) {
			if (lastArea === "board") cycleBoardTab(e.shiftKey ? -1 : 1);
			else cycleTerm(e.shiftKey ? -1 : 1);
		} else if (cmd && !e.shiftKey && e.code === "KeyW") {
			if (lastArea === "board" && current) void closeDocTab(current.path).then(() => focusArea("board"));
			// ターミナル側では何もしない（ウィンドウや sub mgr を誤って閉じない）
		} else if (cmd && !e.shiftKey && e.code === "BracketLeft") {
			focusArea("board");
		} else if (cmd && !e.shiftKey && e.code === "BracketRight") {
			focusArea("term");
		} else if (cmd && !e.shiftKey && e.code === "KeyJ") {
			setShell(!shellOn.has(currentId));
		} else return;
		e.preventDefault();
		e.stopPropagation();
	},
	true,
);

document.addEventListener(
	"keydown",
	(e) => {
		if (!e.metaKey || e.altKey || e.ctrlKey) return;
		const board = lastArea === "board";
		// シートタブを見ているときは、盤面ではなくシートの文字を拡縮する（ハブ側が倍率を持つ。iframe にフォーカスがあるときはハブ側のキー処理が受ける）
		const sheetStep = sheetZoomStep(e);
		const sheetFrame = readerEl.querySelector<HTMLIFrameElement>(".sheet-frame");
		if (board && sheetStep !== null && current?.path === SHEET_TAB && sheetFrame?.contentWindow) {
			sheetFrame.contentWindow.postMessage(sheetZoomMessage(sheetStep), "http://localhost:8765");
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		if (e.code === "Minus") board ? setBoardZoom(e.shiftKey ? 1 : -1) : setTermFont(termFontSize + (e.shiftKey ? 1 : -1));
		else if (e.code === "Equal") board ? setBoardZoom(1) : setTermFont(termFontSize + 1);
		else if (e.code === "Digit0") board ? setBoardZoom("reset") : setTermFont(DEFAULT_FONT_SIZE);
		else return;
		e.preventDefault();
		e.stopPropagation();
	},
	true,
);

// ───────── 境界のドラッグ（ターミナルは右固定） ─────────

const appEl = $("app");
const splitter = $("splitter");
let ratio = Number(load("boardRatio")) || 0.7;

function applyLayout() {
	ratio = clampRatio(ratio);
	// fr の合計を 1 にすると、片方が最小幅に当たったとき余りが配られずターミナルの右に空白が出る（layout.ts）
	const flex = gridFlex(ratio);
	appEl.style.setProperty("--board", flex.board);
	appEl.style.setProperty("--dock", flex.dock);
}

splitter.addEventListener("pointerdown", (e) => {
	e.preventDefault();
	splitter.setPointerCapture(e.pointerId);
	appEl.classList.add("dragging");
	// 2 つの領域と境界が並ぶ範囲（.app の padding の内側）。盤面は zoom がかかるので盤面の矩形は使わない
	const r = appEl.getBoundingClientRect();
	const cs = getComputedStyle(appEl);
	const start = r.left + parseFloat(cs.paddingLeft);
	const end = r.right - parseFloat(cs.paddingRight);
	const gutter = splitter.getBoundingClientRect().width;
	const move = (ev: PointerEvent) => {
		ratio = ratioFromPointer(ev.clientX, start, end, gutter, MIN_SIZE);
		applyLayout();
	};
	let done = false;
	const up = () => {
		if (done) return;
		done = true;
		appEl.classList.remove("dragging");
		splitter.removeEventListener("pointermove", move);
		splitter.removeEventListener("pointerup", up);
		splitter.removeEventListener("pointercancel", up);
		splitter.removeEventListener("lostpointercapture", up);
		store("boardRatio", String(ratio));
		// 幅が確定してから、念のためもう一度合わせる（ResizeObserver の取りこぼし対策）
		requestAnimationFrame(fitCurrent);
	};
	splitter.addEventListener("pointermove", move);
	splitter.addEventListener("pointerup", up);
	splitter.addEventListener("pointercancel", up);
	splitter.addEventListener("lostpointercapture", up);
});
// ダブルクリックで 7:3 に戻す
splitter.addEventListener("dblclick", () => {
	ratio = 0.7;
	store("boardRatio", String(ratio));
	applyLayout();
	requestAnimationFrame(fitCurrent);
});
applyLayout();

// ───────── 縦タブの幅（左端のドラッグ。localStorage の vtabsW）とツールチップ ─────────

const dockEl = document.querySelector<HTMLElement>(".dock")!;
const vtabsGrip = $("vtabs-grip");
let vtabsW = parseVtabsW(load("vtabsW"));

function applyVtabsW() {
	vtabsW = clampVtabsW(vtabsW, dockEl.getBoundingClientRect().width);
	appEl.style.setProperty("--vtabs-w", `${vtabsW}px`);
}
vtabsGrip.addEventListener("pointerdown", (e) => {
	e.preventDefault();
	vtabsGrip.setPointerCapture(e.pointerId);
	appEl.classList.add("vtabs-dragging");
	const dr = dockEl.getBoundingClientRect();
	const move = (ev: PointerEvent) => {
		vtabsW = vtabsWFromPointer(ev.clientX, dr.right, dr.width);
		applyVtabsW();
	};
	let done = false;
	const up = () => {
		if (done) return;
		done = true;
		appEl.classList.remove("vtabs-dragging");
		vtabsGrip.removeEventListener("pointermove", move);
		vtabsGrip.removeEventListener("pointerup", up);
		vtabsGrip.removeEventListener("pointercancel", up);
		vtabsGrip.removeEventListener("lostpointercapture", up);
		store("vtabsW", String(vtabsW));
		requestAnimationFrame(fitCurrent);
	};
	vtabsGrip.addEventListener("pointermove", move);
	vtabsGrip.addEventListener("pointerup", up);
	vtabsGrip.addEventListener("pointercancel", up);
	vtabsGrip.addEventListener("lostpointercapture", up);
});
vtabsGrip.addEventListener("dblclick", () => {
	vtabsW = VTABS_DEFAULT;
	store("vtabsW", String(vtabsW));
	applyVtabsW();
	requestAnimationFrame(fitCurrent);
});
applyVtabsW();
// 窓やドックの幅が変わって上限を超えたら詰める（保存値は変えない）
new ResizeObserver(() => {
	if (appEl.classList.contains("vtabs-dragging")) return;
	const w = clampVtabsW(parseVtabsW(load("vtabsW")), dockEl.getBoundingClientRect().width);
	if (w !== vtabsW) {
		vtabsW = w;
		appEl.style.setProperty("--vtabs-w", `${w}px`);
	}
}).observe(dockEl);

// ツールチップ（WKWebView の title は出にくいのでカスタム。300ms 遅延、× の上では出さない）
const tabTip = $("tab-tip");
let tipTimer: ReturnType<typeof setTimeout> | undefined;
function hideTabTip() {
	clearTimeout(tipTimer);
	tabTip.hidden = true;
}
tabsEl.addEventListener("mouseover", (e) => {
	const tab = (e.target as HTMLElement).closest<HTMLElement>(".tab");
	hideTabTip();
	if (!tab || (e.target as HTMLElement).closest(".x") || appEl.classList.contains("vtabs-dragging")) return;
	tipTimer = setTimeout(() => {
		if (!tab.isConnected) return;
		const title = tab.dataset.tipTitle ?? "";
		const sub = tab.dataset.tipSub ?? "";
		const wait = tab.dataset.tipWait ?? "";
		tabTip.innerHTML = `<div class="tt-title">${esc(title)}</div>${wait ? `<div class="tt-wait">判断待ち: ${esc(wait)}</div>` : ""}${sub && sub !== title ? `<div class="tt-sub">${esc(sub)}</div>` : ""}`;
		tabTip.hidden = false;
		const p = tipPosition(tab.getBoundingClientRect(), { w: tabTip.offsetWidth, h: tabTip.offsetHeight }, { w: window.innerWidth, h: window.innerHeight });
		tabTip.style.left = `${p.left}px`;
		tabTip.style.top = `${p.top}px`;
	}, 300);
});
tabsEl.addEventListener("mouseleave", hideTabTip);
tabsEl.addEventListener("pointerdown", hideTabTip);
tabsEl.addEventListener("scroll", hideTabTip);

function onTerms(list: TermInfo[]) {
	terms = list;
	trackBusy();
	for (const [id, tv] of tvs) {
		if (!terms.some((t) => t.id === id)) {
			tv.term.dispose();
			tv.el.remove();
			tvs.delete(id);
		}
	}
	for (const [id, tv] of shellTvs) {
		if (!terms.some((t) => t.id === id)) {
			tv.term.dispose();
			tv.el.remove();
			shellTvs.delete(id);
			shellOn.delete(id);
			fileOn.delete(id);
		}
	}
	if (!terms.some((t) => t.id === currentId)) void showTerm("main");
	renderTabs();
	renderBoard();
}

function renderTabs() {
	const now = Date.now();
	const keepTop = tabsEl.scrollTop;
	const cur = terms.find((t) => t.id === currentId);
	document.querySelector<HTMLElement>(".dock")?.style.setProperty("--tab-dock", cur ? tabColor(cur.kind, cur.taskPath ?? cur.id) : "var(--focus)");
	tabsEl.innerHTML = terms
		.map((t) => {
			const wait = t.waiting ? `<span class="wait" data-wait="${t.waiting}" aria-label="判断待ち">!</span>` : "";
			const mk = t.active ? '<span class="mk busy"></span>' : t.unread ? '<span class="mk unread"></span>' : !t.running ? '<span class="mk off"></span>' : "";
			const close = t.kind === "task" ? `<span class="x" data-close="${esc(t.id)}" title="sub mgr を閉じる（タスクノートは残る）">×</span>` : "";
			const tip = t.taskPath ?? (t.kind === "system" ? "システム改修 sub mgr（manager システム自体の改修。日をまたいでも同じ会話）" : t.kind === "self" ? "自己改善 sub mgr（self impl mgr。eod 処理・retro・改善提案。日をまたいでも同じ会話）" : "mgr（人の窓口とルーティング）");
			const badge = t.id === currentId ? "" : workerBadge(t.id, now);
			return `<button class="tab" type="button" style="--tab-color:${tabColor(t.kind, t.taskPath ?? t.id)}" data-term="${esc(t.id)}" aria-current="${t.id === currentId}" data-tip-title="${esc(t.kind === "task" ? t.title : ROLE[t.kind])}" data-tip-sub="${esc(tip)}" data-tip-wait="${t.waiting ? esc(WAIT_LABEL[t.waiting]) : ""}">${wait}${mk}<span class="tx"><span class="role">${ROLE[t.kind]}</span>${t.kind === "task" ? `<span class="label">${esc(t.title)}</span>` : ""}</span>${badge}${close}</button>`;
		})
		.join("");
	tabsEl.scrollTop = keepTop;
	renderStrip(now);
	stripKey = workersKey(now);
}
tabsEl.addEventListener("click", async (e) => {
	const el = e.target as HTMLElement;
	const close = el.closest<HTMLElement>("[data-close]");
	if (close) {
		e.stopPropagation();
		await api.closeTerm({ id: close.dataset.close! });
		return;
	}
	const b = el.closest<HTMLElement>("[data-term]");
	if (b) void showTerm(b.dataset.term!);
});

async function openTaskTerm(taskPath: string) {
	const info = await api.openTask({ taskPath });
	if (!terms.some((t) => t.id === info.id)) terms = [...terms, info];
	await showTerm(info.id);
}

// ───────── 定型の呼びかけ ─────────

const MAIN_CMDS: [string, string][] = [
	["/boot-manager", "始業"],
	["/gm", "朝ブリーフ"],
	["/triage", "Slack 仕分け"],
	["/eod", "終業"],
];
const TASK_CMDS: [string, string][] = [
	["このタスクの完了条件・手順・期限を決めて、着手できる状態にしたい", "着手の準備"],
	["このタスクを WBS に分解したい。1 日以内の作業単位まで", "WBS に分解"],
	["判断に要る材料を下調べしてまとめて", "下調べ"],
	["ここまでの決定をタスクノートに書いて、next_action と ready を更新して", "記録する"],
];

function renderFoot() {
	const t = terms.find((x) => x.id === currentId);
	const cmds = t?.kind === "task" ? TASK_CMDS : t?.kind === "system" || t?.kind === "self" ? [] : MAIN_CMDS;
	footEl.innerHTML =
		cmds.map(([cmd, label]) => `<button type="button" data-cmd="${esc(cmd)}">${esc(label)}</button>`).join("");
	footEl.hidden = !cmds.length;
}
footEl.addEventListener("click", (e) => {
	const b = (e.target as HTMLElement).closest<HTMLElement>("[data-cmd]");
	if (b) typeLine(b.dataset.cmd!);
});

// ───────── 通知 ─────────

let toastTimer: ReturnType<typeof setTimeout> | null = null;
/** 下に出る短い知らせ。sticky は閉じるまで出しておく（案内用） */
function toast(text: string, action?: () => void, opts: { label?: string; sticky?: boolean } = {}) {
	toastEl.innerHTML =
		`<span>${esc(text)}</span>${action ? `<button type="button" class="link" data-act>${esc(opts.label ?? "開く")}</button>` : ""}` +
		(opts.sticky ? '<button type="button" class="link" data-dismiss>閉じる</button>' : "");
	toastEl.hidden = false;
	toastEl.querySelector("[data-act]")?.addEventListener("click", () => {
		action?.();
		toastEl.hidden = true;
	});
	toastEl.querySelector("[data-dismiss]")?.addEventListener("click", () => (toastEl.hidden = true));
	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = opts.sticky ? null : setTimeout(() => (toastEl.hidden = true), 6000);
}

// ───────── ファイル・パス・テキストのドロップ（ターミナルに Terminal.app と同じくエスケープしたパスを渡す） ─────────

initDrop({
	api,
	dock: document.querySelector<HTMLElement>(".dock")!,
	paste,
	toast: (text) => toast(text),
});

// ───────── ウィンドウが前面か（前面でなければ声かけを macOS の通知でも出す） ─────────

window.addEventListener("focus", () => post.windowFocus({ focused: true }));
window.addEventListener("blur", () => post.windowFocus({ focused: false }));
document.addEventListener("visibilitychange", () => {
	if (shouldRefreshNow(current?.path, document.visibilityState === "visible")) void openDoc(NOW_TAB, true);
	if (shouldRefreshSheet(current?.path, document.visibilityState === "visible")) void openDoc(SHEET_TAB);
});
document.addEventListener("visibilitychange", () => post.windowFocus({ focused: document.visibilityState === "visible" && document.hasFocus() }));

// ───────── ファイル変更の反映 ─────────

async function refreshState() {
	state = await api.getState({});
	const brief = state.briefs.find((b) => b.name === state!.today);
	briefDoc = brief ? await api.readDoc({ path: brief.path }) : null;
	goalsDoc = await api.readDoc({ path: "goals.md" });
	renderBoard();
	renderDocTabs(); // 「今」のバッジ（未回答の問い合わせ件数）
}

async function onStateChanged(paths: string[]) {
	await refreshState();
	if (current && paths.some((p) => p === current!.path)) openDoc(current.path, true);
	else if (current?.path === NOW_TAB && paths.some((p) => /^(messages\/|tasks\/|research\/|state\/ui\/now\.json$)/.test(p))) void openDoc(NOW_TAB, true);
}

// ───────── 起動 ─────────

(async () => {
	// 等幅フォントを先に読み込んでおく（xterm は開いた時点の字幅で桁を決める）
	try {
		await document.fonts.load(`${termFontSize}px "JetBrainsMono Nerd Font Mono"`);
	} catch {
		// なければ代わりのフォントで続ける
	}
	terms = await api.terms({});
	trackBusy();
	workers = await api.workers({});
	links = await api.links({});
	await refreshState();
	renderTabs();
	await restoreAfterReload();
})();

// ───────── 開発時のリロード（WebView だけ読み込み直したとき、開いていた画面に戻す） ─────────
// bun 側（dev-reload.ts）が画面のコードを作り直して location.reload() する。
// ターミナルは bun 側で動き続けており、showTerm の attach で直近の出力から描き直される。

function sessionGet(key: string): string | null {
	try {
		return sessionStorage.getItem(key);
	} catch {
		return null;
	}
}

window.addEventListener("pagehide", () => {
	rememberScroll();
	try {
		sessionStorage.setItem(
			RELOAD_KEY,
			encodeReloadState({ term: currentId, docs: docTabs.map((t) => ({ ...t })), current: current?.path ?? null, at: Date.now() }),
		);
	} catch {
		// 残せなければ、次は既定の画面で始める
	}
});

async function restoreAfterReload() {
	const saved = decodeReloadState(sessionGet(RELOAD_KEY), Date.now());
	try {
		sessionStorage.removeItem(RELOAD_KEY);
	} catch {
		// 読めない環境なら何もしない
	}
	if (saved && saved.docs.length) {
		docTabs = saved.docs;
		if (saved.current) await openDoc(saved.current);
		else renderDocTabs();
	}
	await showTerm(pickTerm(saved?.term, terms.map((t) => t.id)));
}
