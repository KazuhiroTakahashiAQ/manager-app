// ターミナルの束ね役。役職は mgr / sub mgr / worker（worker は各セッションのサブエージェントで、ここでは扱わない）。
// - main: mgr。人の窓口とルーティング。日付が変わったら新しいセッションにする（状態はファイルから読み直す）。
// - system: システム改修 sub mgr（固定 id "system"）。manager システム自体の改修。日をまたいでも同じセッションを使い続ける。
// - task: sub mgr。タスク 1 件の段取り。mgr が引き継ぎで立てる。
// - セッション間メッセージ: 誰かが state/ui/handoff-*.json（{ "to", "from", "brief", "reply_to" }。従来の { "task", "brief" } も可）を
//   書くと、宛先のセッションに発言として渡し、ファイルを消す。宛先が止まっていなければ（出力中・人が入力中）ファイルを残して待つ。
//   宛先が不正・存在しなければ state/ui/handoff-errors.log に 1 行書いて消す。解釈は handoff.ts。

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, join } from "path";
import type { TermInfo, TermKind } from "../shared/types";
import { autocompactEnv } from "./compact";
import { destKey, interpretHandoff, type Dest } from "./handoff";
import { readSettings } from "./settings";
import { modelOf, Term, type TermRecord } from "./term";

type HubOptions = {
	cwd: string;
	claudePath: string;
	dataDir: string;
	today: () => string;
	data: (id: string, chunk: string) => void;
	changed: (list: TermInfo[]) => void;
	/** セッション間メッセージを届けた。focus はタブを前に出すか（mgr からタスクの sub mgr への引き継ぎだけ） */
	handoff: (id: string, title: string, from: string, focus: boolean) => void;
};

const ACTIVE_MS = 1500;
const SYSTEM_ID = "system";
const SELF_ID = "self";
/** 読めない handoff ファイルを、書きかけとみなして待つ時間 */
const UNREADABLE_MS = 60_000;

export class Hub {
	private terms = new Map<string, Term>();
	private focused = "main";
	private lastSnapshot = "";

	constructor(private o: HubOptions) {
		mkdirSync(o.dataDir, { recursive: true });
		// 種類が合わない古い記録（以前の版のタブ）は捨てる
		for (const rec of this.load()) if (rec.kind === "main" || rec.kind === "task" || rec.kind === "system" || rec.kind === "self") this.terms.set(rec.id, this.make(rec));
		if (!this.terms.has("main")) this.terms.set("main", this.make(newRecord("main", "main", "mgr", null, o.today())));
		// システム改修 sub mgr のタブは常に置く（claude はタブを開くか、to: system のメッセージが届いたときに立ち上がる）。
		// ここでは画面への通知（changed）をしない（index.ts の rpc がまだない）
		if (!this.terms.has(SYSTEM_ID)) this.terms.set(SYSTEM_ID, this.make(newRecord(SYSTEM_ID, "system", "システム改修", null, "")));
		// 自己改善 sub mgr（self impl mgr）も固定タブ。eod の自動実行の結果を受け取り、提案を出す
		if (!this.terms.has(SELF_ID)) this.terms.set(SELF_ID, this.make(newRecord(SELF_ID, "self", "自己改善", null, "")));
		const main = this.main;
		main.rec.title = "mgr";
		if (!main.rec.day) main.rec.day = o.today();
		// アプリを開いた時点で前日の main なら、新しい会話から始める
		if (main.rec.day !== o.today()) {
			main.rec.sessionId = crypto.randomUUID();
			main.rec.day = o.today();
		}
		this.persist();
		setInterval(() => this.tick(), 1000);
	}

	get main() {
		return this.terms.get("main")!;
	}

	get(id: string) {
		return this.terms.get(id);
	}

	/** すべてのターミナル（main → system → self → task の順。同じ種類の中は開いた順＝Map の挿入順。
	 * 出力や入力のたびに更新される lastActive では並べない（動いたタブが末尾に移ってしまう）） */
	all(): Term[] {
		return [...this.terms.values()].sort((a, b) => ORDER[a.rec.kind] - ORDER[b.rec.kind]);
	}

	list(): TermInfo[] {
		const now = Date.now();
		return this.all().map((t) => ({
			id: t.id,
			kind: t.rec.kind,
			model: modelOf(t.rec.kind),
			title: t.rec.title,
			taskPath: t.rec.taskPath,
			running: t.running,
			active: t.running && now - t.lastOutput < ACTIVE_MS,
			unread: t.unread,
		}));
	}

	/** [ターミナル id, セッション id]（ワーカーの記録を探すため） */
	sessions(): [string, string][] {
		return [...this.terms.values()].map((t) => [t.id, t.rec.sessionId]);
	}

	/** 人が最後にどれかのターミナルを操作した時刻 */
	lastUserInput(): number {
		return Math.max(0, ...[...this.terms.values()].map((t) => t.userInputAt));
	}

	focus(id: string) {
		this.focused = id;
		const t = this.terms.get(id);
		if (t?.unread) {
			t.unread = false;
			this.emitChanged(true);
		}
	}

