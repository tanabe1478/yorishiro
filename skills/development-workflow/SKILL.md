---
name: development-workflow
description: Rigorous feature, bug-fix, and refactoring workflow adapted from pstack. Use when planning or delegating non-trivial development work, or when a pinned development-pipeline Worker needs the implementation playbook and verification rules.
license: MIT
---

# Development workflow

pstack の考え方（関連codeの理解 → domain/data shape の選択 → 最小scopeと成功条件 → 計画合意 → 実装委譲 → 実ユーザー面の検証 → 独立checkとread-only review → 同一モデルでの修正 → 証跡と限界の報告）を、Yorishiro の安全境界に合わせて移植したものです。上流の Cursor 専用API、自動PR/commit/push、常時全スキルのロード、無制限のagent fleet は含みません。

## Playbook の選択

| 作業 | playbook |
|---|---|
| 新機能・振る舞いの変更 | `playbooks/feature.md` |
| 欠陥の再現・原因究明・修正 | `playbooks/bug-fix.md` |
| 振る舞いを変えない構造変更 | `playbooks/refactoring.md` |

`development_pipeline` では `workflow` に `feature`、`bug-fix`、`refactoring` のいずれかを渡します。親は計画を合意し、子は指定された playbook を読んでから作業します。

## 共通の進め方

1. **理解する。** 変更対象のcode、呼び出し元、test、既存のharnessを読む。推測でfile名やcommandを作らない。
2. **domain/data shape を選ぶ。** 状態機械、typed model、table/registry、境界のどれで表すかを実装前に決める。条件分岐の散在を増やさない。
3. **最小の安全なscopeと成功条件を決める。** 何を変えないか、どの実ユーザー面で何を観測すれば成功かを先に書く。成功条件はcompilationや自己申告ではなく、command・出力・終了code・画面・保存値で表す。
4. **親で計画を合意する。** 計画、変更予定path、独立check、対象のverification Skill/feature mapを`approvedPlan`と`qualityContract`へ入れる。人間レビューが必要なら既存の`planReviewMode`/`diffReviewMode`を使う。
5. **子へ実装を委譲する。** 親は実装を重複しない。子は固定モデル（`opencode-go/deepseek-v4.1-flash`）で、明示的に渡されたこのSkill、playbook、対象checkoutのverify Skill/feature mapを読む。
6. **実ユーザー面で検証する。** 対象のlaunch/doctor/drive/evidence/cleanup手順を使う。UIなら実操作、CLIなら実command、APIなら実request、libraryなら実呼び出し。mockはproduction境界が既に外部系を隔離している箇所だけ。
7. **独立checkとread-only reviewを行う。** qualityContractのrequiredChecksをsandboxで実行し、Reviewerはsourceを変更せずdiffと証跡を確認する。
8. **同一モデルで有限回修正する。** blocking findingとquality evidence違反は、同じWorkerペインへの有限回のrepairだけを許可する。モデルの切替・fallback・無限loopはしない。上限到達や同一signature再発は`NEEDS_PLANNER`/`CHANGES_REQUIRED`で止め、理由をartifactへ残す。
9. **証跡と限界を報告する。** 実行したcommand、exit code、観測した出力、証跡path、実行できなかった項目とその前提条件を書く。cleanup後も証跡が残ることを確認する。

## 子セッション（Worker / Reviewer）

`development_pipeline` の子はskill自動探索が無効です。親がartifactへ書く`workflow-brief-<stage>.md`と、launcherが明示的に渡す`--skill` pathを読みます。

- 最初にbrief、このSKILL.md、指定playbook、対象checkoutの`.pi/skills/verify-*/SKILL.md`と`features/README.md`を読む。
- briefにないpathや存在しないcommandを捏造しない。
- **Worker:** 対象checkoutの承認済みpathを編集してよい。commit、push、PR作成、merge、外部messageは行わない。run artifactはorchestrator所有であり、指定されたreport以外を書き換えない。秘密情報を保存しない。他者のsessionやペインへ介入しない。
- **Reviewer:** sourceと対象checkoutを編集しない。検証は`run_verification_command`などでdisposable snapshot内だけを書き込み可能にし、元checkoutを変更しない。永続writeは`submit_stage_report`とorchestratorが回収する`YORISHIRO_EVIDENCE_DIR`に限る。commit、push、PR作成、merge、外部messageは行わない。
- 検証commandの証跡は`YORISHIRO_EVIDENCE_DIR`（snapshot内）へ書き、orchestratorがartifactへ回収する。cleanupで消えるtempへ置いたままにしない。
- 固定モデルと異なるモデルが選択された場合、model guardがtool実行を拒否する。モデルを切り替えず、親Plannerへ戻る。

## 品質と安全の境界

- 既存のqualityContract、sandbox、人間gate、repair上限、cleanup/resetの保護を維持する。
- 「compilationが通った」「testを書いた」だけでは実ユーザー面の証拠にならない。
- 未検証、間接証拠、mockのみ、stand-in環境はそのまま区別して報告する。
- model guardは意図的に敵対的なWorker、改変されたPi、任意のnested shellに対するsecurity sandboxではない。Piのtool実行境界を守るだけである。

## 帰属

このworkflowとplaybookは pstack（`cursor/plugins` revision `99b609a72323b70204eab407c622f436e858e112`、MIT、Copyright (c) 2026 Lauren Tan）の feature / bug fix / refactoring の考え方を基に、Yorishiro向けに再構成したものです。全文のMIT licenseは`../../docs/licenses/pstack-MIT.txt`にあります。
