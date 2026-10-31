# 開発パイプライン

[README](../README.md) / [使い方](./usage.md) / [observer](./observer.md) / [検証Skill](./verification.md)

親Piで要件と実装計画を合意した作業を、Herdrの可視ペインに固定モデルで委譲する`development_pipeline`の詳細リファレンスです。日常の依頼から結果までの流れは[使い方](./usage.md)、実行時の短い入口は[`skills/development-pipeline/SKILL.md`](../skills/development-pipeline/SKILL.md)にあります。この文書は、役割・契約・状態遷移・監視・cleanupの正確な仕様や既定値が必要なときに読みます。

## 役割と固定モデル

| 役割 | 固定モデル | 担当 |
|---|---|---|
| Planner（親） | 親セッションのモデル | 要件、計画、Reviewer指摘の採否 |
| Worker · DeepSeek | `opencode-go/deepseek-v4.1-flash`（既定thinking: `high`） | 実装、テスト、ビルド、動作確認、修正 |
| Reviewer · Sol | `openai/gpt-5.6-sol`（既定thinking: `medium`） | read-onlyレビュー、sandbox内の独立検証 |

Plannerは親セッション自身であり、子Plannerは起動しません。親は実装を重複しません。

Claude CodeとClaudeのモデルだけで動かす場合の役割・既定モデル・違いは[Claude Codeで使う](./claude-code.md)にあります。

### 旧providerからの移行

旧`openai-codex/gpt-5.6-luna`と`openai-codex/gpt-5.6-sol`はこのPi環境のcatalogに存在しません。Reviewerは同じSol modelを提供するcanonical provider `openai`へ移行しました。親のモデルは変更しません。

固定modelは起動前に`pi auth check --model ... --json --no-refresh`と`pi --offline --list-models`でcatalog存在とprovider readinessを確認します（credentialは保存・表示しません）。子launcherは`--model`で固定し、`model-guard.ts`が`tool_call`境界でactive modelの不一致・不明を拒否します。偶発的なmodel選択・cycle・restoreによるedit/bash/reportを止めるためのguardであり、敵対的Workerやnested shellに対するsecurity sandboxではありません。

## 前提

- 親PiがHerdr内で動作し、`HERDR_PANE_ID`、`HERDR_TAB_ID`、`HERDR_WORKSPACE_ID`、`HERDR_SOCKET_PATH`が利用できること。
- 対象リポジトリがread-only検証sandboxを利用できること。未対応環境、sandbox未導入環境、`/tmp`配下の対象、`TMPDIR`（`os.tmpdir()`）が対象の中にある場合は作業開始前に拒否されます。
- 開始時に現在タブへ親以外のペインがある場合、`LAYOUT_OCCUPIED`として停止し、他人のペインを自動削除しません。

## レイアウト

通常実行では別タブを作らず、呼出元の現在タブを親55%、右45%のWorker／Reviewer上下2段へ分割します。子は通常のPi TUIとして表示され、修正と再レビューでは同じペインを再利用します。子は`--no-skills --no-extensions`で起動し、workflow Skill・verify Skill・reporter・model guardだけを明示的に受け取るため、YorishiroのSkillとExtensionを自動ロードしません。子からパイプラインを再帰起動することはできません。修正版Extensionを新規ロードする使い捨てE2Eだけは隔離タブを使用し、確認後にタブ全体を削除します。

## workflowとbrief

`development_pipeline`の`workflow`には`feature`（既定）、`bug-fix`、`refactoring`を指定します。親は`skills/development-workflow/SKILL.md`と対応playbookに沿って計画し、子にはartifact内のstage別`workflow-brief-<stage>.md`、workflow Skill、playbook、対象checkoutの`.pi/skills/verify-*/`（feature mapを含む）を明示`--skill`で渡します。子は`--no-skills`でもこれらのpathを直接読むため、親だけがworkflowを知る状態にはなりません。verify Skillが無いcheckoutでは、実ユーザー面の既存harnessを優先します。

