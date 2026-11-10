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
- 対象リポジトリがread-only検証sandboxを利用できること。未対応環境、sandbox未導入環境、`/tmp`配下の対象、`TMPDIR`（`os.tmpdir()`）が対象の中にある場合は作業開始前に拒否されます。macOSでは、`DARWIN_USER_TEMP_DIR`の下の対象と、snapshotの置き場（「sandbox」節）の下または上にある対象も拒否されます。
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

## 複数リポジトリ

互いに依存する複数のgitリポジトリ（API定義、それを実装するbackend、利用するadminなど）を1回のrunで実装・レビューするには、入力に`repositories`を足します。省略すると従来どおり、`cwd`が1つのgitリポジトリです（成果物の形式・パスも変わりません）。

```json
{ "cwd": "/work/neuhaus", "repositories": ["neuhaus-openapi", "neuhaus-backend", "neuhaus-admin"], "task": "...", "approvedPlan": "...", "qualityContract": { "...": "..." } }
```

- 指定: 各要素は`cwd`（省略時は呼出元のcwd）からの相対パスです。絶対パス、`.`、`..`、末尾の`/`、重複、入れ子（片方が他方の中）は開始前にエラーです。各要素はgit作業ツリーのルート（`git rev-parse --show-toplevel`がrealpathで一致する。シンボリックリンク経由は不可）でなければなりません。このときcwdはワークスペースのルートで、cwd自体がgitリポジトリかどうかは問いません。CLI（`yorishiro-pipeline run --input`）も同じJSONを受け取ります。
- パスの書き方: Workerの`changedPaths`と`allowedPathPrefixes`はワークスペース相対です（`neuhaus-backend/src/a.ts`、prefixは`neuhaus-backend/src`）。リポジトリ内の相対path（`src/a.ts`）で書くと、実diffと一致せず`WORKER_EVIDENCE_MISMATCH`になります。差分はリポジトリごとに取り、各pathに`<リポジトリ>/`を前置して1つにまとめて照合します。
- `requiredChecks`の`cwd`（任意）: ワークスペース相対で、`repositories`のいずれか、またはその配下です。そのcheckはその場所で実行します。省略したcheckはワークスペースのルートで実行します。`repositories`が無いのに`cwd`を付けると契約エラーです。`cwd`は契約のSHA-256に含まれ、`quality-contract.json`と`quality-gate-N.json`の各checkに残ります。
- 検証sandbox: 指定したリポジトリだけを、元の相対配置のままsnapshotへ複製します。`../neuhaus-openapi`のような別リポジトリへの参照が解決できます。リポジトリに含まれないワークスペース配下のものは複製しません。書き込みはsnapshot全体に許します。preflight（`/tmp`配下、`TMPDIR`が対象の中、macOSの`DARWIN_USER_TEMP_DIR`の下とsnapshotの置き場の下／上、の拒否）は各リポジトリに対して行います。
- `run_verification_command`の`cwd`引数（任意、ワークスペース相対）: checkと同じ規則です。省略するとワークスペースのルートです。子には`YORISHIRO_TARGET_CWD`（ワークスペースのルート）に加えて、`YORISHIRO_TARGET_REPOSITORIES`（リポジトリのJSON配列）を渡します（Claudeは各stageのMCP設定、PiはReviewerのlauncher）。`repositories`が無いrunで`cwd`を渡すとエラーです。Claudeランタイムでは、Workerのpromptとbriefに、checkの`cwd`をこのtoolの`cwd`へ渡すよう書きます。
- artifact: `run.json`に`repositories`（指定時だけ）を記録します。`diffs/`には、リポジトリごとの`<name>-<リポジトリ名>-<8桁のhash>-status.txt`と`-diff.patch`、まとめた`<name>-fingerprint.json`1つが入ります（`<name>`は`baseline`、`implement-N`、`review-N`）。`workflow-brief-<stage>.md`と、Reviewerのpromptに対象リポジトリの一覧とpathの規則、リポジトリごとのsnapshotファイルを書きます。
- verify Skillの探索、workspace trustの確認、diffaiの実行は、リポジトリごとに行います。diffaiはリポジトリの順に`--cwd <リポジトリ>`で実行し、最初に承認されなかったリポジトリで止めます（`ask`の確認は1回だけです）。

制約と未確認の点:

