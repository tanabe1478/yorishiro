# yorishiro

自分の判断基準、作業習慣、再利用可能な手順を育てるための [pi](https://pi.dev) ハーネスです。

## 設計

- `AGENTS.md`: すべての作業で常に使う原則
- `AGENTS.local.md`: 公開しない個人的な補足（Git 管理外）
- `skills/`: 必要なときだけ読む再利用可能な手順
- `extensions/`: 指示だけでは保証できない制御や外部連携
- `package.json`: yorishiro の Skill と Extension をpiへ登録するマニフェスト
- `work/`: このハーネスで扱う作業リポジトリ（Git 管理外）

認証、通常設定、セッションは標準の `~/.pi/agent/` を共有します。yorishiro はそれらを複製せず、リポジトリ固有の能力だけを追加します。

## セットアップ

通常のpiをインストールしてログインしたうえで、必要ならローカル設定を作成します。

```bash
cp AGENTS.local.example.md AGENTS.local.md
./bin/yorishiro
```

既存のpi認証、グローバル設定、グローバルSkillをそのまま利用します。ランチャーはyorishiroをローカルpiパッケージとして追加ロードします。

## 作業リポジトリで起動する

`work/` 配下にリポジトリを置くと、yorishiro の `AGENTS.md` を親ディレクトリのコンテキストとして利用できます。

```bash
git clone <repository-url> work/example
cd work/example
../../bin/yorishiro
```

ランチャーは起動時のカレントディレクトリを維持したまま、yorishiroのSkillとExtensionを追加します。piのホームやセッション保存先は変更しません。

## 開発パイプライン

親Piで要件と実装計画を合意した作業は、`development_pipeline`へ委譲できます。Plannerは親セッション自身であり、子Plannerは起動しません。

| 役割 | 固定モデル | 担当 |
|---|---|---|
| Planner（親） | 親セッションのモデル | 要件、計画、Reviewer指摘の採否 |
| Worker · Luna | `openai-codex/gpt-5.6-luna`（既定thinking: `high`） | 実装、テスト、ビルド、動作確認、修正 |
| Reviewer · Sol | `openai-codex/gpt-5.6-sol`（既定thinking: `medium`） | read-onlyレビュー、sandbox内の独立検証 |

パイプラインはHerdr内で起動したPiからのみ実行できます。通常実行では別タブを作らず、呼出元の現在タブを、親55%、右45%のWorker／Reviewer上下2段へ分割します。子は通常のPi TUIとして表示され、修正と再レビューでは同じペインを再利用します。子からパイプラインを再帰起動することはできません。修正版Extensionを新規ロードする使い捨てE2Eだけは隔離タブを使用し、確認後にタブ全体を削除します。

WorkerとReviewerは中央validatorが検証する構造化JSONで報告します。`development_pipeline`には必須の`qualityContract`（承認項目、独立check、任意の変更path prefix）を渡します。契約はSHA-256とともに`quality-contract.json`／`run.json`へ保存されます。`COMPLETED`は`completedPlanItems`のcontract ID exact一致、`changedPaths`の実diff exact一致、prefix遵守、独立checks成功が必須です。`BLOCKED`は完了済みcontract IDのsubset（unknown／duplicate不可）とactual `changedPaths` exact一致、prefix遵守を必須とし、独立checksとReviewerを起動せず`IMPLEMENTATION_BLOCKED`で終わります。BLOCKEDでも虚偽ID／path／prefix違反は許しません。

Quality evidence不一致の初回だけ、Reviewerを起動せず同じWorkerペインへpath本文を除いたsanitized findingを送り、quality repairを1回行います。signatureは違反種別とcontract item/check IDで安定化します。同じsignatureの再発はSol Workerへの切替理由をartifactへ残して`NEEDS_PLANNER`、異なる2回目の違反は`WORKER_EVIDENCE_MISMATCH`で停止し、loopしません。COMPLETEDのReviewer開始前にはrequiredChecksを対象checkoutの使い捨てsnapshot上で順次実行し、失敗・timeout・cancelは`QUALITY_GATE_FAILED`として停止します。各checkは出力SHA-256に加えて最大4KiBの診断抜粋をartifactと失敗結果へ残します。Reviewerの判定は`APPROVED`、`APPROVED_WITH_NOTES`、`CHANGES_REQUESTED`、`NEEDS_PLANNER`です。Workerへ戻す情報はsanitized blocking findingだけに制限し、Reviewerの生出力やtranscriptを渡しません。同じ指摘IDの再発や、修正後に理由なく追加されたblockingは`NEEDS_PLANNER`で止まります。

修正回数は`maxReviewCycles`で指定でき、既定2、上限3です。旧`maxRepairCycles`も互換入力として受理し、両方指定時は`maxReviewCycles`を優先します。欠落・不正レポート、プロセス失敗、timeout、中断は安全側で停止します。失敗・中断・Planner判断待ちでは子ペインを残します。監視はHerdrの特定status名だけに依存せず、exact Pi identityとdurable reportを完了根拠にします。durable reportがないままexact Piが`idle`／`done`／`completed`になった場合は、activeを観測済みなら直ちに、起動直後からquiescentならstartup grace後に有限のreport-missing猶予を開始し、期限でfail closedします。猶予中にreportが現れれば通常settleし、activeへ戻ればtimerを解除します。未知・undefined statusだけでは欠落と断定しません。report-missing時はterminal transcript、heartbeat、`run.json`へ診断を残し、ペインを保持します。監視中のheartbeatは`run.json`へ継続記録します。

Reviewerとquality gateの検証コマンドは、対象checkoutをcopy-on-write優先で使い捨てsnapshotへ複製し、そのsnapshotだけを書き込み可能にしたmacOSの`sandbox-exec`またはLinuxのbubblewrap/user namespace内で実行します。ビルド成果物やテストfixtureはsnapshotへ書けますが、元checkoutへの書き込みはkernelで拒否されます。未対応環境、sandbox未導入環境、`/tmp`配下の対象は作業開始前に拒否します。

成果物は`artifacts/<repository>/<run-id>/`に保存されます。主な内容は依頼、承認済み計画、`quality-contract.json`、`plan-review.json`、`diff-review.json`、各attemptの構造化report、quality gate結果、baselineと各Worker stageのstatus/diff/fingerprint、`run.json`です。baseline fingerprintとの差分で既存dirty pathの内容変更、untracked・deleted・renameも検出します。

成功時の整理は`cleanupMode`で制御します。

- `ask`（既定）: UIで確認する
- `on-success`: 成功時だけ整理する
- `never`: ペインを残す

後から`development_pipeline_cleanup`へrunディレクトリを渡して整理できます。失敗・中断runは成功用cleanupと分離された`development_pipeline_reset`で、canonical runDirと現在のworkspace/tab、明示confirm、記録済みpane identity、idle状態を検証してから安全にresetします。新構成はReviewer→Worker、旧構成はReview→Verify→Implementの順に閉じます。親ペイン、非idleペイン、別runのペインは保護されます。開始時に現在タブへ親以外のペインがある場合は`LAYOUT_OCCUPIED`として停止し、他人のペインを自動削除しません。

人間レビューは`planReviewMode`と`diffReviewMode`で制御します（`ask`既定、`required`、`skip`）。計画レビューは子ペイン起動前、差分レビューはReviewer完了後かつcleanup前に実行し、結果と計画SHA-256をrun artifactへ保存します。変更要求や必須レビューの失敗では安全側で停止し、commit・pushは行いません。

## セッション観測（observer）

`bin/yorishiro-observe` は、動いている pi または Claude Code のセッションログ（JSONL）を読み取り専用で追いかけ、人間向けに状態を要約します。エージェントには介入せず、あなたが「いま見る価値があるか」を判断する材料だけを出します。

```bash
# カレントディレクトリの最新セッション（pi / Claude Code の新しい方）を追いかける
./bin/yorishiro-observe

# Herdr のペインに紐づくセッションを追う / 形式を固定 / 1回だけ評価 / macOS 通知
./bin/yorishiro-observe --pane w5:p8S
./bin/yorishiro-observe --claude --once
./bin/yorishiro-observe --pi --notify
./bin/yorishiro-observe path/to/session.jsonl --json

# Herdr の現在ペインを下に分割し、そこで自分のセッションを追う observer を起動する
./bin/yorishiro-observe --open-pane --notify
```

表示は緑（放置してよい）、黄（そろそろ確認）、赤（介入を検討）の3段階で、根拠と「エージェントに何を伝えるか」の文案を添えます。

### Web ダッシュボード

Herdr を使わない場合や複数セッションをまとめて見たい場合は、ローカルの Web サーバーとして起動します。

```bash
./bin/yorishiro-observe serve --open            # http://127.0.0.1:4877/ をブラウザで開く
./bin/yorishiro-observe serve --notify --hours 6  # 6時間以内に動いたセッションだけ追い、黄・赤で macOS 通知
```

`~/.pi/agent/sessions/` と `~/.claude/projects/` を走査して動いているセッションを自動検出し、1枚ずつカードで表示します。カードには判定と根拠、エージェントへ送る文案（コピーボタン付き）、コスト判定と運転の変え方、コンテキスト・検証・差分・トークン内訳が載ります。Herdr が動いていればペイン ID も付きます。/clear（Claude Code）や新規セッション開始（pi、同じプロジェクトで直前まで動いていたセッションがある場合）を検出し、置き換えられた旧セッションは「終了 → 新セッション … に置換」として畳み、新セッションは「最初の指示待ち」と表示します。更新は Server-Sent Events で即時反映、外部依存はありません。bind 先は `127.0.0.1` 固定が既定で、`--host` で変えられます。API は `/api/sessions`（JSON）と `/api/events`（SSE）です。`?all=1` でフィルタを外した状態、`?nosse=1` で SSE を使わないポーリング表示（ヘッドレスブラウザでの撮影用）になります。

### 決定論的な判定

| 判定 | 内容 |
|---|---|
| 同一反復 | 直近20回のツール呼び出しで同じコマンド実行や同じファイルの読み直しが3回以上 |
| エラー反復 | 同じエラー文字列（先頭2行、数字を無視）が3回以上 |
| 検証失敗の連続 | 検証コマンド（test / lint / typecheck / build 系）が2回以上連続で失敗 |
| 未検証編集 | コードの編集後12回（黄）/ 25回（赤）のツール呼び出しで検証コマンドがない、または検証せずにターンを終えた。Markdown などの文書編集は対象外 |
| フェーズ逸脱 | 編集後、検証に進まず5回連続で読み取り・検索に戻った |
| 終了時監査 | ターン終了時に、編集以降 test / lint / typecheck / build のどれが成功したかを表示。プロジェクトに lint・型チェックの手段（package.json の scripts、Makefile、pyproject）があるのに走っていなければ参考情報として出す |
| スコープ拡大 | 現在のターンで変更ファイルが8件（黄）/ 15件（赤）以上 |
| 差分の増大 | 作業ツリーの `git diff` が300行（黄）/ 1000行（赤）以上。未追跡ファイル数も表示 |
| TODO 混入 | 差分の追加行に TODO / FIXME / XXX / HACK がある |
| コンテキスト使用率 | モデルの上限に対して75%（黄）/ 90%（赤）以上。上限はモデル名から推定し `--context-limit` で上書き可能 |
| 停滞 | 作業中のはずなのに10分以上ログに動きがない |
| サブエージェント | 起動が3回以上 |
| キャッシュミス | pi 本体（`core/cache-stats`）と同じ式。前回リクエストのプロンプト量と今回の cache read の差を再課金量とみなし、1,024 トークン以下は無視、compaction で基準をリセット、モデル切替は数える。原因を「モデル切替 / 中断 / 不明」で分け、pi のログでは料金内訳から追加コストも出す。前回プロンプトの 10% 未満の小さな再作成（Claude Code の毎呼び出しで起きる）は「部分再書込」として別集計。キャッシュ寿命は Claude Code の usage（ephemeral_1h / 5m）から読み、pi は 5 分を既定にする |
| ターンの浪費 | 1ターンでモデル呼び出しが25回（黄）/ 50回（赤）以上 |
| 出力・thinking 過多 | 料金比重（出力 100 : cache read 1）で見て出力と thinking が全体の50%以上。pi の thinking level も表示 |

Bash 経由の書き込み（heredoc、`tee`、`sed -i`）も編集として数えます。heredoc の本文はコマンドとして解釈しません。検証コマンドの判定は `--verify REGEX` で上書きできます。Claude Code のサブエージェント（sidechain）の動きは本体の判定から除外し、スラッシュコマンド（/clear、/model など）は会話ターンとして数えません。まだ 1 ターンも進んでいないセッションには判定を出しません。

### 分類器（安いモデル）

黄・赤に変わったとき、またはターンが終わったときだけ、構造化サマリ（目的、フェーズ、直近の行動、変更ファイル、テスト回数、決定論的判定）を安いモデルに渡し、5分類で返させます。全文の会話は渡しません。30秒に1回までです。

| 分類 | 意味 |
|---|---|
| CONTINUE | 任せてよい |
| VERIFY | 検証させる |
| REPLAN | 同じ失敗の繰り返しや迷走。仮説を見直させる |
| COMPACT | コンテキストが主なリスク |
| ASK_USER | 人間の判断や確認が必要 |

あわせて進捗率の推定、要件がカバーされているか、エージェントの報告と実際の行動が一致しているか（テストを走らせずに「通った」と言っていないか）を返します。

コスト面は、記事「What a task costs on Opus 5.5」の原則（cost/task で見る、不要なターンが最も高い、キャッシュ書き直し1回 ≒ 読み25回、出力1トークン ≒ cache read 100トークン、effort は medium 起点で検証ループを先に整える、lookup は安いモデルへ、サブエージェントはコンテキストを複製する、/compact は10ターン以上残るときだけ）を評価基準として分類器に渡し、ターンごとのトークン内訳（新規入力・cache read・cache write・出力・thinking・中断時間）から次の判定を返させます。

| costVerdict | 意味 |
|---|---|
| FINE | 問題なし |
| WASTED_TURNS | 本体の不要なリトライや遠回り |
| CACHE_MISSES | キャッシュの書き直しが繰り返されている |
| OUTPUT_HEAVY | thinking や長文出力が支配的 |
| EFFORT_TOO_HIGH / EFFORT_TOO_LOW | 機械的な作業に高 thinking、または検証ループなしで低 effort のまま詰まっている |
| DELEGATE_LOOKUPS | 強いモデルが検索・ログ読みにターンを使っている |
| SUBAGENTS_EXPENSIVE | サブエージェントのコストが見合っていない |
| COMPACT_NOW / CLEAR_NOW | /compact または /clear の頃合い |

`costSuggestion` は「エージェントに言うこと」ではなく「あなたが運転を変えること」（effort、モデル、/compact か /clear、委譲、次の指示の出し方）です。

分類器が有効なときは、ルールが黄・赤になっても即座には通知せず、分類器の判定を待ちます。CONTINUE なら通知せず、見出しに「分類器は継続でよいと判断」と添えて赤は黄に和らげます。CONTINUE 以外ならルールの根拠と分類器の理由を合わせて通知します。分類器を切っている（`--advisor none`）ときはルールだけで通知します。起動直後に古いセッションへ一斉に問い合わせないよう、直近 1 時間に動いたセッションだけを分類器に回します。

呼び出し先は `--advisor pi|claude|none`（既定 `pi`、モデルは `google-vertex/gemini-3.8-flash`。別のモデルは `--advisor-model` で指定）。環境変数 `YORISHIRO_OBSERVER_ADVISOR` と `YORISHIRO_OBSERVER_ADVISOR_MODEL` でも指定できます。`claude -p` は haiku でも1回あたりのコストが pi 経由より2桁高いので、必要なときだけ使ってください。

### Claude Code hook 連携

```bash
./bin/yorishiro-observe install-hooks
```

`~/.claude/settings.json` にバックアップを作ってから SessionStart / Stop / Notification の hook を追加します（登録済みなら何もしません）。

- SessionStart: セッション ID、transcript のパス、Herdr のペイン ID を `~/.local/state/yorishiro/observer/sessions/` に記録
- Stop: transcript を読んで終了時監査（未検証編集、TODO 混入、差分の増大、エラー反復など）を `audits/` に保存し、黄・赤なら macOS 通知
- Notification: Claude Code の通知（権限待ちなど）を macOS 通知へ転送し `notifications/` に記録

hook は常に exit 0 で、エージェントの動作を止めません。pi には外部 hook がないため、pi の終了時監査は追従モードの observer が担います。

セッションログの場所は pi が `~/.pi/agent/sessions/`、Claude Code が `~/.claude/projects/` で、作業ディレクトリのパスか Herdr が持つセッション ID から導出します。エージェントの内部推論は記録されないため、観測できるのは会話、ツール呼び出し、その結果だけです。

## 育て方

1. まず `AGENTS.md` と設定だけで使う
2. 同じ説明や作業を繰り返したら `skills/<name>/SKILL.md` にする
3. 危険操作の禁止や確認、外部サービス連携が必要になったら `extensions/` に実装する
4. 常設コンテキストが増えすぎたら、原則だけを残して Skill へ移す

秘密情報や端末固有の絶対パスは、追跡対象ファイルへ書かないでください。