task／approvedPlanに書かれた絶対path（`/`始まり、`~/`始まり）が、子の読める範囲（対象checkout、artifact、渡すskill）の外にある通常ファイルなら、開始前に`artifacts/<repository>/<run-id>/inputs/`へコピーし、briefに「元パス → コピー先」の表を書きます。計画本文は書き換えません。1ファイル2MiB、合計10MiBまで。シンボリックリンクは解決後の実体をコピーします。ディレクトリ、デバイス、システムのパス、秘密情報らしいパス（`.ssh`、`.aws`、`.env`、`*.pem`、名前に`key`／`secret`／`token`を含むもの等）、上限超過はコピーせず、理由をbriefと`run.json`の`inputFiles`に残します。存在しないpathは入力ファイルとして扱いません。

## qualityContractとreport

WorkerとReviewerは`submit_stage_report`で中央validatorが検証する構造化JSONを提出します。`development_pipeline`には必須の`qualityContract`（非空でIDが一意な`planItems`／`requiredChecks`、任意の`allowedPathPrefixes`）を渡します。契約はSHA-256とともに`quality-contract.json`／`run.json`へ保存されます。reportのfield構成はexactで、これ以外のfieldは受け付けません。

| field | 仕様 |
|---|---|
| `verdict` | `COMPLETED` または `BLOCKED` |
| `summary`／`changedScope`／`evidence` | 日本語で非空。`evidence`には実行したcheckと未達成の前提も書く |
| `completedPlanItems` | `{ id, evidence }`だけ。`id`はcontract ID、`evidence`は日本語で観測結果を書く |
| `changedPaths` | repository-relativeで一意なpath（baseline以降の実diffとexact一致） |

- `COMPLETED`は、契約の全項目を一度ずつ（各1回、欠落・重複・unknown不可）示す日本語の`completedPlanItems`、`changedPaths`の実diff exact一致、`allowedPathPrefixes`遵守、独立checks成功が必須です。
- `BLOCKED`は完了済みcontract IDのsubset（unknown／duplicate不可）とactual `changedPaths` exact一致、prefix遵守を必須とし、独立checksとReviewerを起動せず`IMPLEMENTATION_BLOCKED`で終わります。
- BLOCKEDでも虚偽ID／path／prefix違反は許さず、`WORKER_EVIDENCE_MISMATCH`として停止します。

## 状態遷移と有限repair

Quality evidence不一致の初回だけ、Reviewerを起動せず同じWorkerペインへsanitized finding（ログ・絶対path・Reviewer出力を含まず、リポジトリ相対の違反pathだけを上限付きで含む）を送り、quality repairを1回行います。signatureは違反種別とcontract item/check IDで安定化します。findingには、prefix違反のpath（`outsidePaths`）と、changedPathsが実diffと食い違うpath（`missingPaths`＝報告漏れ、`unknownPaths`＝実diffに無い報告）を、リポジトリ相対pathのまま各50件まで含めます（超過は`omitted`に件数）。ログや絶対pathは含めません。違反pathがprefixの文字列前方一致になっている場合（`tsconfig`と`tsconfig.json`）は、「prefixはパス区切り単位で照合します。`tsconfig.json`を許可するなら`'tsconfig.json'`を明示してください」という提案（`prefixHints`）を足します。提案はfinding、`quality-gate-N.json`、`run.json`、`NEEDS_PLANNER`／`WORKER_EVIDENCE_MISMATCH`の結果messageに出ます。同じsignatureが再発した場合は、同一Workerの有限repairを使い切ったものとして`NEEDS_PLANNER`で停止し、モデル切替・fallbackは行わず、停止理由を`quality-planner-stop.json`と`run.json`へ残します。異なる2回目の違反は`WORKER_EVIDENCE_MISMATCH`で停止し、loopしません。

