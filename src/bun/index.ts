import { ApplicationMenu, BrowserView, BrowserWindow, BuildConfig, Utils } from "electrobun/main";
import { existsSync, readFileSync, rmSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import type { ManagerRPC } from "../shared/types";
import { Activity } from "./activity";
import { Buddy, defaultBuddyDir } from "./buddy";
import { Compactor } from "./compact";
import { startDevReload } from "./dev-reload";
import { Drops } from "./drop";
import { Hotkey } from "./hotkey";
import { Holidays } from "./calendar";
import { Hub } from "./hub";
import { localDate, parseNote, Vault } from "./vault";
import { LinkTracker } from "./links";
import { MeetingOpener } from "./meeting-open";
import { Pulse } from "./pulse";
import { readNow, replyInquiry } from "./now";
import { readReadme } from "./readme";
import { readSettings } from "./settings";
import { defaultHubDeps, ensureHub, hubState } from "./sheethub";
import { projectDir, readWorkers } from "./workers";

const MANAGER_DIR = resolve(
	process.env["MANAGER_DIR"] ?? join(homedir(), "Documents", "Obsidian Vault", "Manager"),
);

// GUI から起動すると PATH が短いので、よくある場所も探す
const CLAUDE_PATH =
	process.env["CLAUDE_PATH"] ??
	Bun.which("claude") ??
	[join(homedir(), ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].find(existsSync) ??
	"claude";

// 前の版（stream-json の会話）の記録は使わない
for (const old of ["threads.json", "transcripts", "state.json"]) rmSync(join(Utils.paths.userData, old), { recursive: true, force: true });

// sheet-preview のハブ。アプリ起動時に確かめ、いなければ起動する（失敗してもアプリは続ける）
const hubDeps = defaultHubDeps((m) => console.log(m));
void ensureHub(hubDeps);

const vault = new Vault(MANAGER_DIR);
const holidays = new Holidays(join(Utils.paths.userData, "holidays.json"));
vault.holidays = () => holidays.get();

const hub: Hub = new Hub({
	cwd: MANAGER_DIR,
	claudePath: CLAUDE_PATH,
	// アプリ自身の状態（ターミナルとセッション ID）は userData に置く
	dataDir: Utils.paths.userData,
	today: localDate,
	data: (id, data) => rpc.send.termData({ id, data }),
	changed: (list) => rpc.send.termsChanged(list),
	handoff: (id, title, from, focus) => rpc.send.handoff({ id, title, from, focus }),
});

const rpc = BrowserView.defineRPC<ManagerRPC>({
	maxRequestTime: 15000,
	handlers: {
		requests: {
			getState: () => vault.scan(),
			readDoc: ({ path }) => vault.read(path) ?? readOutsideMd(path),
			readReadme: () => readReadme(),
			sheetHub: () => hubState(hubDeps).then((state) => ({ state })),
			now: () => readNow(MANAGER_DIR),
			replyInquiry: ({ path, text }) => replyInquiry(MANAGER_DIR, path, text, (d) => hub.isOpen(d)),
			terms: () => hub.list(),
			workers: () => readWorkers(MANAGER_DIR, hub.sessions()),
			links: () => lastLinksValue,
			openPath: ({ path }) => {
				if (!isAbsolute(path) || !existsSync(path)) return { ok: false };
				return { ok: Utils.openPath(path) };
			},
			attach: ({ id, cols, rows }) => {
				const t = hub.get(id);
				if (!t) return { buffer: "" };
				t.resize(cols, rows);
				if (!t.running) t.start();
				return { buffer: t.buffer };
			},
			openTask: ({ taskPath }) => {
				const t = hub.openTask(taskPath);
				return hub.list().find((x) => x.id === t.id)!;
			},
			closeTerm: ({ id }) => {
				hub.close(id);
				return { ok: true };
			},
			openExternal: ({ url }) => {
				if (!/^(https?|slack|obsidian|mailto|x-apple\.systempreferences):/i.test(url)) return { ok: false };
				return { ok: Utils.openExternal(url) };
			},
			buddySend: ({ text }) => {
				buddy.send(text);
				return { ok: true };
			},
			buddyInfo: () => ({ state: buddy.state, history: buddy.history, dir: buddyDir }),
			dropResolve: async ({ files }) => ({ paths: await drops.resolve(files) }),
			dropCheck: ({ paths }) => ({ items: drops.check(paths) }),
			dropToBuddy: ({ path }) => drops.toBuddy(path),
			dropUpload: (p) => drops.upload(p),
			openInObsidian: ({ path }) => {
				const abs = vault.resolve(path);
				if (!abs) return { ok: false };
				return { ok: Utils.openExternal(`obsidian://open?path=${encodeURIComponent(abs)}`) };
			},
		},
		messages: {
			termInput: ({ id, data }) => hub.get(id)?.write(data, true),
			termResize: ({ id, cols, rows }) => hub.get(id)?.resize(cols, rows),
			termFocus: ({ id }) => hub.focus(id),
			windowFocus: ({ focused }) => {
				windowFocused = focused;
			},
		},
	},
});

// メニューがないと Cmd+C / Cmd+V などが効かない
ApplicationMenu.setApplicationMenu([
	{ submenu: [{ role: "about" }, { type: "divider" }, { role: "hide" }, { role: "hideOthers" }, { role: "showAll" }, { type: "divider" }, { role: "quit" }] },
	{
		label: "Edit",
		submenu: [{ role: "undo" }, { role: "redo" }, { type: "divider" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }],
	},
	// ⌘W は画面側でノートのタブを閉じるのに使うので、ウィンドウを閉じる項目は置かない
	{ label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "toggleFullScreen" }] },
]);

