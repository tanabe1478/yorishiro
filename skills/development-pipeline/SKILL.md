---
name: development-pipeline
description: Run the approved development pipeline in stable Herdr worker panes with auditable reports and cleanup safeguards.
---

# 開発パイプライン

親セッションで要件と実装計画を合意した後だけ`development_pipeline`を使う。Plannerは親セッション自身であり、子Plannerは起動しない。親で実装を重複しない。

## 実行条件

- Herdr内の親Piで、`HERDR_PANE_ID`、`HERDR_TAB_ID`、`HERDR_WORKSPACE_ID`、`HERDR_SOCKET_PATH`が使えること。
- 対象リポジトリがread-only検証sandboxを使えること。未対応環境、sandbox未導入、`/tmp`配下の対象は開始前に拒否される。
- 開始時に親以外のペインがある場合は`LAYOUT_OCCUPIED`として停止する。

## 役割

- Planner: 親セッション。要件、計画、Reviewer指摘の採否。
- Worker · DeepSeek: `opencode-go/deepseek-v4.1-flash`（thinking `high`）。実装、test、build、動作確認、修正。
- Reviewer · Sol: `openai/gpt-5.6-sol`（thinking `medium`）。read-only reviewとsandbox検証。

`workflow`は`feature`（既定）、`bug-fix`、`refactoring`。子は`workflow-brief-<stage>.md`、`development-workflow`、対応playbook、`.pi/skills/verify-*/`を明示`--skill`で読むため、親だけがworkflowを知る状態にはならない。通常実行は現在タブを親55%・右45%（Worker上／Reviewer下）へ分割し、修正・再reviewでは同じペインを使う。子は再帰起動できない。

## 手順

1. 親で計画と`qualityContract`を確定する。
2. `development_pipeline`を実行する。固定modelはpane起動前に`pi auth check`とcatalogで確認され、`model-guard.ts`が`tool_call`境界で不一致・不明を拒否する。
3. Workerの`COMPLETED`／`BLOCKED` reportを中央validatorが検査する。契約IDのexact一致、実diff一致、prefix遵守が必須で、report各fieldの仕様は[詳細](../../docs/development-pipeline.md#qualitycontractとreport)だけに置く。
4. requiredChecksをsandbox snapshotで実行する。1件でも失敗すれば`QUALITY_GATE_FAILED`。
5. Reviewer判定（`APPROVED`／`APPROVED_WITH_NOTES`／`CHANGES_REQUESTED`／`NEEDS_PLANNER`）に従い、blocking findingだけをsanitizedでWorkerへ返す。
6. 成功時だけ`cleanupMode`（既定`ask`）で整理する。失敗・中断・`NEEDS_PLANNER`・`CHANGES_REQUIRED`ではペインと証跡を残し、`development_pipeline_reset`で別途resetする。

## 安全境界

- 修正は同一Workerペインで`maxReviewCycles`（既定2、上限3。旧`maxRepairCycles`は互換入力）まで。モデル切替・fallbackはせず、再発や上限到達は`NEEDS_PLANNER`／`CHANGES_REQUIRED`で止める。
- 証跡は`$YORISHIRO_EVIDENCE_DIR`からorchestratorが上限付きで回収する。Reviewerは元checkoutを書き換えられない。
- `planReviewMode`／`diffReviewMode`（`ask`既定）の人間gateを尊重し、commit・pushは行わない。
- model guardは敵対的Workerやnested shellへのsecurity sandboxではない。

## 詳細

正確な状態遷移、既定値、evidence回収上限、監視（`argv0`／`foreground_processes`、`--until`、report-missing猶予）、cleanup/reset互換、旧providerからの移行は、必要なときに[`../../docs/development-pipeline.md`](../../docs/development-pipeline.md)を読む。workflowの進め方は[`../development-workflow/SKILL.md`](../development-workflow/SKILL.md)。全文を常時先読みしない。