COMPLETEDのReviewer開始前にはrequiredChecksをshellを介さず対象checkoutの使い捨てsnapshot上で順次実行し、失敗・timeout・cancelは`QUALITY_GATE_FAILED`として停止します。各checkは出力SHA-256と診断抜粋をartifactと失敗結果へ残します。抜粋（`outputExcerpt`）は、出力が4KiB以下ならそのまま、超えるなら先頭1KiBと末尾3KiBの間に`[... 中略 ...]`を挟んだものです（UTF-8の境界は崩しません）。出力の先頭64KiBと末尾64KiBは`quality-gate-N-output/<check別の名前>.log`（`evidence/`とは別の場所、`outputLog`に`artifacts`内の相対pathを記録）に保存し、64KiBを超えて間を省いた場合は、ログ内に1行その旨を入れます。失敗したcheckのsummaryの「主な出力」は、末尾側から、スタックフレーム（`at ...`で始まる行）と`npm error`／`npm ERR!`の行を除いた上で、`Error`で終わる名前から始まる最後の行（`AssertionError [ERR_ASSERTION]: ...`、`Error: ...`）、無ければ`Error`／`AssertionError`／`assert`／`FAIL`／`failed`／`not ok`を含む最後の行、それも無ければ最後の非空行を出します（除いた結果が空なら除く前の行から選びます）（成功したcheckは先頭の非空行）。末尾はstdoutとstderrを届いた順に並べたもので、2本のpipe間の順序は厳密ではありません。結果は`quality-gate-N.json`へ保存し、修正attemptごとに再実行します。validator通過したCOMPLETED event、当該attemptのquality gate eventとartifactが揃わない限り`SUCCESS`にはなりません。

Reviewerの判定は次の4つです。

- `APPROVED`: 成功
- `APPROVED_WITH_NOTES`: noteを残して成功
- `CHANGES_REQUESTED`: blocking findingだけをWorkerへ渡し、修正させる
- `NEEDS_PLANNER`: 自動処理を止め、親Plannerへ戻す

Workerへ戻す情報はsanitized blocking findingだけに制限し、Reviewerのsummary、note、生出力、transcriptを渡しません。同じ指摘IDの再発や、修正後に`discovery: initial`の新規blockingが追加された場合は`NEEDS_PLANNER`で止まります。`repair_regression`と、理由を明示した`previously_missed`は新規指摘として許可します。

修正回数は`maxReviewCycles`で指定でき、既定2、上限3です。旧`maxRepairCycles`も互換入力として受理し、両方指定時は`maxReviewCycles`を優先します。上限到達時は`CHANGES_REQUIRED`で終了します。欠落・不正レポート、プロセス失敗、timeout、中断は安全側で停止し、失敗・中断・Planner判断待ちでは子ペインを残します。

## sandbox

Reviewerとquality gateの検証コマンドは、対象checkoutをcopy-on-write優先で使い捨てsnapshotへ複製し、そのsnapshotだけを書き込み可能にしたmacOSの`sandbox-exec`またはLinuxのbubblewrap/user namespace内で実行します。ビルド成果物やテストfixtureはsnapshotへ書けますが、元checkoutへの書き込みはkernelで拒否されます。

検証コマンドの環境は、orchestratorの環境から`YORISHIRO_`で始まる変数（`YORISHIRO_ROOT`、`YORISHIRO_RUNTIME`、`YORISHIRO_ROLE`など）と`HERDR_`で始まる変数を取り除き、snapshot内を指す`TMPDIR`／`TMP`／`TEMP`、`npm_config_cache`、`XDG_CACHE_HOME`、`YORISHIRO_EVIDENCE_DIR`を設定したものです。`YORISHIRO_ROOT`を継承すると、snapshot内で動くpipelineが元checkoutの`artifacts/`へ書こうとしてsandboxに拒否されます。環境は`verifier-tools.ts`の`verificationEnvironment()`が組み立てます。

snapshotは書き込みを閉じたsandboxの中なので、検証コマンドからさらにsandboxを起動する（macOSでは`sandbox-exec`の入れ子、つまりpipelineや`runSandboxedVerification`を呼ぶテスト）ことはできません。Yorishiro自身を対象にするrunの`requiredChecks`は`npm run test:gate`にし、入れ子になるスイートは`test/gate-exclusions.json`の理由付き一覧に載せ、Workerがsandboxの外で`npm test`を実行して確かめます。

## 証跡回収

