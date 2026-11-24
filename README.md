# manager-app

Obsidian vault の `Manager/`（manager = Claude Code が管理するタスク・メッセージ・ブリーフ）をダッシュボード 1 枚で見ながら、埋め込んだターミナルの claude と話すデスクトップアプリ。Electrobun 2（Hutch）製。

## 画面

- **左: ダッシュボード** — 今日決めること / 着手の準備 / WBS（ガントチャート、今日の 2 日前〜2 週間先、土日と祝日は斜線）/ 今日のブリーフ（予定を縦のタイムラインで。9:00〜21:00、外に予定があれば広げる）/ 実行状況（mgr / sub mgr / worker）/ 動いているもの。
- **祝日** — holidays-jp API（https://holidays-jp.github.io/api/v1/date.json）から 1 日 1 回取り、userData の `holidays.json` に控える。営業日の計算（準備の期限など）にも使う。
- **ファイル・URL** — 各セッションとワーカーの記録から、出てきたファイル（Read / Write / Edit と本文中のパス）と URL を拾い、実行状況のその mgr / sub mgr / worker の下に並べる（読んだ / 書いた / 直した / 開いた / 言及、ファイル名とタイトル）。md はアプリ内のタブで、ほかのファイルは既定のアプリで、URL はブラウザで開く。
- **ノートのタブ** — ダッシュボードの右上のタブで、ダッシュボードと開いたノートを切り替える（Esc でダッシュボードへ）。vault 外の md（ホーム配下）も開ける。
- **README タブ** — ダッシュボードの隣の固定タブ「README」に、このアプリの README.md を Markdown（見出し・表・コードブロック・リスト・リンク）で出す。読み取り専用。タブを開くたび・画面の再読み込み（ホットリロード含む）・ウィンドウが再び見えたときに bun 側 RPC `readReadme` で読み直すので、常に最新。場所は `MANAGER_APP_ROOT` → `build/` の手前 → 起動元 → `~/Documents/work/manager-app` の順で探す（`src/bun/readme.ts`、`src/mainview/readme-tab.ts`。テストあり）。描画はノートのタブと同じ（marked + DOMPurify）。
- **今タブ** — ダッシュボードと README の間の固定タブ「今」。一覧ではなく集中画面で、Manager の `state/ui/now.json`（`{task, reason, set_by, set_at}`。mgr が書く。`task` は `tasks/<名>.md` でも素の名前でも可。アプリは読むだけで書かない）のタスクのタイトル・next_action・期限・`## 完了条件`・`## 手順`（Markdown。marked + DOMPurify）と、関連（`research/<名>.md`・waiting_for）・reason を出す。now.json がない・読めない・タスクがないときは `status: doing` で期限が最も近いものを「仮」と付けて出す。タブの下に「聞かれていること」として `messages/` の未回答（`status` 未読 / 対応中 かつ frontmatter `from` あり）を並べ、`options` があれば選択肢ボタン、なければ入力欄（⌘/Ctrl+Enter で送信）。返信は messages の `reply` に書き、`from`（main / system / self / tasks/<名>.md）のセッションが開いていれば `state/ui/handoff-*.json` で届けて `status: 完了`、閉じている・`worker:<名>` なら `status: 対応中` のまま `reply` に残す。未回答の数はタブのバッジだけ（nudge は足さない）。タブを開くたび・`messages/` `tasks/` `research/` `state/ui/now.json` の変更・ウィンドウが再び見えたときに bun 側 RPC `now` で読み直し、ホットリロード後も「今」タブを戻す（`src/bun/now.ts`、`src/shared/now.ts`、`src/mainview/now-tab.ts`。テストあり）。
- **実行状況** — 各タブのセッションが呼んだサブエージェント（ワーカー）を `~/.claude/projects/<cwd>/<session>/subagents/` から 2 秒ごとに読み、種類・依頼内容・状態・直近のツールを出す。状態は 作業中 / 完了（`agent-<id>.meta.json` の `finished: true`）/ 失敗・止めた（親の `<session>.jsonl` の queue-operation にある task-notification の `<status>failed</status>` / `<status>killed</status>`、meta の `stoppedByUser`）/ 止まっている（どれでもなく 5 分更新なし）。親の jsonl は前回の続きだけ読む。ノートは盤面の上に重ねて開く（Esc で戻る）。
- **実行状況の自動開閉** — セッション（mgr / システム / sub mgr）の行は、会話が続いている間は中身（ファイル・URL と worker）を開き、途切れたら畳んで数だけ出す。会話中 = worker が作業中、または claude が動いていて出力中か最後の出力から 10 分以内（`RUN_ACTIVE_MS`、`src/mainview/runs-fold.ts`。テストあり）。左の ▾ / ▸ で手でも開閉でき、手で変えたものは次に会話中かどうかが変わるまで自動で戻さない（自動は始まった・途切れた瞬間だけ効く）。worker の帯のチップから来たときは開く。開閉と最後の出力の時刻は localStorage の `runsFold` / `runsBusyAt` に保ち、再描画・再読み込みのあとも保つ（保存できなくても動く）。最後の出力の時刻は画面側で TermInfo の `active` の変わり目から取るので、画面を開く前の出力は数えない。
- **右（または下）: ターミナル** — 普通の `claude` を PTY で動かし、xterm.js で表示する。スラッシュコマンド・skill・許可の確認はいつもどおり使える。タブで mgr・システム・自己改善・sub mgr を切り替える。ターミナルの上には今のレイヤー（mgr / sub mgr のタイトルなど）のラベルを常に出し、worker がいるときはその下にチップを横に並べる。
- **配置** — 既定はターミナルが右、ダッシュボード:ターミナル = 7:3。境界はドラッグで変えられ、ダブルクリックで 7:3 に戻る（どちらも最小幅を割らず、ターミナルは幅の変化に合わせて合わせ直す。計算は `src/mainview/layout.ts`、テストあり）。ターミナル上部の丸いボタン（↓ で下に置く / → で右に置く）で位置を切り替える（どちらも次回も覚えている）。
- **文字の大きさ** — ⌘- で小さく、⌘⇧- で大きく（⌘= でも大きく）、⌘0 で既定の 11px に戻す。フォントは JetBrainsMono Nerd Font Mono。
- **選んだ文を入力欄へ** — ノートやブリーフの文を選ぶと「付箋にして話す」が出る。`[参照] ファイル › 見出し` と引用を、いま開いているターミナルの入力欄に貼る（送信はしない）。「話す」ボタンも同じ。
- **アイデア** — `ideas/` の 新規・温め中 を route（タスクに紐づく / 目標に効く / 単独）ごとに並べる。紐づくタスク名・目標名を添える。押すとアプリ内のタブで開く。
- **タスクの印** — 着手の準備・WBS のタスクに、紐づくアイデアの数（1 件ならそのノート、複数ならアイデア欄の該当分を目立たせる）と「下調べ」（`research/<タスク名>.md` があれば。押すと開く）を小さく出す。
- **先読み** — （夜の下調べは廃止。ファイルがあれば表示するだけ）`state/plan/lookahead.json` から、着手の準備の行の下に推奨開始・準備の期限・工数を、重いタスクには「絞る案」を添える。WBS では推奨開始日に小さな三角（重いものは朱）を出す。
- **シートタブ** — 「今」「README」と並ぶ固定タブ「シート」。sheet-preview のハブ（`http://localhost:8765/`）を iframe（sandbox は allow-scripts / same-origin / forms / modals / popups）で出す読み取りタブ。ハブはアプリ起動時に `src/bun/sheethub.ts` が自動起動する（`GET 127.0.0.1:8765/api/ping` が `app: "sheet-preview"` ならそのまま、応答なしなら `node ~/.claude/skills/sheet-preview/scripts/serve.ts` を detached で起動、serve.ts が無ければ起動せず案内、8765 が別プロセスなら起動せず「別プロセスで使用中」を案内。失敗はログのみ）。止めるには `src/bun/index.ts` の `void ensureHub(hubDeps);` を消して再ビルド、起動済みの node は `pkill -f sheet-preview/scripts/serve.ts`。開くたび（と画面が再び見えたとき）に `/api/ping` で（bun 側の RPC `sheetHub` 経由）生きているか確かめ、未起動なら iframe を出さずに起動コマンドと「再確認」ボタンを出す。シートタブを見ているあいだの ⌘- / ⌘⇧-（⌘= でも）/ ⌘0（既定の 80% に戻す）は盤面ではなくシートの表示倍率（60〜200%、10% 刻み。倍率はハブ側の localStorage に保存）を変える（iframe 外にフォーカスがあるときは postMessage でハブに伝える。盤面ズームは .sheet-frame の逆数 zoom で打ち消している）。`src/mainview/sheet-tab.ts`、テストあり。
- **アイデアのグラフ** — アイデア欄の「一覧 / グラフ」で切り替える。ノートのタブの並びの「アイデアのグラフ」（またはアイデア欄の「大きく開く」）で、タブいっぱいに開く。ノードはアイデア（丸。新規 > 温め中 > タスク化 > 見送り の順に薄くなる）、紐づくタスクとその親（四角）、目標（ひし形。`goals.md` の「## 四半期目標」の項目と、アイデアの `goal`）、PJ（輪。`project`）。エッジはアイデア→タスク / 目標 / PJ、タスク→親 / PJ。外部ライブラリなしの canvas と簡単な力学配置（反発・ばね・中心への引力）。ノードのドラッグで動かす、ホイールで拡大縮小、背景のドラッグで移動、ダブルクリックで全体を収める、ホバーで隣だけ強調して名前を出す、押すとノートを開く。`ideas/`・`tasks/` が変わると描き直し、残ったノードの位置は保つ。
- **エージェント** — どんなエージェントがいるかの一覧。対話（mgr / sub mgr（開いているタブの数とタスク名）/ Clawd くん。役割・モデル・状態）、worker（`Manager/.claude/agents/*.md` の name・description の先頭 1 文・model、`tools` に Write / Edit / Bash がなければ「読むだけ」。いま動いている数）、定期実行（`jobs/*.md` の時刻・曜日・model・前回の結果。無効は薄く）、アプリの見張り（声かけ・活動の記録の有効 / 無効）。押すと定義ファイル（mgr・sub mgr は skill `manager-app`、Clawd くんは `buddy/CLAUDE.md`、見張りは `settings/manager-app.md`）を開く。
- **色分け（大分類と小分類）** — `src/mainview/index.css` 末尾の `--seg-*`（大分類）と `--sub-*`（小分類）で定義（ライト値のあとにダーク値で上書き）。大分類は「カードの左の太い線 + 見出し左の形の印」。色だけに頼らず形と文字でも分かる。朱 `--shu`・緑 `--ok`・WBS 進捗線 `.pline`・予定の `--ev-*` とは別の色。

  | 大分類 | 色 | 印 |
  |---|---|---|
  | 今日決めること | 橙 | ▲ |
  | 着手の準備 | 紫 | ◆ |
  | WBS | 青緑 | ■ |
  | アイデア | 桃 | ● |
  | エージェント | 灰青 | ▼ |
  | 今日のブリーフ | 藍 | ◉ |
  | 実行状況 | 黄土 | ⬟ |
  | 動いているもの | 砂 | ◐ |

  | 小分類 | 見分け方 |
  |---|---|
  | 今日決めること | メッセージ = 丸い枠、期限 = 角の塗り、急ぎ = 二重線で太字（`k-msg` / `k-due` / `k-urgent`） |
  | 着手の準備 | 未定義・定義中・着手可の形の印（紫の枠）+ 下線 |
  | WBS | 行頭の内側の線: 親 = 太く濃い、子 = 中、孫以下 = 細く薄い（レイアウトは動かさない） |
  | タスクの印 | アイデア = 桃の枠、下調べ = 青の枠、重い = 破線（`tb-idea` / `tb-research`） |
  | 実行状況の役割 | mgr = 実線、システム・自己改善 = 二重線、sub mgr = 破線、worker = 点線（`rk-main` / `rk-system` / `rk-self` / `rk-task`） |

  クラス名の決定は `src/mainview/seg.ts`（テストは `seg.test.ts`）。