- `repositories`に含まれないワークスペース配下への書き込みは検出しません（実diffにもsnapshotにも入りません）。
- workspace trustはリポジトリごとに警告を出しますが、Claude Codeが実際にサブディレクトリのリポジトリで信頼ダイアログを出すかは未観測です。
- 複数のリポジトリが同名のverify Skillを持つ場合の読み込みは未確認です。
- 検証sandboxのツールごとのキャッシュの付け替えは、JVM向け（`GRADLE_USER_HOME`など）だけです。詳細は「sandbox」節を参照してください。

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

### 段階の時間の上限

1段階（WorkerまたはReviewerの1ペイン）の上限は、入力の`stageTimeoutMs`（整数、60000以上14400000以下。CLIも同じJSONを渡す）で指定します。範囲外・整数でない値は、artifactもペインも作る前のエラーです。上限を過ぎると、その段階は`stage deadline expired`で失敗します。

採用する値は、入力の`stageTimeoutMs`、環境変数`YORISHIRO_STAGE_TIMEOUT_MS`、既定の5400000（90分）の順に決まります。環境変数は後方互換のために残してあり、範囲の制限はありません（正の数であること。そうでなければ開始前のエラー）。採用した値と出どころは`run.json`の`stageTimeout`（`{ "ms": 5400000, "source": "input" | "env" | "default" }`）に残ります。

段階の上限は、Workerが報告前に実行する`requiredChecks`の実行時間と、Workerの作業時間の合計より長くしてください。1チェックの上限（1800000、30分）と同じ値にすると、長いチェックを1回走らせただけで段階の上限を使い切ります。既定を30分から90分に延ばしたのはこのためです。JVMのビルドのように1回30分近くかかるチェックを複数回走らせる場合は、`stageTimeoutMs`を明示して延ばします。

### Workerの権限（Claudeランタイムのみ）

入力の`workerPermissionMode`は`"default"`（既定）か`"bypass"`です。`"bypass"`のときだけ、ClaudeランタイムのWorker（implement段階）が`--permission-mode dontAsk`の代わりに`--dangerously-skip-permissions`で起動します。それ以外の値と、Piランタイムでの`"bypass"`は、artifactもペインも作る前のエラーです。採用した値は`run.json`の`workerPermission`（`{ "mode": "default", "flag": "--permission-mode dontAsk" }`または`{ "mode": "bypass", "flag": "--dangerously-skip-permissions" }`）に残ります。Piランタイムでは記録しません。

