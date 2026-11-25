// bun（メインプロセス）と webview で共有する型と RPC スキーマ。

export type Frontmatter = Record<string, string>;

/** タスクの準備状況（本文の「## 完了条件」「## 手順」から読む） */
type TaskPrep = {
	goal: boolean;
	steps: boolean;
	stepsDone: number;
	stepsTotal: number;
};

/** Manager/ 配下の 1 ノート（一覧用）。path は Manager/ からの相対パス。 */
export type Item = {
	path: string;
	name: string;
	fm: Frontmatter;
	/** 本文の先頭付近から取った 1 行要約 */
	summary: string;
	mtime: number;
	prep?: TaskPrep;
};

/** memory/people/ の人物ノート（関係者）。relation は本文の `- <relation> [[相手]]` の行 */
export type PersonNote = {
	path: string;
	name: string;
	fm: Frontmatter;
	/** note は `— 役職` など行末の補足（belongs_to の役職に使う） */
	rels: { rel: string; to: string; note?: string }[];
	/** `## Observations` の先頭の数行（プロフィールの材料） */
	profile: string[];
	mtime: number;
};

/** memory/org/ の組織ノート（type: org）。parent で親組織を指し、会社→部→課→グループと任意の深さでネストする */
export type OrgNote = {
	path: string;
	name: string;
	fm: Frontmatter;
	/** 親組織の名前（ノート名）。なければ最上位 */
	parent: string;
	mtime: number;
};

/** memory/pj/ のプロジェクトノート（type: pj）。`## 関係者` の行を読んだもの */
export type PjNote = {
	path: string;
	name: string;
	fm: Frontmatter;
	/** `## 要約` 節の行（先頭の数行） */
	summary: string[];
	members: { name: string; role: string }[];
	/** commands: from が to に指示 / reports_to: from が to に報告 / works_with: 無向 */
	links: { rel: "commands" | "reports_to" | "works_with"; from: string; to: string; note: string }[];
	mtime: number;
};

/** 1 日の予定（calendar/upcoming.md から） */
export type DayPlan = {
	date: string;
	allDay: string[];
	events: {
		start: string;
		end: string;
		title: string;
		status: string;
		meet: string;
		/** メモ・録画・文字起こし・添付 */
		links: { kind: string; title: string; url: string }[];
		note: string;
	}[];
	fetched: string;
};

/** ターミナルのセッションが呼んだサブエージェント（ワーカー） */
export type WorkerInfo = {
	id: string;
	termId: string;
	type: string;
	description: string;
	/** 作業中 / 完了 / 止まっている（5 分更新なし） / 失敗 / 止めた */
	state: "running" | "done" | "stalled" | "failed" | "killed";
	lastTool: string;
	startedAt: number;
	updatedAt: number;
	/** 終わった（完了・失敗・止めた）か止まった時刻。作業中は 0 */
	endedAt: number;
};

/** セッションの中で出てきたファイル・URL */
export type LinkInfo = {
	kind: "file" | "url";
	/** ファイルは絶対パス、URL はそのまま */
	target: string;
	/** ファイル名（同名が多いものは親フォルダ付き）、URL は見出し */
	label: string;
	/** md の見出し・frontmatter の title / name（あれば） */
	title: string;
	via: "言及" | "読んだ" | "開いた" | "直した" | "書いた";
	at: number;
};

/** 活動の記録の 1 区間（state/activity/YYYY-MM-DD.jsonl の 1 行） */
export type ActivitySpan = {
	from: string;
	to: string;
	label: "task" | "related" | "off" | "idle";
	task: string;
	app: string;
	summary: string;
};

/** 先読み（state/plan/lookahead.json）のタスク 1 件 */
export type LookaheadTask = {
	task: string;
	due?: string;
	input?: string;
	output?: string;
	effort_h?: number;
	start_reco?: string;
	prep_due_reco?: string;
	heavy?: boolean;
	simplify?: string;
	reason?: string;
};

export type Lookahead = { generated: string; horizon_days?: number; tasks: LookaheadTask[] };