- md ファイルは読むだけ。書き込みは manager（Claude Code）が行い、変更は自動で表示に反映する（`ideas/`・`research/`・`state/plan/*.json` も）。

## タスク：WBS と着手の準備

- 親子は frontmatter の `parent`（親のファイル名）、並びは `wbs`（1 / 1.1 / 1.2 …）。進みは子の完了数か、`## 手順` のチェック数。
- WBS の親行は左の ▾ / ▸ で畳む・開く（Enter / Space でも。`aria-expanded` 付き）。畳むと子も孫以降も隠れる。親行の右の数字は子孫の件数（孫以降を含む、表に出ている行の数）。見出しの「すべて畳む / すべて開く」で一括。既定は開いた状態。畳んだ親はタスクのパスで localStorage の `wbsCollapsed` に保ち、再読み込み・ファイル更新による再描画のあとも保つ（保存できない環境でも表示は動き、その場合は毎回開いた状態から）。ロジックは `src/mainview/wbs-fold.ts`（テストあり）。
- WBS には進捗線（イナズマ線）を重ねる。ヘッダーの今日から出て、開いているタスク（done / dropped 以外、畳んで隠れた行は除く）の現在位置（帯の左端〜右端の「進捗」の割合の点）を上から結び、下端の今日に戻る。今日より左は遅れ（朱 `--shu`）、右は先行（緑 `--ok`）、同じなら墨。帯の塗りも同じ進捗。進捗は `progress`（%）→ 子の完了率 → 手順のチェック率 → 0（done は 100）。予定がまだ来ていないタスクは今日のラインを通る。
  - 子を持つ親の線は、自分の進捗ではなく子の実績で決める。開いている子孫の末端（孫以降も再帰）のうち最も遅れている（最も左の）位置に合わせ、親が子より遅れて見えることはない。予定（着手・期限）がなく位置が取れない子、done / dropped の子（子孫ごと）は除き、取れる子が 1 つもなければ親自身の進捗で引く。表示時の計算で、親の `progress` は書き換えない（帯の塗りは親自身の進捗のまま）。親の頂点は塗りつぶしの丸。
  - 見出しのチェック「進捗線を表示」「遅れ・先行で色を変える」（既定オン、localStorage の `wbsProgressLine`）。畳む・再描画・リサイズ（ResizeObserver）で引き直す。読むだけでタスクノートは書かない。ロジックは `src/mainview/wbs-progress.ts`（テストあり）。