const win = new BrowserWindow({
	title: "manager",
	url: "views://mainview/index.html",
	rpc,
	titleBarStyle: "hiddenInset",
	frame: { width: 1520, height: 940, x: 80, y: 60 },
});

vault.watch((paths) => rpc.send.stateChanged({ paths }));

// 開発時（hutch electrobun dev）だけ: 画面側の変更で WebView だけ読み込み直す（claude のセッションは生かしたまま）
const devReload =
	BuildConfig.getSync().channel === "dev"
		? startDevReload({
				reload: () => win.webview.executeJavascript("location.reload()"),
				notify: (text) => rpc.send.toast({ text }),
			})
		: null;

// 壁打ち相手 Clawd くん（~/work/buddy で haiku を 1 本持ち続ける。起動ごとに新しい会話）
const buddyDir = defaultBuddyDir();
// ターミナル・Clawd くんへのファイルのドロップ
const drops = new Drops({ dataDir: Utils.paths.userData, buddyDir });
const buddy = new Buddy({
	managerDir: MANAGER_DIR,
	buddyDir,
	claudePath: CLAUDE_PATH,
	dataDir: Utils.paths.userData,
	state: (state) => rpc.send.buddyState({ state }),
	delta: (text) => rpc.send.buddyDelta({ text }),
	reply: (text) => rpc.send.buddyReply({ text }),
});

