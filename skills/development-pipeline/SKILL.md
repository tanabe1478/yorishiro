---
name: development-pipeline
description: Run the approved development pipeline in stable Herdr worker panes with auditable reports and cleanup safeguards. Works from Pi (development_pipeline tool) and from Claude Code (yorishiro-pipeline CLI with Claude Code children).
---

# 開発パイプライン

親セッションで要件と実装計画を合意した後だけ`development_pipeline`を使う。Claude Codeの親からは、下の「Claude Codeから使う」の手順でCLIを呼ぶ。Plannerは親セッション自身であり、子Plannerは起動しない。親で実装を重複しない。

## 実行条件

- Herdr内の親（PiまたはClaude Code）で、`HERDR_PANE_ID`、`HERDR_TAB_ID`、`HERDR_WORKSPACE_ID`、`HERDR_SOCKET_PATH`が使えること。
- 対象リポジトリがread-only検証sandboxを使えること。未対応環境、sandbox未導入、`/tmp`配下の対象は開始前に拒否される。
- 開始時に親以外のペインがある場合は`LAYOUT_OCCUPIED`として停止する。

## 役割

- Planner: 親セッション。要件、計画、Reviewer指摘の採否。
- Worker · DeepSeek: `opencode-go/deepseek-v4.1-flash`（thinking `high`）。実装、test、build、動作確認、修正。
- Reviewer · Sol: `openai/gpt-5.6-sol`（thinking `medium`）。read-only reviewとsandbox検証。
- Claude Codeでは Worker · Claude（既定`claude-sonnet-5-5`、effort `high`）と Reviewer · Claude（既定`claude-opus-5-5`、effort `medium`）。役割は同じ。

`workflow`は`feature`（既定）、`bug-fix`、`refactoring`。子は`workflow-brief-<stage>.md`、`development-workflow`、対応playbook、`.pi/skills/verify-*/`を明示`--skill`で読むため、親だけがworkflowを知る状態にはならない。通常実行は現在タブを親55%・右45%（Worker上／Reviewer下）へ分割し、修正・再reviewでは同じペインを使う。子は再帰起動できない。

## 手順