- 完了条件・手順・期限がそろうまで本着手しない（`ready: 未定義 / 定義中 / 着手可`）。準備の期限は `prep_due`、空なら着手日の前営業日、それもなければ期限の 3 営業日前。
- 「着手の準備」欄は準備の期限が近い順に並ぶ。詳しくは `Manager/docs/schema.md` の「WBS」「着手の準備」。

## ターミナル（会話を混ぜない）

| タブ | 役割 | 寿命 |
|---|---|---|
| mgr | 人の窓口とルーティング。作業は sub mgr・worker に振る | 日付が変わると新しい会話にする（タブにボタンが出る） |
| 自己改善 | 自己改善 sub mgr = self impl mgr（固定 id `self`、タイトル「自己改善」）。自動 eod（ジョブ `eod`、毎日 3:00 に前日分を非対話で実行）と週次の自己改善（ジョブ `weekly-improve`、土日 4:00。金曜で終わる週のルールを自己判断で棚卸しして減らす方向に直し、ナレッジグラフを整える）の結果の受け取り・retro・改善。業務タスクとシステム改修は扱わない。人の判断が要るものは `messages/`（`from: self`）に起票し、終わったら mgr に `to: main` で返す | ずっと同じ会話（日替わりにしない。× はない） |
| システム | システム改修 sub mgr（固定 id `system`、タイトル「システム改修」）。manager システム自体の改修。実作業は worker `system-engineer` に出し、終わったら mgr に `to: main` で返す | ずっと同じ会話（日替わりにしない。× はない） |
| sub mgr | タスク 1 件の段取り。mgr が引き継ぎで立てる | × で閉じるまで（タスクノートは残る） |