検証の証跡を残す場合は、コマンドがsnapshot内の`$YORISHIRO_EVIDENCE_DIR`へfileを書きます。orchestratorはteardown前に、通常fileだけを上限付き（file数100、1file 1MiB、合計8MiB、深さ4、visited entry数1000）でrun artifactの`evidence/`へ回収します。snapshotに元からある`.yorishiro-evidence`は毎回削除して空から開始します。evidence rootや子のsymlink、special file、destination外へ出るpath、上限超過は拒否・skipし、`skippedCount`と`truncated`で可視化します。Reviewerの`run_verification_command`も同じ仕組みを使い、modelが任意のwrite先を指定することはできません。

## 監視とprocess identity

監視はHerdrの特定status名だけに依存せず、exact Pi identityとdurable reportを完了根拠にします。exact Pi identityは`argv0 === "pi"`と、Herdr 0.9の`foreground_processes[].argv[0] === "pi"`を受理し、pathや引数、`cmdline`/`name`だけの一致は拒否します。監視のagent待機には`--until`を使います。

durable reportがないままexact Piが`idle`／`done`／`completed`になった場合は、activeを観測済みなら直ちに、起動直後からquiescentならstartup grace後に有限のreport-missing猶予を開始し、期限でfail closedします。猶予中にreportが現れれば通常settleし、activeへ戻ればtimerを解除します。未知・undefined statusだけでは欠落と断定しません。report-missing時はterminal transcript、heartbeat、`run.json`へ診断を残し、ペインを保持します。terminal transcriptはagent readが終了済みagentで失敗した場合に`pane read --raw`へfallbackし、ペインが残っている限り診断を保存します。監視中のheartbeatは`run.json`へ継続記録します。

Claude Codeランタイムでは、Workerが`Bash`の`run_in_background`で長いコマンドを流して待つと、Herdrは`idle`と報告します。Bashツールのシェルは`claude`プロセスの直接の子で、コマンドラインに`.claude/shell-snapshots/`を含みますが、Herdrの`foreground_processes`には現れません。監視は各pollで`ps`を使い、`claude`のPID（`process-info`のargv[0]が`claude`のもの）の子にこのシェルがある間はreport-missing猶予を開始せず（activeを観測した扱い）、進捗に「バックグラウンドのシェルが N 個実行中」と出します。シェルが無くなってから通常の猶予を数えます。stage全体の期限は変わらず効きます。Piランタイムの挙動は変わりません。Worker／Reviewerのpromptにも「バックグラウンドジョブの完了待ちでターンを終えない」を入れています。

Claude Codeは初めて開くディレクトリで信頼ダイアログを出し、子ペインはHerdr status `blocked`のまま人間の応答を待ちます（claude 2.1.316で、`--setting-sources project`と`--permission-mode dontAsk`でも出ることを確認）。Claudeランタイムは開始前に、Claude Codeの状態ファイル（`~/.claude.json`、`CLAUDE_CONFIG_DIR`があればその下）の`projects[<dir>].hasTrustDialogAccepted`を読み、未信頼ならstderrに警告します。見るdirは、対象cwdがgitリポジトリ内ならgitルート（最も近い`.git`の親）だけで、親ディレクトリには遡りません。gitでなければcwdと親ディレクトリです。信頼済みリポジトリの下にある独立したgitリポジトリは親の信頼を引き継がず、ダイアログが出ます（claude 2.1.316で、非gitの親・同一リポジトリのサブディレクトリ・独立したネストgitリポジトリの3ケースを使い捨てペインで観測）。この状態ファイルは公開された仕様ではないため、読めない・形が違う場合は判定せず警告も出しません。信頼は自動では付与しません。`blocked`中の進捗は「ペインのダイアログ（ワークスペース信頼、権限確認など）に応答してください」と出ます。

中断時は`ctrl+c`と`escape`で停止を試み、証跡とペインを残します。

## artifact

成果物は`artifacts/<repository>/<run-id>/`に保存されます。主な内容は依頼、承認済み計画、stage別workflow brief、`quality-contract.json`、`plan-review.json`、`diff-review.json`、各attemptの構造化report、quality gate結果と`evidence/`、report-missing時のterminal transcript診断、baselineと各Worker stageのstatus/diff/fingerprint、`model-guard.log`、`run.json`です。baseline fingerprintとの差分で既存dirty pathの内容変更、untracked・deleted・renameも検出します。