1. 親で計画と`qualityContract`を確定する。
2. `development_pipeline`を実行する。piでは固定modelをpane起動前に`pi auth check`とcatalogで確認し、`model-guard.ts`が`tool_call`境界で不一致・不明を拒否する。Claude Codeでは`claude auth status`でログインを確認し、子を`--model`で固定して起動する（model guardはない）。
3. Workerの`COMPLETED`／`BLOCKED` reportを中央validatorが検査する。契約IDのexact一致、実diff一致、prefix遵守が必須で、report各fieldの仕様は[詳細](../../docs/development-pipeline.md#qualitycontractとreport)だけに置く。
4. requiredChecksをsandbox snapshotで実行する。1件でも失敗すれば`QUALITY_GATE_FAILED`。1チェックの`timeoutMs`は最大1800000（30分）。JVM（Gradle、Kotlin、Mockito）向けの環境の既定は[詳細](../../docs/development-pipeline.md#sandbox)。
5. Reviewer判定（`APPROVED`／`APPROVED_WITH_NOTES`／`CHANGES_REQUESTED`／`NEEDS_PLANNER`）に従い、blocking findingだけをsanitizedでWorkerへ返す。
6. 成功時だけ`cleanupMode`（既定`ask`）で整理する。失敗・中断・`NEEDS_PLANNER`・`CHANGES_REQUIRED`ではペインと証跡を残し、`development_pipeline_reset`で別途resetする。

## 複数リポジトリ

互いに依存する複数のgitリポジトリを1回で扱うときは、入力に`repositories`（`cwd`からの相対パスの配列。各要素がgitルート）を足す。このとき`changedPaths`、`allowedPathPrefixes`、`requiredChecks`の任意の`cwd`は、すべてワークスペース相対（`backend/src/a.ts`）で書く。省略すれば従来どおり。指定方法とsandboxの扱いは[詳細](../../docs/development-pipeline.md#複数リポジトリ)。

## 安全境界

- 1段階の時間の上限は入力の`stageTimeoutMs`（60000〜14400000、既定5400000）。requiredChecksの実行時間とWorkerの作業時間の合計より長くする。[詳細](../../docs/development-pipeline.md#段階の時間の上限)
- 修正は同一Workerペインで`maxReviewCycles`（既定2、上限3。旧`maxRepairCycles`は互換入力）まで。モデル切替・fallbackはせず、再発や上限到達は`NEEDS_PLANNER`／`CHANGES_REQUIRED`で止める。
- 証跡は`$YORISHIRO_EVIDENCE_DIR`からorchestratorが上限付きで回収する。Reviewerは元checkoutを書き換えられない。
- Claude CodeのWorkerにも`run_verification_command`（Reviewerと同じsnapshotとsandbox）と`YORISHIRO_EVIDENCE_DIR`（artifactの`evidence/worker/`、直接書く。目録は`run.json`の`workerEvidence`）を渡す。Workerは報告前にrequiredChecksをこのtoolで確かめ、検証用の複製やsandboxを手作りしない。
- Claude Codeで修正・再reviewの指示を同じペインへ送るときは、全文を`<stage>-prompt-<attempt>.md`へ書き、ペインには短い1行だけ送る。子が作業を始めたかを確認し、変わらなければEnterを2回まで再送する。それでも始まらなければ`PROMPT_NOT_SUBMITTED`で止まる（`REPORT_MISSING`とは別。ペインIDは`run.json`の`promptFailures`とCLIのmessage）。
- `planReviewMode`／`diffReviewMode`（`ask`既定）の人間gateを尊重し、commit・pushは行わない。
- model guardは敵対的Workerやnested shellへのsecurity sandboxではない。

## Claude Codeから使う

Herdr内のClaude Codeから、`"$YORISHIRO_ROOT/bin/yorishiro-pipeline"`をBashのバックグラウンド実行で呼ぶ。`YORISHIRO_ROOT`は`bin/yorishiro-claude`で起動すると設定される。

1. 入力JSON（`development_pipeline`と同じ`task`、`approvedPlan`、`qualityContract`、`workflow`、`cwd`など）をscratchファイルへ書く。
2. `"$YORISHIRO_ROOT/bin/yorishiro-pipeline" run --input <file>`を実行する。モデルは`--worker-model`／`--reviewer-model`か、環境変数`YORISHIRO_CLAUDE_WORKER_MODEL`／`YORISHIRO_CLAUDE_REVIEWER_MODEL`で変えられる。
3. 終了を待ち、stdoutのJSON（`outcome`、`artifactDir`）を読む。exit codeは0=`SUCCESS`、3=それ以外の結果、2=入力・前提の誤り。進捗はstderr。
4. 成功後の整理は`yorishiro-pipeline cleanup --run <artifactDir>`、失敗・中断runは`yorishiro-pipeline reset --run <artifactDir> --confirm`。

CLIには人間レビューのUIがない。計画の承認は会話で取り、`planReviewMode`／`diffReviewMode`に`required`を指定しない（指定すると開始前にexit 2で止まる）。`cleanupMode`の`ask`は確認できないためペインを残す。

## 失敗したrunの立て直し

reset（閉じなければ`herdr pane close`）→ `git stash push -u`で成果を退避 → 原因を直す → 新runの計画の先頭に`git stash pop`と経緯を書く → 成功後に`git stash list`と`git status`を確認。`reset`は作業ツリーを戻さない。詳細は[docs](../../docs/development-pipeline.md#失敗したrunの立て直し)。

## 詳細

正確な状態遷移、既定値、evidence回収上限、2回目以降の指示の送信と確認、監視（`argv0`／`foreground_processes`、`--until`、report-missing猶予）、cleanup/reset互換、旧providerからの移行は、必要なときに[`../../docs/development-pipeline.md`](../../docs/development-pipeline.md)を読む。workflowの進め方は[`../development-workflow/SKILL.md`](../development-workflow/SKILL.md)。全文を常時先読みしない。