- 1 タブ = 1 つの claude セッション。2 回目以降は `--resume` で続きから。
- **worker の帯** — タブの下に、いまのタブの worker を 1 行のチップ（状態の印・種類・依頼内容）で並べる。いなければ帯は出ない。作業中は青の点滅、完了は 60 秒で消える、失敗（朱）・止めた（灰）はそのタブを見るまで（最長 30 分）、止まっている（黄）は 30 分で消える。ホバーで経過時間と直近のツール。押すとそのタブに切り替え、盤面の実行状況でその worker を目立たせる。ほかのタブには「worker N」のバッジ（いちばん悪い状態の色）を出す。
- 起動時に `--model sonnet` と `--append-system-prompt`（skill `manager-app` を読み込ませる。システムは担当と報告のしかたも書く）を付ける。
- タブの並びは mgr → システム → 自己改善 → タスク（開いた順）で固定。出力や入力があっても動かない（以前は最終活動順で、動いたタブが末尾へ移っていた）。
- 「システム」「自己改善」のタブは常にある。claude はタブを開いたとき、または `to: system` / `to: self` のメッセージが届いたときに立ち上がる。ダッシュボードの「自己改善」カード（自動 eod の最終実行・結果・スキップの有無・判断待ちの提案数と retro 提案数、その下に週次の自己改善の最終実行・結果の 1 行。`jobs/eod.md` と `jobs/weekly-improve.md` の `last_run` / `last_status` / `last_note` と `messages/` の `from: self`、status=提案 の retro から）のボタンでこのタブに入る（会話の埋め込みは作り直しになるので固定タブ + カードにした）。
- 一覧は `Manager/state/ui/sessions.json`（`kind`: main / system / self / task）。mgr は `node scripts/submgr.ts list` / `read <タスク名|system>` で中身を読む。

### ドッキングシェル（claude と切り替えるターミナル）

- ターミナル枠の左上に「claude | シェル」の切り替え。ふだんはシェルは隠れていて、「シェル」か **⌘J**（もう一度で戻る）で、いまの claude タブと入れ替わる形で出る。claude は裏で動き続ける。
- シェルは claude タブごとに 1 つ。初めて出したときに起動する（cwd はそのタブの claude と同じ `Manager/`、`$SHELL -l`、なければ `/bin/zsh`）。タブを切り替えても生きていて、claude タブを閉じる（× / アプリ終了）と一緒に終わる。シェルで `exit` したら「Enter で再開する」と出る。画面のリロードでは、bun が持つ出力（128KB まで）を描き直す。
- シェルの入出力は claude の入力中・出力中の判定（handoff 配信の待ち・自動 compact・声かけ）に混ざらない。claude とは別の部品（`src/bun/shell.ts`、RPC `shellOpen` / `shellInput` / `shellResize` / `shellData`）で動く。スクロールバックは 1500 行。環境変数 `MANAGER_SHELL=1` が付く。
- シェルを出している間にダッシュボードから「貼る」「1 行打つ」（スラッシュコマンド等）をすると、先に claude に戻してから送る。
- 反映には再起動が要る（bun 側の変更）。テスト: `pnpm test`（`src/bun/shell.test.ts`）。
- 無効にする・戻す: `git revert <この機能の commit>`（または `src/mainview/index.html` の `#modes` を消すと切り替えが出なくなり、シェルは一度も起動しない）。シェルを一度も出さなければプロセスは起動しない。

## セッション間メッセージ（handoff）

mgr・sub mgr・システムは、Write ツールで `Manager/state/ui/handoff-<YYYYMMDD-HHMMSS>.json` を書いて互いに送る（`src/bun/handoff.ts` が解釈、`src/bun/hub.ts` が届ける）。

```json
{ "to": "main | system | self | tasks/<名>.md", "from": "mgr | system | self | <sub mgr のタイトル>", "brief": "…", "reply_to": "<任意。to と同じ形式>" }
```

- 従来の `{ "task": "tasks/…md", "brief": "…" }` もそのまま使える（to = task、from = mgr）。
- 本文の先頭に `[<from> から]` を付ける（brief が `[` で始まるなら付けない。`[mgr から: 人の指示]` 互換）。`from` がなければ「不明」。`reply_to` があれば末尾に「返信は state/ui/handoff-*.json の to に <reply_to> を入れて送る」を足す。
- 宛先の claude が動いていなければ、本文を最初の発言にして立ち上げる（タスクの sub mgr はなければタブを作る）。動いていれば、声かけと同じ「送ってよい」条件（下記）を満たすまでファイルを残して待ち、満たしたら貼って送る。同じ宛先にはファイル名順に 1 件ずつ。
- 宛先が不正・タスクノートがない・brief が空・1 分たっても JSON として読めないものは、`Manager/state/ui/handoff-errors.log` に 1 行書いてファイルを消す（`reply_to` が不正なときは本文だけ届けて 1 行残す）。
- 画面: mgr からタスクの sub mgr への引き継ぎは、従来どおりそのタブを前に出す。それ以外（sub mgr から mgr への報告、システムへの依頼など）は「<from> から「<宛先>」に届いた」と知らせるだけで、画面は切り替えない。
- 確かめ方: `pnpm test`（`src/bun/handoff.test.ts`）。

## ファイルのドラッグ＆ドロップ

Finder のファイル（複数可）や、ほかのアプリからのパス・`file://` URL・テキストを落とせる（`src/mainview/drop.ts` / `src/bun/drop.ts`）。ドラッグ中は落とせる先がうっすら光る。ほかの場所に落としても何も起きない（webview がファイルを開かない）。

- **ターミナルのカード** — Terminal.app と同じく、エスケープした絶対パスを空白区切りで、いま見ているタブに貼る（送信しない）。画像のパスも同じ（claude が画像として読む）。パスでないテキストはそのまま貼る。
- **Clawd くん（本体・吹き出し）** — ファイルを `buddy/drops/` にコピーし、吹き出しを開いて入力欄に `ファイル: <コピーのパス>` を差し込む（送信しない）。Clawd くんは作業場の中しか読めないのでコピーして渡す（権限は広げない）。1 ファイル 10MB まで、フォルダは断る。テキストはそのまま差し込む。
- **パスの取り方** — WKWebView はドロップされたファイルのローカルパスをページに渡さない。`text/uri-list` に `file://` があればそれを使い、なければドロップの直後にドラッグ用ペーストボードを Swift のヘルパー `native/drag-paths.swift` で読んで、名前と大きさが合うパスを使う。それでも分からない（ほかのアプリから画像を直接ドラッグしたなど）ときは、画面がファイルを読んで Bun に送り、一時ファイル（ターミナルは userData の `drops/`、上限 50MB）に書いてそのパスを使う。
- `drops/` は起動時に 7 日より古いものを消す。