用途は、Workerが`.claude/skills/`など保護された場所（`.claude/`、`.git/`）へEdit/Writeで書く必要があるときだけです。claude 2.1.322で、dontAskに`--allowedTools Write`、`Write(.claude/skills/**)`、`Edit(.claude/skills/**)`（相対・絶対）を足しても、`--permission-mode acceptEdits`でも拒否され、`--dangerously-skip-permissions`だけが書けました。詳細は[Claude Codeで使う](claude-code.md#worker-の権限workerpermissionmode)。

危険は、保護された場所へfile toolで直接書けることです。`.claude/settings.json`のhooksや`.git/`を書き換えられます。対象リポジトリの外は`allowedPathPrefixes`の照合の対象外で、これはBashと同じです。Reviewerは`workerPermissionMode`に関係なく、常に`--restricted`とdontAskの読み取り専用です。

## sandbox

Reviewerとquality gateの検証コマンドは、対象checkoutをcopy-on-write優先で使い捨てsnapshotへ複製し、そのsnapshotだけを書き込み可能にしたmacOSの`sandbox-exec`またはLinuxのbubblewrap/user namespace内で実行します。ビルド成果物やテストfixtureはsnapshotへ書けますが、元checkoutへの書き込みはkernelで拒否されます。

検証コマンドの環境は、orchestratorの環境から`YORISHIRO_`で始まる変数（`YORISHIRO_ROOT`、`YORISHIRO_RUNTIME`、`YORISHIRO_ROLE`など）と`HERDR_`で始まる変数を取り除き、snapshot内を指す`TMPDIR`／`TMP`／`TEMP`、`npm_config_cache`、`XDG_CACHE_HOME`、`YORISHIRO_EVIDENCE_DIR`を設定したものです。`YORISHIRO_ROOT`を継承すると、snapshot内で動くpipelineが元checkoutの`artifacts/`へ書こうとしてsandboxに拒否されます。環境は`verifier-tools.ts`の`verificationEnvironment()`が組み立てます。

JVM系のツール（Gradle、Kotlinコンパイラ、Mockitoのinline mock maker）が動くように、検証コマンドには次の既定も与えます（`verifier-tools.ts`）。JVM以外のツールには広げません。

- `JAVA_TOOL_OPTIONS`: 呼び出し元の値を残したまま`-Djava.io.tmpdir=<snapshotの一時ディレクトリ>`を追記します。JVMは`picked up JAVA_TOOL_OPTIONS`をstderrに出します。
- `GRADLE_USER_HOME`: snapshot内の`.yorishiro-cache/gradle`にします（元の`~/.gradle`には書けないため）。
- `GRADLE_RO_DEP_CACHE`: 元のGradleホーム（呼び出し元の`GRADLE_USER_HOME`、なければ`~/.gradle`）に`caches`があれば、そのパスを設定し、依存を読み取り専用で参照させます。呼び出し元が設定済みならそれを優先します。
- 元のGradleホームの`gradle.properties`は、snapshot作成時に権限600でsnapshot内の`GRADLE_USER_HOME`へ複製します（JDKの場所などの端末設定を引き継ぐため）。中身は出力にもログにも出さず、snapshotと一緒に消えます。

macOSでは、`getconf DARWIN_USER_TEMP_DIR`のrealpath（`/private/var/folders/.../T`）への書き込みもsandboxで許します。HotSpotはattach用のソケットを、Kotlinコンパイラは`kotlin-compiler-in-*.alive`をここへ作り、場所を変えられません。取得できない場合は許可を足しません（エラーにはしません）。このディレクトリには検証コマンドが作ったファイルが残ることがあり、同時に走る別のコマンドからも書けます。

macOSのsnapshotは、`os.tmpdir()`（既定で`DARWIN_USER_TEMP_DIR`と同じ場所）ではなく、Yorishiro専用の`~/Library/Caches/yorishiro/verification/`（なければ作成。権限700）の下に`mkdtemp`で作ります。sandboxが書き込みを許すのは、そのコマンド自身のsnapshotと`DARWIN_USER_TEMP_DIR`だけなので、同時に走っている別のsnapshot（`.yorishiro-evidence`を含む）には書けません。snapshotは従来どおり検証の終了時に消します。異常終了（プロセスの強制終了、電源断など）で残ったsnapshotは自動では掃除しません。`~/Library/Caches/yorishiro/verification/`の古い`yorishiro-verification-*`を手で消してください。

macOSのpreflightは、対象が`DARWIN_USER_TEMP_DIR`のrealpathの下にある場合（`TMPDIR`が別の場所でも）、snapshotの置き場の下にある場合、snapshotの置き場を含む場合（例: `~/Library/Caches`、ホーム）に拒否します。最後のものは、対象のコピーが自分のsnapshotを再帰して含むのを避けるためです。Linuxのsandboxとsnapshotの置き場（`os.tmpdir()`）は変えていません。

Dockerソケット経由の書き込み（コンテナのボリュームなど）は止めていません。sandboxが制限するのは検証コマンド自身のファイル書き込みで、Dockerデーモンが代わりに行う書き込みには及びません。

1チェックの`timeoutMs`（`requiredChecks`、`run_verification_command`）の上限は1800000（30分）です。`requiredChecks`の既定は120000、`run_verification_command`の既定も120000のままです。Claude Codeはstdio MCPのtool呼び出しが30分無応答だと打ち切る（`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`の既定。バイナリから読み取った値で、公式文書では未確認）ため、Claudeランタイムのlauncherはこれを3600000にしてから起動します。

Claude Codeは、MCPのtool呼び出しが120秒を超えると呼び出しをバックグラウンドへ移し、`still running after 120s. It was moved to the background as task ...`と返します。子（WorkerとReviewer）には完了を待つ手段がないため、`npm run test:gate`やGradleのように2分を超える検証コマンドの結果を受け取れません。この閾値はclaude 2.1.322のバイナリから読み取った環境変数`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`で決まり（公式文書では未確認）、`0`なら自動ではバックグラウンドへ移しません。Claudeランタイムのlauncherはこれを`0`にしてから起動します。Piランタイムの子は変わりません。

snapshotは書き込みを閉じたsandboxの中なので、検証コマンドからさらにsandboxを起動する（macOSでは`sandbox-exec`の入れ子、つまりpipelineや`runSandboxedVerification`を呼ぶテスト）ことはできません。Yorishiro自身を対象にするrunの`requiredChecks`は`npm run test:gate`にし、入れ子になるスイートは`test/gate-exclusions.json`の理由付き一覧に載せ、Workerがsandboxの外で`npm test`を実行して確かめます。

Claude Codeランタイムでは、Workerにも`run_verification_command`を渡します（Reviewerと同じ実装、同じsnapshotとsandbox条件、同じ出力上限）。Workerは報告前に、契約の`requiredChecks`をこのtoolで実行してexit 0を確かめます。本番のquality gateと同じ条件で動くので、APFS cloneや`sandbox-exec`で検証用の複製や環境を手作りする必要はありません（手作りの複製は、削除の権限拒否で巨大な複製が残る、sandbox条件の取り違えでgate失敗に気づけない、という問題を起こしました）。Workerの元checkoutは書き込み可能なままで、toolが実行するのはsnapshotの上だけです。このtoolの証跡は`evidence/worker-verification/`に回収されます（Reviewerは`evidence/reviewer/`）。この指示はWorkerのpromptとbrief（`## Workerの道具と証跡`）に入っています。Piランタイムの子は変わりません。

## 証跡回収

検証の証跡を残す場合は、コマンドがsnapshot内の`$YORISHIRO_EVIDENCE_DIR`へfileを書きます。orchestratorはteardown前に、通常fileだけを上限付き（file数100、1file 1MiB、合計8MiB、深さ4、visited entry数1000）でrun artifactの`evidence/`へ回収します。snapshotに元からある`.yorishiro-evidence`は毎回削除して空から開始します。evidence rootや子のsymlink、special file、destination外へ出るpath、上限超過は拒否・skipし、`skippedCount`と`truncated`で可視化します。Reviewerの`run_verification_command`も同じ仕組みを使い、modelが任意のwrite先を指定することはできません。

Claude Codeランタイムでは、Workerにも`YORISHIRO_EVIDENCE_DIR`（`artifacts/<repository>/<run-id>/evidence/worker/`）を設定し、スクリーンショットや観測JSONを直接artifactへ書けるようにします（子は`--add-dir`でartifactを書けます）。ペインを再利用するためattemptごとに変数は変えられないので、promptは`attempt-<n>/`の下に置くよう指示します。Workerの書き込みは回収（コピー）を挟まないため、orchestratorは各Worker stageの終了後にこのディレクトリの目録（file数、合計byte、skipしたpath）を`run.json`の`workerEvidence`へ記録します。上限はReviewerの回収と同じ値（file数100、1file 1MiB、合計8MiB、深さ4、visited entry数1000）で、超過分・symlink・special fileは目録でskip扱い（`truncated`）にするだけで、ファイル自体は消しません。Workerの証跡がscratchpadにしか残らず、Reviewerが「artifactに回収されていない」と指摘する問題への対処です。

## 2回目以降の指示の送信（Claude Codeランタイム）

修正・再レビューでは同じペインへ指示を送ります。長い複数行を`herdr pane send-text`で貼ると、Claude Codeが`[Pasted text #N +M lines]`に畳み、続く`send-keys enter`が取りこぼされて、指示が入力欄に未送信のまま残りました（子はidleのままで、orchestratorは`REPORT_MISSING`→`REVIEW_FAILED`としていました）。原因が貼り付けとEnterの競合かは、使い捨てペインでの観測ができておらず未確認です。次のように送ります。

1. 指示全文を`<stage>-prompt-<attempt>.md`としてartifactへ書き、ペインには「次のファイルを最後まで読み、その指示に従ってください: <path>」の1行だけを`send-text`で送る。初回の指示（launcherの引数）は変わりません。
2. `send-text`の300ms後に`send-keys enter`を押し、Herdrのagent statusが`working`などのactive、または`blocked`（権限・信頼ダイアログは送信後にしか出ません）になる、またはdurable reportが現れるのを5秒待つ（250ms間隔で確認）。
3. 変わらなければEnterだけを再送する（2回まで、つまりEnterは最大3回）。指示文は再送しない。
4. それでも変わらなければ、`REPORT_MISSING`ではなく結果`PROMPT_NOT_SUBMITTED`で止める。理由とペインIDは`run.json`の`promptFailures`、`stages.<stage>.attempts[].error`、CLIのmessageに残り、ペインは保持します（停止処理として`ctrl+c`と`escape`を送りますが、入力欄の未送信の文が消えるかは未確認です）。`PROMPT_NOT_SUBMITTED`で止まったrunも、他の非SUCCESS終端outcomeと同じ`development_pipeline_reset`（`yorishiro-pipeline reset --run <artifactDir> --confirm`）の対象で、terminal_idによるpane同一性、idle、親ペイン保護の確認を通ったペインだけを閉じます。送信の経過は成功時も`promptDeliveries`（Enterを押した回数、最後のstatus、経過時間）に残ります。

`<stage>-prompt-<attempt>.md`は初回の`<stage>-prompt.md`と同様にlauncher扱いで、成功後のcleanupで消えます。Piランタイムの送信は変わりません。

## 監視とprocess identity

監視はHerdrの特定status名だけに依存せず、exact Pi identityとdurable reportを完了根拠にします。exact Pi identityは`argv0 === "pi"`と、Herdr 0.9の`foreground_processes[].argv[0] === "pi"`を受理し、pathや引数、`cmdline`/`name`だけの一致は拒否します。監視のagent待機には`--until`を使います。

durable reportがないままexact Piが`idle`／`done`／`completed`になった場合は、activeを観測済みなら直ちに、起動直後からquiescentならstartup grace後に有限のreport-missing猶予を開始し、期限でfail closedします。猶予中にreportが現れれば通常settleし、activeへ戻ればtimerを解除します。未知・undefined statusだけでは欠落と断定しません。report-missing時はterminal transcript、heartbeat、`run.json`へ診断を残し、ペインを保持します。terminal transcriptはagent readが終了済みagentで失敗した場合に`pane read --raw`へfallbackし、ペインが残っている限り診断を保存します。監視中のheartbeatは`run.json`へ継続記録します。

Claude Codeランタイムでは、Workerが`Bash`の`run_in_background`で長いコマンドを流して待つと、Herdrは`idle`と報告します。Bashツールのシェルは`claude`プロセスの直接の子で、コマンドラインに`.claude/shell-snapshots/`を含みますが、Herdrの`foreground_processes`には現れません。監視は各pollで`ps`を使い、`claude`のPID（`process-info`のargv[0]が`claude`のもの）の子にこのシェルがある間はreport-missing猶予を開始せず（activeを観測した扱い）、進捗に「バックグラウンドのシェルが N 個実行中」と出します。シェルが無くなってから通常の猶予を数えます。stage全体の期限は変わらず効きます。Piランタイムの挙動は変わりません。Worker／Reviewerのpromptにも「バックグラウンドジョブの完了待ちでターンを終えない」を入れています。

Claude Codeは初めて開くディレクトリで信頼ダイアログを出し、子ペインはHerdr status `blocked`のまま人間の応答を待ちます（claude 2.1.316で、`--setting-sources project`と`--permission-mode dontAsk`でも出ることを確認）。Claudeランタイムは開始前に、Claude Codeの状態ファイル（`~/.claude.json`、`CLAUDE_CONFIG_DIR`があればその下）の`projects[<dir>].hasTrustDialogAccepted`を読み、未信頼ならstderrに警告します。見るdirは、対象cwdがgitリポジトリ内ならgitルート（最も近い`.git`の親）だけで、親ディレクトリには遡りません。gitでなければcwdと親ディレクトリです。信頼済みリポジトリの下にある独立したgitリポジトリは親の信頼を引き継がず、ダイアログが出ます（claude 2.1.316で、非gitの親・同一リポジトリのサブディレクトリ・独立したネストgitリポジトリの3ケースを使い捨てペインで観測）。この状態ファイルは公開された仕様ではないため、読めない・形が違う場合は判定せず警告も出しません。信頼は自動では付与しません。`blocked`中の進捗は「ペインのダイアログ（ワークスペース信頼、権限確認など）に応答してください」と出ます。

中断時は`ctrl+c`と`escape`で停止を試み、証跡とペインを残します。

## artifact

成果物は`artifacts/<repository>/<run-id>/`に保存されます。主な内容は依頼、承認済み計画、stage別workflow brief、2回目以降の指示`<stage>-prompt-<attempt>.md`（Claudeランタイム）、Workerが直接置く`evidence/worker/`（Claudeランタイム）、`quality-contract.json`、`plan-review.json`、`diff-review.json`、各attemptの構造化report、quality gate結果と`evidence/`、report-missing時のterminal transcript診断、baselineと各Worker stageのstatus/diff/fingerprint、`model-guard.log`、`run.json`です。baseline fingerprintとの差分で既存dirty pathの内容変更、untracked・deleted・renameも検出します。

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