	openTask(taskPath: string): Term {
		const id = `task:${taskPath}`;
		let t = this.terms.get(id);
		if (!t) {
			t = this.make(newRecord(id, "task", basename(taskPath, ".md"), taskPath, ""));
			this.terms.set(id, t);
			this.persist();
			this.emitChanged(true);
		}
		return t;
	}

	/** 固定 sub mgr（system / self）。なければ作る。タスクノートなし、日替わりにしない */
	private ensureFixed(id: string, kind: TermKind, title: string): Term {
		let t = this.terms.get(id);
		if (!t) {
			t = this.make(newRecord(id, kind, title, null, ""));
			this.terms.set(id, t);
			this.persist();
			this.emitChanged(true);
		}
		return t;
	}

	/** システム改修 sub mgr（タイトル「システム改修」） */
	ensureSystem(): Term {
		return this.ensureFixed(SYSTEM_ID, "system", "システム改修");
	}

	/** 自己改善 sub mgr = self impl mgr（タイトル「自己改善」） */
	ensureSelf(): Term {
		return this.ensureFixed(SELF_ID, "self", "自己改善");
	}

	close(id: string) {
		const t = this.terms.get(id);
		if (!t || t.rec.kind !== "task") return;
		t.kill();
		this.terms.delete(id);
		this.persist();
		this.emitChanged(true);
	}

	disposeAll() {
		for (const t of this.terms.values()) t.kill();
		this.persist();
	}

	// ───────── 内部 ─────────

	private make(rec: TermRecord): Term {
		return new Term(rec, {
			cwd: this.o.cwd,
			claudePath: this.o.claudePath,
			systemPrompt,
			// 全セッション共通: claude 自身の自動 compact を早める（settings/manager-app.md の autocompact_pct・autocompact_window）
			extraEnv: () => autocompactEnv(readSettings(this.o.cwd)),
			data: (t, chunk) => {
				if (t.id !== this.focused && !t.unread) {
					t.unread = true;
					this.emitChanged(true);
				}
				this.o.data(t.id, chunk);
			},
			changed: () => {
				this.persist();
				this.emitChanged(true);
			},
		});
	}

	/** 作業中の表示の切り替わりと、引き継ぎファイルを見る */
	private tick() {
		this.emitChanged(false);
		this.pickHandoffs();
	}

