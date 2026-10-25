---
name: maintain-verification-skill
description: Keep a project-local verification Skill and feature map honest. Use when the app changed, a verify Skill may have drifted, or a periodic source-and-live audit of mapped feature journeys is needed.
license: MIT
---

# Maintain a verification Skill

生成済みのproject-local verification Skill（通常`.pi/skills/verify-<project>/`）を、sourceとliveの両方から監査する保守loopです。単位はfeatureであり、全文の校正ではありません。product codeは変更しません。

## 実行主体（必須）

監査で見つけた修正（SKILL.md、features/、Skill所有のhelper）は、固定モデル`opencode-go/deepseek-v4.1-flash`のWorkerへ委譲して編集します。親modelやread-only reviewerが自分でfileを書きません。`development_pipeline`の`workflow: "refactoring"`または`"feature"`を使い、編集可能pathをverify Skill directoryだけに限定し、product codeを変更しない契約にします。

read-only並行reviewerはsourceを読み、live driveの結果を確認するだけで、fileを編集しません。固定Workerを起動できない場合は、修正を適用せず**blocked**として報告します。

## 最初にtargetを特定する

launch/drive/evidence/cleanupのsectionとfeature mapを持つSkillを探します。候補が複数ならどれを保守するか確認し、無ければ`create-verification-skill`を案内して終了します。存在しないtargetをでっち上げない。

## outcomeを一つ選ぶ

- **clean** — 全featureをsourceとliveで確認し、出荷すべき差分なし。branch/PRなし。
- **changed** — 実証済みのdoc/harness/map修正を一つの変更としてまとめる（自動PRはしない）。
- **blocked** — coverageを完了できない、または実証済み修正を安全に出せない。blockerを具体的に書く。

部分coverage、到達不能、未実行は、cleanとして報告しない。

## 編集scope

編集してよいのはverification Skill自身のdirectory（SKILL.md、features/、そのSkillが所有するharness script/helper）だけです。product codeを変更しません。appがmapの記述と違う場合、次のどれかを判定します。

- **doc drift** — mapのuser POV/command/selectorが古い。mapを直す。
- **harness gap** — 振る舞いは正しいがharnessでdriveできない。Skill所有のhelperを直す。
- **product regression** — appが壊れている。product gapとして報告し、mapを弱めて隠さない。このrunではproduct codeを直さない。

## 対象Skillの契約

保守対象の`SKILL.md`が`Launch`、`Doctor`、`Drive`、`Evidence`、`Cleanup`、`Helpers`を持ち、各feature fileが`Sub-features`、`How to get to it (user POV)`、`Driving it with <harness>`、`Gotchas`の順の4-H2であることを確認します。欠落や順序違いはdoc driftとして扱います。

## pass

0. **Index hygiene.** `features/README.md`とsibling fileを照合し、missing/extra/duplicate/dead entryを直す。
1. **Source wave.** 各featureについてsourceをread-onlyで読み、「このuser-facing featureはどう動くか」、疑わしいdoc driftとcitation、live検証のrecipeを1つ得る。childやreviewerはappをdriveせず、fileを編集しない。read-only並行reviewerだけを使い、書き込みは固定モデルのWorkerへ集約する。
2. **Reconcile.** 全featureにsource結果があることを確認する。重複recipeを実用的な数へ統合する。citationのあるdriftだけspot-checkし、clean主張を再証明しない。直近の変更からmapに無いuser-facing surfaceを探す場合は、具体的なsource pathを必須にする。
3. **Live pass.** sourceがcleanでも必須。Skill自身のLaunch modelに従い、server/UIは一つの長命instanceを直列で、短命CLIはdriveごとにisolated sessionで実行する。全featureを最低一度driveする。次の3つを全passで守る。
   - 直前に驚く挙動をしたinstanceをdoctorせずdriveしない。失敗後はdoctorし、doctorで見えないwedgeはknown stateへ戻すかrelaunchする。
   - capture済みEvidenceがcleanup後も指定場所に残ることを確認する。仮定しない。
   - driveが起動したprocess/port/scratchを、失敗iterationでも片付ける。共有instanceの場合はinstanceではなくresidueだけを片付ける。
   doctor失敗がSkill driftなら、scope内で直して一度だけretryし、invalidになったものだけ再起動する。それでも駄目ならblocked。featureが到達不能な場合は、`verified-unreachable`と、試したroute・具体的な前提条件（auth、entitlement、OS、外部state）を書く。mapに前提が無いならそれもdrift。
4. **Triage.** user POVの誤り/欠落はdoc drift、driveできない正しい振る舞いはharness gap、壊れたappはproduct gap。harness修正はliveで再driveしてから出す。最終teardownはrun最後のdrive（再証明を含む）の後に行う。
5. **Ship or stop.** changedなら変更fileを再読し、実証済み修正だけを一つのreviewable changeにする。clean/blockedはPRを作らず、coverageとoutcomeを正直に報告する。

run notes（対象feature、到達不能の前提、確認したdrift、outcome）はscratchへ短く残し、commitしない。commit/push/PRは明示指示があるまで行わない。

## 帰属

pstackの`maintain-verification-skill`（`cursor/plugins` revision `99b609a72323b70204eab407c622f436e858e112`、MIT、Copyright (c) 2026 Lauren Tan）をPi向けに再構成したものです。MIT全文は`../../docs/licenses/pstack-MIT.txt`。