export type VaultState = {
	managerDir: string;
	today: string;
	plan: DayPlan;
	/** 日本の祝日 { "2026-11-23": "勤労感謝の日" } */
	holidays: Record<string, string>;
	tasks: Item[];
	messages: Item[];
	briefs: Item[];
	jobs: Item[];
	/** inbox / goals / slack/index / calendar など単体のノート */
	docs: Item[];
	/** ideas/ のアイデア */
	ideas: Item[];
	/** memory/people/ の人物（関係者タブ） */
	people: PersonNote[];
	/** memory/org/ の組織（type: org のみ） */
	orgs: OrgNote[];
	/** memory/pj/ のプロジェクト（type: pj のみ） */
	projects: PjNote[];
	/** worker の定義（.claude/agents/*.md） */
	agents: Item[];
	/** research/ の下調べ（タスク 1 件に 1 ノート） */
	research: Item[];
	lookahead: Lookahead | null;
	/** 活動の記録の最後の 1 区間（今日の分） */
	activity: ActivitySpan | null;
	inboxCount: number;
	/** status=提案 の retro の件数（self impl mgr のカードに出す） */
	retroPending: number;
	scannedAt: number;
};

/** 「今」タブの、いま集中するタスク 1 件 */
export type NowFocus = {
	/** Manager/ からの相対パス（tasks/<名>.md） */
	taskPath: string;
	title: string;
	status: string;
	nextAction: string;
	due: string;
	waitingFor: string;
	/** 「## 完了条件」「## 手順」の本文（Markdown） */
	goalMd: string;
	stepsMd: string;
	/** research/<名>.md があればそのパス */
	research: string | null;
	/** state/ui/now.json の reason（仮のときは空） */
	reason: string;
	/** now.json がない・読めない・タスクがない。doing の中で期限が最も近いものを仮に出している */
	provisional: boolean;
	/** 仮にした理由（now.json のタスクが見つからない、など） */
	note: string;
};

/** 人への問い合わせ（messages/ のうち from があるもの） */
export type Inquiry = {
	path: string;
	title: string;
	from: string;
	status: string;
	priority: string;
	options: string[];
	/** 本文（Markdown） */
	bodyMd: string;
	/** 保存してある返信（宛先が閉じていて届いていないとき） */
	reply: string;
	created: string;
};

export type NowView = { focus: NowFocus | null; inquiries: Inquiry[] };

export type Doc = {
	/** Manager/ からの相対パス。vault 内の Manager/ 外は "../DailyNote/..." の形 */
	path: string;
	fm: Frontmatter;
	body: string;
	mtime: number;
};

/**
 * ターミナル 1 つ = claude の対話セッション 1 つ。
 * main は mgr（人の窓口とルーティング。日替わりで新しいセッション）。task はタスク 1 件の sub mgr。
 * system はシステム改修 sub mgr（manager システム自体の改修。固定 id "system"、日をまたいでも同じセッション）。
 * self は自己改善 sub mgr（self impl mgr。eod 処理・retro・改善提案。固定 id "self"、日をまたいでも同じセッション）。
 */
export type TermKind = "main" | "system" | "self" | "task";

export type FileEntry = { name: string; path: string; dir: boolean; size: number; mtime: number };
export type FileListing = { ok: boolean; error?: string; path: string; parent: string | null; entries: FileEntry[] };
export type FileProbe = { path: string; dir: boolean };
export type FileResolve = { ok: boolean; error?: string; path?: string; dir?: boolean };

export type TermInfo = {
	id: string;
	kind: TermKind;
	/** claude のモデル（sonnet / haiku） */
	model: string;
	title: string;
	taskPath: string | null;
	running: boolean;
	/** 直近に出力があった（作業中） */
	active: boolean;
	/** 見ていない間に出力があった */
	unread: boolean;
	/** 人の判断待ち（許可確認 / 質問 / plan の承認）。ただの待機は null */
	waiting: WaitKind | null;
};

/** 判断待ちの種類 */
export type WaitKind = "permission" | "question" | "plan";

/** ドロップされたファイルを受け取った結果（path は置いた / 見つけた絶対パス） */
export type DropResult = { ok: boolean; path?: string; error?: string };

type Schema<R, M> = { requests: R; messages: M };