// Ctrl の 2 連打: アプリが前面なら Clawd くんを呼び、ほかのアプリが前面ならアプリを前に出すだけにする
// （前面のときは画面側でも Ctrl の 2 連打を見て吹き出しを開くので、ここで送っても開くだけ）
const hotkey = new Hotkey({
	dataDir: Utils.paths.userData,
	summon: () => {
		if (windowFocused) {
			rpc.send.buddySummon({});
			return;
		}
		try {
			if (win.isMinimized()) win.unminimize();
			win.show();
			win.activate();
		} catch (e) {
			console.error("ウィンドウを前に出せなかった", e);
		}
	},
	permissionNeeded: () =>
		rpc.send.notice({
			text: "Ctrl の 2 連打で Clawd くんを呼ぶには、アクセシビリティの権限が要る。システム設定 > プライバシーとセキュリティ > アクセシビリティで、このアプリ（開発中は pnpm dev を動かしたターミナル）を許可する（アプリが前面のときは権限なしでも効く）",
			action: { label: "設定を開く", url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" },
		}),
});

// 活動の記録（前面ウィンドウの文字を採り、haiku で分類して state/activity/ に区間を残す）
const activity = new Activity({
	managerDir: MANAGER_DIR,
	dataDir: Utils.paths.userData,
	claudePath: CLAUDE_PATH,
	scan: () => vault.scan(),
	permissionNeeded: () =>
		rpc.send.notice({
			text: "活動の記録にはアクセシビリティの権限が要る。システム設定 > プライバシーとセキュリティ > アクセシビリティで、このアプリ（開発中は pnpm dev を動かしたターミナル）を許可する",
			action: { label: "設定を開く", url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" },
		}),
	changed: () => rpc.send.stateChanged({ paths: [] }),
});

// mgr の声かけ（予定・メッセージ・期限・人の手の止まり・活動の記録・壁打ちを見て、mgr に合図を送る）
let windowFocused = true;
new Pulse({
	managerDir: MANAGER_DIR,
	ledgerPath: join(Utils.paths.userData, "pulse.json"),
	scan: () => vault.scan(),
	target: () => hub.main,
	lastHumanInput: () => hub.lastUserInput(),
	currentRun: (s) => activity.currentRun(s),
	sent: (summary) => {
		rpc.send.nudged({ summary });
		if (!windowFocused && readSettings(MANAGER_DIR).notify) notify("mgr が話しかける", summary);
	},
});

// 会議の自動オープン（開始の N 分前に Meet / Teams のリンクを open で開く。声かけの on/off とは独立）
new MeetingOpener({
	managerDir: MANAGER_DIR,
	toast: (text, warn) => {
		rpc.send.toast({ text });
		if (warn && !windowFocused && readSettings(MANAGER_DIR).notify) notify("会議の自動オープン", text);
	},
}).start();

// 定期の /compact（止まっていて文脈が大きいセッションに、残す要点を指示して送る）
new Compactor({
	managerDir: MANAGER_DIR,
	ledgerPath: join(Utils.paths.userData, "compact.json"),
	targets: () => hub.all(),
	sent: (id, tokens) => console.log(`compact: ${id}（約 ${Math.round(tokens / 1000)}K トークン）`),
});

/** macOS の通知。文字は引数で渡す（AppleScript に埋め込まない） */
function notify(title: string, text: string) {
	try {
		Bun.spawn(
			["/usr/bin/osascript", "-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, text.slice(0, 200)],
			{ stdout: "ignore", stderr: "ignore" },
		);
	} catch (e) {
		console.error("通知を出せなかった", e);
	}
}

// 祝日は起動時と 1 時間ごとに確かめる（取り直すのは 1 日 1 回）
const refreshHolidays = () => holidays.refresh(localDate()).then((changed) => changed && rpc.send.stateChanged({ paths: [] }));
refreshHolidays();
setInterval(refreshHolidays, 60 * 60 * 1000);

// ワーカー（サブエージェント）の実行状況と、各セッションに出てきたファイル・URL を 2 秒ごとに見る
const links = new LinkTracker(MANAGER_DIR, dirname(MANAGER_DIR));
let lastWorkers = "";
let lastLinks = "";
let lastLinksValue: Record<string, import("../shared/types").LinkInfo[]> = {};
setInterval(() => {
	const sessions = hub.sessions();
	const list = readWorkers(MANAGER_DIR, sessions);
	const snap = JSON.stringify(list.map((w) => [w.id, w.state, w.lastTool]));
	if (snap !== lastWorkers) {
		lastWorkers = snap;
		rpc.send.workersChanged(list);
	}
	const sid = new Map(sessions);
	const dir = projectDir(MANAGER_DIR);
	const sources = [
		...sessions.map(([id, s]) => ({ id, file: join(dir, `${s}.jsonl`) })),
		...list.map((w) => ({ id: `worker:${w.id}`, file: join(dir, sid.get(w.termId) ?? "", "subagents", `agent-${w.id}.jsonl`) })),
	];
	const found = links.scan(sources);
	const lsnap = JSON.stringify(Object.entries(found).map(([k, v]) => [k, v.map((l) => l.target + l.via)]));
	if (lsnap !== lastLinks) {
		lastLinks = lsnap;
		lastLinksValue = found;
		rpc.send.linksChanged(found);
	}
}, 2000);

/** vault の外の md（会話に出てきたもの）も読めるようにする。ホーム配下の .md だけ */
function readOutsideMd(path: string) {
	const abs = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
	if (!isAbsolute(abs) || !abs.endsWith(".md") || !abs.startsWith(homedir() + "/") || !existsSync(abs)) return null;
	try {
		const { fm, body } = parseNote(readFileSync(abs, "utf-8"));
		return { path: abs, fm, body, mtime: statSync(abs).mtimeMs };
	} catch {
		return null;
	}
}

process.on("exit", () => {
	devReload?.dispose();
	hub.disposeAll();
	buddy.dispose();
	hotkey.dispose();
});

console.log(`manager-app: ${MANAGER_DIR} / claude: ${CLAUDE_PATH}`);