## 壁打ち相手 Clawd くん

ターミナルのタブではなく、アプリのウィンドウ全体の上をふよふよ歩くオレンジのドット絵の生き物（`src/mainview/clawd.ts`）。会話は `src/bun/buddy.ts`。

- **呼び方** — 本人をクリックすると吹き出しが開き、その場で話せる（Enter で送る・Shift+Enter で改行・Esc で閉じる）。**Ctrl を 2 回**（300ms 以内に Ctrl だけを 2 回）押すと、アプリが前面なら吹き出しを開き、ほかのアプリが前面ならアプリを前に出すだけにする（もう一度 Ctrl を 2 回で吹き出し）。
- **動き** — ゆっくりランダムに歩く・止まる・たまに向きを変える。ドラッグで好きな場所へ動かせる（位置は次回も覚えている）。吹き出し（背景 75% 透過、文字は既定 12px。入力欄にいるとき ⌘- / ⌘⇧- または ⌘= / ⌘0 で拡縮）を開いている間は歩かず、返事中は小さく揺れる。掴まれている間は目が「><」になり、手足をバタバタさせて汗を飛ばす（檻に近いほど激しく、汗の間隔も短い）。ターミナルのタブの帯の丸いボタン（↓ / →）の背後に檻があり（ボタンは手前に出る）、その上で離すと閉じ込められて中だけを歩く（掴んで外に出すと出られる。状態は次回も覚えている）。本体と吹き出し以外はクリックを透過するので、ダッシュボードやターミナルの操作を邪魔しない。
- **キャラクター** — `buddy/CLAUDE.md`（なければアプリが作る。あれば上書きしない）。敬語を使わない、語尾に「〜なー」、考えるとき「んむむ」。知能の低い友達として、共感・相づち・ずれた感想・ゆるい問い返しで短く返す。
- **裏の役目** — 話に 詰まり / 感情 / 脱線 / アイデア / 体調 が出たら「mgr にも言っとくなー」と言い、`Manager/state/buddy/feedback-<YYYYMMDD-HHMMSS>.json`（`{ "kind", "summary", "task", "severity" }`）を書く。アプリ（pulse）がそれを拾って mgr に合図し、`state/buddy/log.jsonl` に移す。アイデアは `Manager/ideas/<YYYYMMDD>-<短い名前>.md`（source: 壁打ち）にも保存する。
- **セッション** — 専用の作業場 リポジトリ直下の `buddy/`（祖先に CLAUDE.md を置かない。vault の CLAUDE.md・hook を読ませない。`BUDDY_DIR` で変えられる。見つからなければ `~/Documents/work/manager-app/buddy`）で、`claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --model haiku` を 1 本持ち続け、返事をストリームで受ける。アプリを開くたびに新しい会話（新しい session id。`--resume` しない）。落ちたら新しい会話で立ち上げ直す。
- **権限** — 書けるのは `Manager/state/buddy/feedback-*.json` と `Manager/ideas/*.md` だけ。読めるのは作業場・`Manager/tasks/`・`Manager/goals.md`。ツールは Read / Write だけ、MCP・skill なし、`--setting-sources project,local`（ユーザー設定の hook を読まない）、`--permission-mode dontAsk`（許可していないものは確認を出さずに断る）。規則は `buddy/.claude/settings.json`（アプリが毎回作り直す）に書くが、信頼していない作業場では allow が無視されるので、同じ規則を起動の引数（`--allowedTools`・`--disallowedTools`・`--add-dir`）でも渡す。`--add-dir` のため、アプリは `Manager/state/buddy/` と `Manager/ideas/` がなければ作る。
- **10 日ごとの要約** — 起動時と 1 日 1 回、`buddy/memory.md` が 10 日より古ければ（なければ）作り直す。材料は `~/.claude/projects/<作業場>/*.jsonl` のうち過去 30 日の分で、人の発言と Clawd くんの返事の文だけ（新しい順に 3 万字まで）。haiku で「最近の気分の傾向・よく出る話題・詰まりやすいこと・覚えておくとよいこと」にまとめ、frontmatter に `period` と `updated` を書く。CLAUDE.md が `@memory.md` で読む。
- **Ctrl 2 回のヘルパー** — `native/hotkey.swift`（NSEvent のグローバル監視）。ax-snapshot と同じく起動時に userData の `bin/` にコンパイルして常駐させる。アクセシビリティの権限が要る（ないときは 1 回だけ案内。アプリが前面のときは権限なしでも画面側で効く）。
- 引き継ぎ・セッション間のやりとりは上の「セッション間メッセージ」。worker は mgr / sub mgr が呼ぶサブエージェント。
- サブエージェントは `Manager/.claude/agents/`: `judge`（opus、判断）、`researcher`（sonnet、下調べ）、`builder`（opus、コーディング・資料作成）、`system-engineer`（opus、manager システム自体の改修。システムのタブが呼ぶ）。

## 声かけ（mgr から話しかける）