## cleanupとreset

成功時の整理は`cleanupMode`で制御します。

- `ask`（既定）: UIで確認する
- `on-success`: 成功時だけ整理する
- `never`: ペインを残す

後から`development_pipeline_cleanup`へrunディレクトリを渡して整理できます。失敗・中断runは成功用cleanupと分離された`development_pipeline_reset`で、canonical runDirと現在のworkspace/tab、明示confirm、記録済みpane identity、idle状態を検証してから安全にresetします。現行構成は`Reviewer · Sol`→`Worker · DeepSeek`、旧2役構成は`Reviewer · Sol`→`Worker · Luna`、旧3役構成は`Review · Sol`→`Verify · Terra`→`Implement · Luna`として認識します。複数世代のroleが混在するrunはmode ambiguityとして閉じません。親ペイン、非idleペイン、別runのペインは保護されます。

pane同一性は、pane作成時に`run.json`の`panes[].terminalId`へ記録したHerdrの`terminal_id`（不変）とworkspace/tabで確認します。Herdrのpane名（`label`）は`pane rename`をした後にだけ返り、pipelineは子がsettleした後にしか名前を付けないため、settle前に失敗したrun（`REPORT_MISSING`、timeout）のペインには名前がありません。以前はこれが原因で`pane identity changed or incomplete`のままresetがskipされました（端末タイトルのOSC更新ではpane名は変わらないことを確認）。表示名が記録と違うことは結果の`note`に残すだけで、閉じる判断には使いません。`terminalId`の無い古い`run.json`は従来どおり名前の一致を要求するため、名前の無いペインは閉じません（`herdr pane close`で手動で閉じます）。

失敗、中断、`NEEDS_PLANNER`、`CHANGES_REQUIRED`では自動cleanupしません。

## 失敗したrunの立て直し

`development_pipeline`が`NEEDS_PLANNER`、`WORKER_EVIDENCE_MISMATCH`、`IMPLEMENTATION_FAILED`等で終わり、作業ツリーに成果が残っている場合の手順です。コード化はしていません。`reset`は子ペインを閉じるだけで、作業ツリーは戻しません。

1. `yorishiro-pipeline reset --run <artifactDir> --confirm`（Piでは`development_pipeline_reset`）でペインを閉じる。結果に`skipped`が残ったら、そのペインが自分のrunのものか`herdr pane get`で確認し、`herdr pane close <pane_id>`で手動で閉じる。
2. 成果物を退避する。`git stash push -u -m "<run-id> 失敗runの成果"`。`-u`で未追跡も含める。
3. 旧`.gitignore`の差などで、以前は未追跡として見えたが今は無視される生成物があれば、別の場所へコピーして退避する（`git stash -u`は無視されたファイルを含まない）。
4. 失敗の原因を直す（`allowedPathPrefixes`の書き損じ、読めない入力ファイル等）。
5. 新しいrunの計画の先頭に、「先に`git stash pop`で前回の成果を戻す。経緯は次のとおり」と、退避したstashの名前、失敗の理由、退避した生成物の場所を書く。Workerは作業ツリーのbaselineをそのrunの開始時点で取るため、`stash pop`は計画の指示としてWorkerが行い、changedPathsに含めて報告させる。
6. 成功後に、`git stash list`で退避が残っていないこと、`git status`で想定外の差分が無いことを確認する。

## 人間レビューgate

人間レビューは`planReviewMode`と`diffReviewMode`で制御します（`ask`既定、`required`、`skip`）。計画レビューは子ペイン起動前、差分レビューはReviewer完了後かつcleanup前に実行し、結果と計画SHA-256をrun artifactへ保存します。変更要求や必須レビューの失敗では安全側で停止し、`required`の拒否・利用不可・timeout・中断も停止、差分の変更要求は`HUMAN_CHANGES_REQUESTED`になります。commit・pushは自動実行しません。
