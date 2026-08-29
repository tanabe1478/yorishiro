---
name: development-pipeline
description: Run the approved development pipeline in stable Herdr worker panes with auditable reports and cleanup safeguards.
---

# 開発パイプライン

親セッションで要件と実装計画を合意した後だけ`development_pipeline`を使う。Plannerは親セッション自身であり、子Plannerは起動しない。親で実装を重複しない。

## 実行条件

親PiがHerdr内で動作し、`HERDR_PANE_ID`、`HERDR_TAB_ID`、`HERDR_WORKSPACE_ID`、`HERDR_SOCKET_PATH`が利用できること。対象リポジトリはread-only検証sandboxを利用できる必要がある。未対応環境や`/tmp`配下の対象は開始前に拒否される。

## 役割とペイン

- Planner: 親セッション。要件、計画、Reviewer指摘の採否を判断する。
- Worker · Luna: `openai-codex/gpt-5.6-luna`、既定thinking `high`。実装、テスト、ビルド、動作確認、修正を行う。
- Reviewer · Sol: `openai-codex/gpt-5.6-sol`、既定thinking `medium`。read-onlyレビューとsandbox検証を行う。

親55%、右45%とし、右列をWorker上／Reviewer下へ分割する。子は可視の通常Pi TUIであり、修正・再レビューでは同じペインを再利用する。子はYorishiroのSkillとExtensionを自動ロードせず、再帰起動できない。

## 報告と判定

WorkerとReviewerは`submit_stage_report`で構造化JSONを提出する。中央validatorを通過しない報告は失敗として扱う。

Reviewer判定:

- `APPROVED`: 成功
- `APPROVED_WITH_NOTES`: noteを残して成功
- `CHANGES_REQUESTED`: blocking findingだけをWorkerへ渡す
- `NEEDS_PLANNER`: 自動処理を止め、親Plannerへ戻す

Workerへはsanitized findingだけを渡し、Reviewerのsummary、note、生出力、transcriptを渡さない。同じ指摘IDが続いた場合や、修正後に`discovery: initial`の新規blockingが追加された場合は`NEEDS_PLANNER`で止める。`repair_regression`と、理由を明示した`previously_missed`は新規指摘として許可する。

`maxReviewCycles`は既定2、上限3。旧`maxRepairCycles`は互換入力であり、両方指定時は`maxReviewCycles`を優先する。上限到達時は`CHANGES_REQUIRED`で終了する。

## 証跡と安全性

`artifacts/<repository>/<run-id>/`へ依頼、承認済み計画、各attemptのreport、terminal記録、baseline／stage別status・diff、`run.json`を保存する。開始時のdirty treeはbaselineとして残すが、変更の帰属は完全には判定できない。

起動、process-info、timeout、中断、欠落・不正reportはfail closedで扱う。中断時は`ctrl+c`と`escape`で停止を試み、証跡とペインを残す。Reviewerのコマンドはread-only sandbox内だけで実行する。

## cleanup

成功時だけ`cleanupMode`を適用する。

- `ask`（既定）: UI確認後に閉じる
- `on-success`: 成功時に閉じる
- `never`: 残す

失敗、中断、`NEEDS_PLANNER`、`CHANGES_REQUIRED`では自動cleanupしない。成功用cleanupとは別の`development_pipeline_reset`を、canonical runDir・記録済みpane identity・workspace/tab・親保護・idle確認・明示confirmを満たす場合だけ使える。開始時に親以外のペインがある場合は`LAYOUT_OCCUPIED`として対象pane IDを記録して安全停止し、他人のペインを自動削除しない。後から`development_pipeline_cleanup`を使える。新構成はReviewer→Worker、旧構成はReview→Verify→Implementの順で処理し、親、非idle、別runのペインを保護する。

## 人間レビュー

`planReviewMode`と`diffReviewMode`は`ask`（既定）、`required`、`skip`から選びます。計画レビューは子ペイン起動前、差分レビューはReviewer完了後かつcleanup前にforegroundで実行されます。結果と計画SHA-256は`plan-review.json`／`diff-review.json`へ保存されます。`required`の拒否・利用不可・timeout・中断は安全側で停止し、差分の変更要求は`HUMAN_CHANGES_REQUESTED`になります。commit・pushは自動実行しません。
