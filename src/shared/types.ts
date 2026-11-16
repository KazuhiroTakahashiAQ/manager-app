// bun（メインプロセス）と webview で共有する型と RPC スキーマ。

export type Frontmatter = Record<string, string>;

/** タスクの準備状況（本文の「## 完了条件」「## 手順」から読む） */
export type TaskPrep = {
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
	/** worker の定義（.claude/agents/*.md） */
	agents: Item[];
	/** research/ の下調べ（タスク 1 件に 1 ノート） */
	research: Item[];
	lookahead: Lookahead | null;
	/** 活動の記録の最後の 1 区間（今日の分） */
	activity: ActivitySpan | null;
	inboxCount: number;
	scannedAt: number;
};

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
 */
export type TermKind = "main" | "system" | "task";

/** 壁打ち相手 Clawd くんの状態と、やり取りの 1 行 */
export type BuddyState = "starting" | "idle" | "replying" | "stopped";
export type BuddyLine = { role: "user" | "clawd"; text: string };

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
	/** main のセッションが前日のもの */
	stale: boolean;
};

/** ドロップされたファイルを受け取った結果（path は置いた / 見つけた絶対パス） */
export type DropResult = { ok: boolean; path?: string; error?: string };

type Schema<R, M> = { requests: R; messages: M };

export type ManagerRPC = {
	bun: Schema<
		{
			getState: { params: {}; response: VaultState };
			readDoc: { params: { path: string }; response: Doc | null };
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
			/** main を新しいセッションで立ち上げ直す */
			renewMain: { params: {}; response: { ok: boolean } };
			openExternal: { params: { url: string }; response: { ok: boolean } };
			openInObsidian: { params: { path: string }; response: { ok: boolean } };
			/** Clawd くんに話す（返事は buddyDelta / buddyReply で届く） */
			buddySend: { params: { text: string }; response: { ok: boolean } };
			buddyInfo: { params: {}; response: { state: BuddyState; history: BuddyLine[]; dir: string } };
			/** ドロップされた File の絶対パス（ドラッグ用ペーストボードから。分からなければ null） */
			dropResolve: { params: { files: { name: string; size: number }[] }; response: { paths: (string | null)[] } };
			/** 文字で落とされたパス（~/ ・file:// も可）があるか */
			dropCheck: { params: { paths: string[] }; response: { items: { path: string; exists: boolean; dir: boolean }[] } };
			/** Clawd くんが読めるよう ~/work/buddy/drops/ にコピーする */
			dropToBuddy: { params: { path: string }; response: DropResult };
			/** パスが取れないファイルの中身を少しずつ送る（base64）。last で置いたパスが返る */
			dropUpload: {
				params: { upload: string; name: string; to: "term" | "buddy"; size: number; chunk: string; first: boolean; last: boolean };
				response: DropResult;
			};
		},
		{
			termInput: { id: string; data: string };
			termResize: { id: string; cols: number; rows: number };
			/** いま画面に出しているターミナル */
			termFocus: { id: string };
			/** ウィンドウが前面か（声かけの macOS 通知を出すかどうか） */
			windowFocus: { focused: boolean };
		}
	>;
	webview: Schema<
		{},
		{
			termData: { id: string; data: string };
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
			buddyState: { state: BuddyState };
			/** 返事の途中（ここまでの全文） */
			buddyDelta: { text: string };
			buddyReply: { text: string };
			/** Ctrl の 2 連打で呼ばれた */
			buddySummon: {};
		}
	>;
};