アプリ（`src/bun/pulse.ts`）が 30 秒ごとにファイルを見て、きっかけがあれば mgr のターミナルに `[manager-app: 声かけ HH:MM] …` という合図を送る。合図を受けた mgr は先に調べたり下書きしたりしてから、人に話しかける。判定は決まった規則だけで行うので、きっかけがない間はトークンを使わない。

- きっかけ（平日・祝日以外の勤務時間内）
  - 始業（人がまだ話しかけていないとき）
  - 会議の 10 分前
  - Meet のある会議が終わって 10 分後
  - 新しい未読メッセージ（優先度 高 はすぐ届ける）
  - 13:30 の昼の確認（準備の期限・締切が来ているタスク）
  - doing のタスクがあるのに 90 分操作がないとき
  - 18:00 の終業
  - 脱線: 活動の記録で「関係ないこと」が `off_task_min`（30 分）続いたとき。なお続けば `off_task_repeat_min`（60 分）後にもう 1 回（1 区切りで最大 2 回）。すぐには言わない
  - 停滞: 同じタスクに `stuck_min`（90 分）いて、そのタスクノートがその間更新されていないとき（skill の「ストッパー」で出力を絞る提案をする）
- 壁打ち（Clawd くん）からのフィードバック（時間帯に関係なく。severity 高はすぐ届ける）
- 予約: mgr が `state/ui/nudge-*.json`（`{ "at": "15:00", "text": "…" }`）を書くと、その時刻に合図が届く。
- 止まっていた間の取りこぼし（`src/bun/catchup.ts`）: アプリが落ちていた・再起動していた間に過ぎた予約は、再開後の最初の判定で 1 回だけ届ける（`HH:MM` は書いた日の時刻として扱い、10 分以上遅れたら本文に「遅れて届いた」と付ける。届けたらファイルを消し、`pulse.json` にも記録するので重複しない）。止まっていた間に届いた未読メッセージは、起動時に「既にある未読」として黙らせず、勤務時間内に通常どおり 1 回声かけする（30 秒ごとに `pulse-alive.json` へ生存時刻を書き、それより新しいものを拾う）。残った `handoff-*.json`・壁打ちの `feedback-*.json` は、起動後の最初の周回で通常どおり処理する。画面の状態は起動時に vault を読み直す（ファイル監視のイベントには頼らない）。
- 割り込まない: claude の出力が 15 秒止まり、人が最後にキーを打ってから 30 秒たち、入力欄に打ちかけの文字がなく、アプリが 15 秒以内に何も送っておらず、許可の確認が出ていないときだけ送る（`Term.readyForNudge`。セッション間メッセージと定期の compact も同じ条件）。
- 条件は `Manager/settings/manager-app.md` で変えられる。上限は 1 日 12 回で、急がない合図の間は 20 分あける。送ったきっかけは userData の `pulse.json` に記録する。
- 通知: 合図を送ったとき、アプリのウィンドウが前面でなければ macOS の通知も出す（`notify: false` で止める）。

## 会議の自動オープン（`src/bun/meeting-open.ts`）

会議の開始の 5 分前に、`calendar/upcoming.md` の予定の `Meet:` / `Teams:` のリンクを macOS の `open` で開く（ブラウザ / Teams が前に出る。アプリ自身は前に出さない）。開いたら 1 行のトーストで知らせる。声かけ（`nudge`）とは独立した 30 秒ごとの判定。

- 開く: Meet（meet.google.com）か Teams（teams.microsoft.com / teams.live.com）の https リンクがあり、辞退でない予定。未回答も開く（`meeting_open_unanswered: false` で止める）。社内 / 社外は区別しない。
- 開かない: リンクなし（対面だけ）・Zoom など他のリンク・終日・開始を過ぎた予定（起動直後に過去の会議を開かない）。
- 予定が古いとき（ジョブ calendar の `last_status: error` で、その回より前の取得 / 取得の回から 30 分たっても取れていない / ジョブが読めず 6 時間以上前の取得）は何も開かず、「予定が古いので会議を自動で開けない」を 1 日 1 回だけトーストで出す（前面でなければ macOS の通知も）。
- 二重に開かない: 開いた予定（日付・開始・件名・URL）を `Manager/state/ui/meeting-open.json` に残す。日が変わったら前日までの分を消す。
- 設定は `Manager/settings/manager-app.md` の `meeting_open` `meeting_open_before_min`（1〜60）`meeting_open_unanswered`。

## 文脈の compact（`src/bun/compact.ts`）

会話が膨らむと mgr が重くなるので、全タブ（mgr・システム・sub mgr）で 2 段で畳む。設定は `Manager/settings/manager-app.md`。