	/**
	 * セッション間メッセージを届ける。ファイル名順（handoff-<YYYYMMDD-HHMMSS>）に、宛先ごとに 1 周 1 件。
	 * 宛先の claude が動いていて送ってよい状態でなければ、ファイルを残して次の周回で試す（それより後の同じ宛先の分も待つ）。
	 * 動いていなければ、本文を最初の発言にして立ち上げる。
	 */
	private pickHandoffs() {
		const dir = join(this.o.cwd, "state", "ui");
		if (!existsSync(dir)) return;
		const done = new Set<string>();
		for (const f of readdirSync(dir).filter((x) => /^handoff-.*\.json$/.test(x)).sort()) {
			const p = join(dir, f);
			let raw: unknown;
			let text = "";
			try {
				text = readFileSync(p, "utf-8");
				raw = JSON.parse(text);
			} catch {
				// 書きかけかもしれないので次の周回で読む。しばらくたっても読めなければ記録して捨てる
				try {
					if (Date.now() - statSync(p).mtimeMs > UNREADABLE_MS) {
						this.handoffError(f, `JSON として読めない: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
						rmSync(p, { force: true });
					}
				} catch {
					// 消えていた
				}
				continue;
			}
			const r = interpretHandoff(raw, (tp) => existsSync(join(this.o.cwd, tp)));
			if (!r.ok) {
				this.handoffError(f, r.error);
				rmSync(p, { force: true });
				continue;
			}
			const h = r.handoff;
			const key = destKey(h.dest);
			if (done.has(key)) continue;
			done.add(key);
			const t = this.termFor(h.dest);
			if (t.running && !t.readyForNudge()) continue; // 出力中・人が入力中。あとで送る
			rmSync(p, { force: true });
			for (const w of h.warnings) this.handoffError(f, w);
			if (t.running) t.paste(h.text, true);
			else t.start(h.text);
			this.o.handoff(t.id, t.rec.title, h.from, h.dest.kind === "task" && h.from === "mgr");
		}
	}

	/** 宛先のセッションが今動いているか（今タブの返信を handoff で届けてよいかの判断。立ち上げはしない） */
	isOpen(d: Dest): boolean {
		if (d.kind === "main") return this.main.running;
		if (d.kind === "system") return this.terms.get(SYSTEM_ID)?.running ?? false;
		if (d.kind === "self") return this.terms.get(SELF_ID)?.running ?? false;
		return this.terms.get(`task:${d.taskPath}`)?.running ?? false;
	}

	private termFor(d: Dest): Term {
		if (d.kind === "main") return this.main;
		if (d.kind === "system") return this.ensureSystem();
		if (d.kind === "self") return this.ensureSelf();
		return this.openTask(d.taskPath);
	}

	/** 届けられなかったメッセージを state/ui/handoff-errors.log に 1 行残す */
	private handoffError(file: string, msg: string) {
		const line = `${new Date().toISOString()} ${file}: ${msg.replace(/[\r\n]+/g, " ")}`;
		console.error(`handoff: ${line}`);
		try {
			appendFileSync(join(this.o.cwd, "state", "ui", "handoff-errors.log"), `${line}\n`);
		} catch (e) {
			console.error("handoff-errors.log に書けなかった", e);
		}
	}

	private emitChanged(force: boolean) {
		const list = this.list();
		const snap = JSON.stringify(list);
		if (!force && snap === this.lastSnapshot) return;
		this.lastSnapshot = snap;
		this.o.changed(list);
	}

	private get path() {
		return join(this.o.dataDir, "terms.json");
	}

	private load(): TermRecord[] {
		try {
			const v = JSON.parse(readFileSync(this.path, "utf-8"));
			return Array.isArray(v) ? v : [];
		} catch {
			return [];
		}
	}

	private persist() {
		try {
			writeFileSync(`${this.path}.tmp`, JSON.stringify([...this.terms.values()].map((t) => t.rec), null, 1));
			renameSync(`${this.path}.tmp`, this.path);
		} catch (e) {
			console.error("terms.json を保存できなかった", e);
		}
		this.writeSessions();
	}

	/**
	 * mgr が sub mgr（別セッション）の作業を聞かれたときに読めるよう、一覧を Manager/state/ui/sessions.json に書く。
	 * 中身は読まない（scripts/submgr.ts が必要なときだけセッション記録を読む）。
	 */
	private writeSessions() {
		try {
			const dir = join(this.o.cwd, "state", "ui");
			mkdirSync(dir, { recursive: true });
			const sessions = [...this.terms.values()].map((t) => ({
				id: t.id,
				kind: t.rec.kind,
				title: t.rec.title,
				taskPath: t.rec.taskPath,
				sessionId: t.rec.sessionId,
				day: t.rec.day,
				running: t.running,
				lastActive: new Date(t.rec.lastActive).toISOString(),
			}));
			rmSync(join(dir, "rooms.json"), { force: true }); // 旧名
			const path = join(dir, "sessions.json");
			writeFileSync(`${path}.tmp`, JSON.stringify({ updated: new Date().toISOString(), sessions }, null, 1));
			renameSync(`${path}.tmp`, path);
		} catch (e) {
			console.error("sessions.json を書けなかった", e);
		}
	}
}

const ORDER: Record<TermKind, number> = { main: 0, system: 1, self: 2, task: 3 };

function newRecord(id: string, kind: TermKind, title: string, taskPath: string | null, day: string): TermRecord {
	return { id, kind, title, taskPath, sessionId: crypto.randomUUID(), day, lastActive: Date.now() };
}

/** --append-system-prompt。流儀の中身は skill（manager-app）に置き、ここでは読み込ませるだけにする。 */
function systemPrompt(rec: TermRecord): string {
	const common =
		"このセッションは manager-app（デスクトップ UI に埋め込んだターミナル）から使われている。" +
		"このセッションでまだ読み込んでいなければ、最初の応答の前に Skill ツールで manager-app を読み込み、その流儀に従う。";
	if (rec.kind === "main") return `${common}\nあなたは mgr。`;
	if (rec.kind === "system")
		return (
			`${common}\nあなたはシステム改修 sub mgr。担当は manager システム自体の改修（Manager/ の skills・agents・scripts・jobs・settings・docs と ~/Documents/work/manager-app）。人の業務タスク（tasks/）は扱わない。` +
			"実作業は worker `system-engineer`（.claude/agents/system-engineer.md）に出し、自分は依頼の分解・確認・人への報告に専念する。" +
			'完了したら Write ツールで state/ui/handoff-<YYYYMMDD-HHMMSS>.json に { "to": "main", "from": "system", "brief": "…" } を書き、結果を 5 行以内で mgr に返す（skill の「セッション間メッセージ」の形式）。'
		);
	if (rec.kind === "self")
		return (
			`${common}\nあなたは自己改善 sub mgr（self impl mgr）。担当は eod 処理（日次の振り返り）・retro・自己改善の提案。人の業務タスクの実作業と、manager システムの改修（to: system の担当）は扱わない。` +
			"自動 eod（ジョブ eod、毎日 3:00 に前日分を非対話で実行）の結果を受け取り、人の判断が要るもの（明日のトップ3・retro の承認）は messages/ の提案として人に出す。承認前の retro・CLAUDE.md・skill は書き換えない。" +
			'完了したら Write ツールで state/ui/handoff-<YYYYMMDD-HHMMSS>.json に { "to": "main", "from": "self", "brief": "…" } を書き、結果を 5 行以内で mgr に返す（skill の「セッション間メッセージ」の形式）。'
		);
	return `${common}\nあなたは sub mgr。担当タスク: ${rec.taskPath}。skill の「sub mgr のとき」の節に従い、このタスクだけを扱う。`;
}