export type ManagerRPC = {
	bun: Schema<
		{
			getState: { params: {}; response: VaultState };
			readDoc: { params: { path: string }; response: Doc | null };
			/** sheet-preview ハブの今の状態（ping のみ。起動はアプリ起動時に済んでいる） */
			sheetHub: { params: {}; response: { state: "running" | "started" | "foreign" | "down" | "no-script" | "failed" } };
			/** 「今」タブの中身（呼ぶたびに読み直す。読み取りのみ） */
			now: { params: {}; response: NowView };
			/** 問い合わせに返信する（reply に書く。宛先のセッションが開いていれば handoff で届けて完了、閉じていれば対応中のまま） */
			replyInquiry: { params: { path: string; text: string }; response: { ok: boolean; delivered: boolean; error?: string } };
			terms: { params: {}; response: TermInfo[] };
			workers: { params: {}; response: WorkerInfo[] };
			/** ソース id（ターミナル id か "worker:<id>"）ごとのリンク */
			links: { params: {}; response: Record<string, LinkInfo[]> };
			/** ファイルを既定のアプリで開く */
			openPath: { params: { path: string }; response: { ok: boolean } };
			/** 立ち上げて（立ち上がっていればそのまま）、これまでの出力を返す */
			attach: { params: { id: string; cols: number; rows: number }; response: { buffer: string } };
			openTask: { params: { taskPath: string }; response: TermInfo };
			closeTerm: { params: { id: string }; response: { ok: boolean } };
			/** claude タブ id のシェルを開く（初めてなら起動。cwd は claude タブと同じ）。これまでの出力を返す */
			shellOpen: { params: { id: string; cols: number; rows: number }; response: { buffer: string } };
			/** File タブ。起点（claude の cwd。取れなければ Manager/）と、1 階層のリスト・入力の解決（読み取りのみ） */
			filesCwd: { params: { id: string }; response: { cwd: string; live: boolean } };
			filesList: { params: { path: string; hidden: boolean }; response: FileListing };
			/** ターミナル出力のパス候補（cwd 起点で解決）。存在するものだけ返し、なければ null */
			filesProbe: { params: { id: string; tokens: string[] }; response: { results: (FileProbe | null)[] } };
			filesResolve: { params: { input: string; base: string }; response: FileResolve };
			filesReveal: { params: { path: string }; response: { ok: boolean } };
			/** Quick Look（qlmanage -p）。開いていれば閉じる。開いた状態を返す */
			filesQuickLook: { params: { path: string }; response: { open: boolean } };
			filesQuickLookClose: { params: {}; response: { ok: boolean } };
			openExternal: { params: { url: string }; response: { ok: boolean } };
			openInObsidian: { params: { path: string }; response: { ok: boolean } };
			/** ドロップされた File の絶対パス（ドラッグ用ペーストボードから。分からなければ null） */
			dropResolve: { params: { files: { name: string; size: number }[] }; response: { paths: (string | null)[] } };
			/** 文字で落とされたパス（~/ ・file:// も可）があるか */
			dropCheck: { params: { paths: string[] }; response: { items: { path: string; exists: boolean; dir: boolean }[] } };
			/** パスが取れないファイルの中身を少しずつ送る（base64）。last で置いたパスが返る */
			dropUpload: {
				params: { upload: string; name: string; size: number; chunk: string; first: boolean; last: boolean };
				response: DropResult;
			};
		},
		{
			termInput: { id: string; data: string };
			termResize: { id: string; cols: number; rows: number };
			/** いま画面に出しているターミナル */
			termFocus: { id: string };
			/** シェルの入力・大きさ（claude の termInput / termResize とは別。入力中判定に混ぜない） */
			shellInput: { id: string; data: string };
			shellResize: { id: string; cols: number; rows: number };
			/** ウィンドウが前面か（声かけの macOS 通知を出すかどうか） */
			windowFocus: { focused: boolean };
		}
	>;
	webview: Schema<
		{},
		{
			termData: { id: string; data: string };
			shellData: { id: string; data: string };
			termsChanged: TermInfo[];
			workersChanged: WorkerInfo[];
			linksChanged: Record<string, LinkInfo[]>;
			/**
			 * セッション間メッセージ（state/ui/handoff-*.json）を届けた。
			 * focus は mgr からタスクの sub mgr への引き継ぎ（従来どおりタブを前に出す）。それ以外は知らせるだけ。
			 */
			handoff: { id: string; title: string; from: string; focus: boolean };
			/** アプリが mgr に声かけの合図を送った */
			nudged: { summary: string };
			stateChanged: { paths: string[] };
			/** 人への案内（閉じるまで出しておく） */
			notice: { text: string; action?: { label: string; url: string } };
			/** 短い知らせ（閉じなくても消える）。会議の自動オープンなど */
			toast: { text: string };
		}
	>;
};