1. **claude 自身の自動 compact を早める** — claude の起動時の env に `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`（`autocompact_pct`、既定 60）と `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（`autocompact_window`、既定 200000）を足す。公式 docs（code.claude.com/docs/en/env-vars・model-config）では、前者は「auto-compact window に対して何 % で自動 compact するか」（既定の割合より上げられない）、後者はその窓のトークン数（100K〜1M）。sonnet は 1M の窓で既定では約 967K で畳むので、窓も小さくする（200K × 60% ≒ 12 万トークン）。0 なら渡さない。起動時にだけ効く。
2. **定期の `/compact`** — 1 分ごとに、claude が動いていて「送ってよい」状態のタブのうち、前回の compact（か起動）から `compact_min`（45 分）以上たち、文脈が `compact_tokens`（90000）を超えるものに、残す要点を指示した `/compact …` を送る（1 周 1 タブ、1 タブ 1 日 `compact_max_per_day`（6）回まで、`compact: false` で止める）。
   - 文脈の大きさは `~/.claude/projects/<cwd>/<session>.jsonl` の末尾 1MB で、最後の assistant 行の usage（`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`）。それより後に compact の境目（`compact_boundary`）があれば、その `postTokens`。
   - 指示文: mgr は「未完了のタスクと next_action、人に確認中の事項、sub mgr に渡した依頼と返事待ちの件、決まったこと」、sub mgr は「担当タスクの完了条件・手順・決定・次の一手」、システムは「担当の改修の依頼・完了条件・手順・決定・worker に出した作業と結果・次の一手、mgr への報告待ち」、自己改善は「自動 eod の結果と未処理の提案、承認待ちの retro、人に確認中の事項、直近の改善の決定と次の一手、mgr への報告待ち」を残し、生ログ・ツール出力は捨てる。
   - 回数と最後に送った時刻は userData の `compact.json`。

## 活動の記録（脱線・停滞の材料）

`src/bun/activity.ts` と Swift のヘルパー `native/ax-snapshot.swift`。

- `activity_interval_min`（5 分）ごとに、平日の勤務時間内（声かけと同じ時間帯）で、人が操作中のときだけ採る。最後の入力から 5 分以上（`ioreg -c IOHIDSystem` の HIDIdleTime）なら「離席」、画面ロック中も「離席」として中身は読まない。
- 採るもの: 前面アプリの前面ウィンドウの Accessibility ツリーの文字（深さ 40・要素 4000・約 3 秒・合計 4000 字まで）。パスワード欄（AXSecureTextField）は読まない。Electron のアプリ（Slack・VS Code など）は `AXManualAccessibility`、Chrome 系は `AXEnhancedUserInterface` を立ててから読む。アプリ自身が前面のときは読まずに「関連の仕事」とする。
- 生の文字はメモリにだけ持つ。`classify_every_min`（15 分）ごとに未分類の分をまとめて haiku（`claude -p --model haiku --safe-mode --tools "" --strict-mcp-config --no-session-persistence`、作業場は userData の `classify/`）で分類し、`Manager/state/activity/YYYY-MM-DD.jsonl` に区間（`from`・`to`・`label`: task / related / off / idle・`task`・`app`・`summary`）だけを追記する。14 日より古いファイルは消す。分類の材料は today / doing のタスク（名前・next_action・完了条件の先頭）。
- 実行状況の最初の行に、最後の 1 区間を出す。
- `activity: false` で止める。

### ヘルパーのビルドと権限

- アプリは起動時に、ヘルパーの元（バンドルに文字列として同梱）を userData の `bin/ax-snapshot` に `/usr/bin/swiftc` でコンパイルする（元が変わったときだけ）。swiftc がなければ `xcode-select --install`。
- 手で試すとき: `pnpm build:native && native/bin/ax-snapshot`（前面アプリの JSON が出る）。`native/bin/hotkey` は Ctrl を 2 回押すと `summon` を出す。
- アクセシビリティの権限が要る。権限がないとき、画面に 1 回だけ案内を出す。システム設定 > プライバシーとセキュリティ > アクセシビリティで許可する。
  - 配布版: `manager.app` を許可する。
  - `pnpm dev`: ヘルパーはアプリの子プロセスなので、macOS は起動元の「責任のあるアプリ」に権限を問う。ターミナルから `pnpm dev` したなら、そのターミナル（Warp・Terminal・iTerm・VS Code など）を許可する。`manager-dev.app` を許可しても、ターミナルから起動している間は効かない。
  - 許可したらアプリを立ち上げ直す（案内は 1 起動に 1 回）。

## 使い方

```sh
export PATH="$HOME/.hutch/bin:$PATH"
pnpm install          # 依存と bun（devDependencies で 1.4.4 に固定）
pnpm dev              # 起動（hutch electrobun dev）
pnpm typecheck
pnpm test             # 純関数のテスト（bun test src/bun src/mainview）
pnpm build            # 配布用ビルド
```

- アプリ本体の実行時の bun は Electrobun が同梱するもの（PTY は `Bun.spawn` の `terminal`）。pnpm で固定している bun は開発時のスクリプト用。
- Shift+Enter で改行。ターミナルのテキスト選択は、claude がマウスを使っている間は Option を押しながらドラッグ。
- 日本語の幅をそろえたいときは HackGen Console / PlemolJP Console / UDEV Gothic のどれかを入れると自動で使う。

環境変数:

| 変数 | 既定 |
|---|---|
| `MANAGER_DIR` | `~/Documents/Obsidian Vault/Manager` |
| `CLAUDE_PATH` | PATH 上の `claude`、なければ `~/.local/bin/claude` |
| `MANAGER_APP_ROOT` | 開発時のリロードで監視するリポジトリ。既定は dev のアプリの場所（`build/` の上）か起動元のディレクトリ |

### 開発時のリロード

`pnpm dev`（channel が dev）で動かしている間は、画面側の変更をアプリを再起動せずに反映する（`src/bun/dev-reload.ts`）。claude のセッション（mgr / sub mgr）は bun プロセスの子なので、再起動すると全部終わってしまう。それを避けるための仕組み。

- 反映されるもの: `src/mainview/` の ts と `index.html` / `index.css`、`src/shared/`。保存すると bun 側が画面を作り直し（ts は `Bun.build`、html / css はコピー）、WebView だけを `location.reload()` で読み込み直す。テスト（`*.test.ts`）の変更では読み込み直さない。
- 読み込み直しても残るもの: ターミナルは bun 側で動き続ける。画面は開き直したときに直近の出力（1 本 512KB まで）から描き直す。前に出していたターミナル・開いていたノートのタブ・スクロール位置は sessionStorage に控えて戻す（アプリを再起動すると消える）。折りたたみ・分割位置・文字の大きさなどは従来どおり localStorage に残る。
- ビルドに失敗したときは読み込み直さず、トーストとログにエラーを出す。直して保存し直せば反映される。
- 再起動が要るもの: `src/bun/` の変更、`electrobun.config.ts`、依存の追加。この仕組み自体も bun 側にあるので、入れた直後は 1 回の再起動で有効になる。
- 配布用（`pnpm build`、stable / canary）では動かない。
- 公式の `hutch electrobun dev --watch`（hutch.config.ts の `dev`）はアプリごと作り直して再起動する。こちらを使う場合も、`watchIgnore` で `src/mainview/` の変更では再起動しないようにしてある（画面の変更は上の仕組みが反映する）。

アプリ自身の状態（タブとセッション ID）は Electrobun の userData（`terms.json`。声かけの記録は `pulse.json`、定期の compact の記録は `compact.json`）に置く。Manager/ に書くのは、引き継ぎ・予約・壁打ちのファイルを読んで消す（壁打ちは `state/buddy/log.jsonl` に移す）とき、届けられなかったメッセージの `state/ui/handoff-errors.log`、`state/ui/sessions.json`、自動で開いた会議の記録（`state/ui/meeting-open.json`）、活動の記録（`state/activity/`）、Clawd くんのための `state/buddy/`・`ideas/` のフォルダ作成だけ（中身を書くのは Clawd くん）。

## アイコン

- ソース: `assets/icon.svg`（手書き SVG。紺の角丸正方形にカレンダー + チェック）。プレビュー用 PNG は `assets/icon-1024.png`。
- Electrobun は `electrobun.config.ts` の `build.mac.icons`（= `assets/icon.iconset`）を、ビルド時に iconutil で .icns にしてアプリに入れる。`.iconset` フォルダ（コミット済み）を指すので、.icns 自体は置かない。
- 作り直し（`rsvg-convert` は `brew install librsvg`）:

```sh
cd assets
rsvg-convert -w 1024 -h 1024 icon.svg -o icon-1024.png
rm -rf icon.iconset && mkdir icon.iconset
for s in 16 32 128 256 512; do
  rsvg-convert -w $s -h $s icon.svg -o icon.iconset/icon_${s}x${s}.png
  rsvg-convert -w $((s*2)) -h $((s*2)) icon.svg -o icon.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns icon.iconset -o /tmp/check.icns   # 検証用（不要なら省略）
```

- 反映: アプリの再起動（dev ならビルドし直し）が要る。dev ビルドで Dock のアイコンが変わるかは未確認（Hutch 2.0.6 の公開 API に dev での扱いの記述が無い）。変わらなければ `pnpm build`（stable）の .app で確認する。

## 構成

| パス | 内容 |
|---|---|
| `src/bun/index.ts` | ウィンドウ・メニュー・RPC の配線 |
| `src/bun/hub.ts` | タブの束ね役（日替わり・システム／自己改善のタブ・セッション間メッセージの配達・保存） |
| `src/bun/handoff.ts` / `handoff.test.ts` | セッション間メッセージの解釈（純関数）とテスト |
| `src/bun/compact.ts` | 自動 compact の env と、定期の `/compact` |
| `src/bun/term.ts` | claude 1 セッションを PTY で動かす（アプリから送ってよいかの判定） |
| `src/bun/vault.ts` | Manager/ の読み取り・frontmatter・準備状況・先読み・変更監視 |
| `src/bun/pulse.ts` | 声かけ（合図の規則・壁打ちからのフィードバック） |
| `src/bun/catchup.ts` | 止まっていた間の取りこぼしを拾う純関数（予約の時刻解釈・遅れの注記・未読の seed 判定） |
| `src/bun/meeting-open.ts` / `meeting-open.test.ts` | 会議の自動オープン（開く予定の選び方・予定の古さ・二重オープン防止）とテスト |
| `src/bun/activity.ts` | 活動の記録（前面ウィンドウを採り、haiku で分類） |
| `src/bun/buddy.ts` / `buddy-files.ts` | Clawd くんの会話・作業場のファイル・10 日ごとの要約 |
| `src/bun/hotkey.ts` | Ctrl の 2 連打のヘルパーを常駐させる |
| `src/bun/native.ts` / `haiku.ts` | Swift のヘルパーのコンパイル / 1 回きりの haiku 呼び出し |
| `src/mainview/clawd.ts` | Clawd くんの見た目・歩き・吹き出し |
| `native/hotkey.swift` | Ctrl の 2 連打を見張るヘルパー |
| `src/mainview/drop.ts` / `src/bun/drop.ts` | ファイル・パスのドラッグ＆ドロップ（ターミナル・Clawd くん） |
| `native/drag-paths.swift` | ドラッグ用ペーストボードのファイルの絶対パスを JSON で出すヘルパー |
| `src/bun/settings.ts` | `Manager/settings/manager-app.md` の読み取り |
| `native/ax-snapshot.swift` | 前面ウィンドウの Accessibility ツリーの文字を JSON で出すヘルパー |
| `src/bun/shell.ts` / `shell.test.ts` | ドッキングシェル（claude タブごとの PTY シェル。Term とは別）とテスト |
| `src/shared/types.ts` | RPC スキーマと共有の型 |
| `src/mainview/` | 画面（HTML / CSS / TS、xterm.js） |
| `src/mainview/graph.ts` | アイデアのグラフ（canvas と力学配置） |
| `src/bun/dev-reload.ts` / `dev-reload.test.ts` | 開発時のリロード（画面側の変更で作り直して WebView だけ読み込み直す）とテスト |
| `src/mainview/reload-state.ts` / `reload-state.test.ts` | リロードの前後で戻す画面の控え（ターミナル・ノートのタブ・スクロール）とテスト |
