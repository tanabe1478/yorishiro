# Bug fix playbook

欠陥を、runtime evidenceに基づいて再現・原因究明・修正する。推測の修正や「効きそう」な追加guardは出荷しない。

1. **実ユーザー面で再現する。** 対象checkoutのverification Skill/feature mapのLaunch/Doctor/Driveを使い、同じsurfaceで再現する。再現できない場合は、triggerを合成する、条件を狭める、instrumentationを追加する、の順で試す。実行できなかった場合はcommandと未達の前提条件を記録する。
2. **mechanismを特定する。** 候補hypothesisを列挙し、最も問題空間を削る観測から順にruntime evidenceで除外する。sourceの流れ、直近の変更、log/instrumentationを読む。原因が確認できるまで修正しない。
3. **失敗証拠を先に残す。** 安価なlocal test pathがあれば、失敗する再現testを先に書く。高価・integration-heavy・不安定な場合は、再現commandと出力、または実ユーザー面の証跡を先に保存する。どの場合も、修正前の失敗と修正後の成功を対応させる。
4. **最小の修正を計画する。** 症状ではなく最初に壊れた場所を直す。boundary guardは、その状態が正当な入力である場合だけ修正として扱う。計画、変更予定path、成功条件を親で合意する。
5. **Workerへ委譲する。** Workerはbrief、`development-workflow`、このplaybook、対象verify Skillを読む。修正と再現testを同じscopeで実装し、関係しないrefactorを混ぜない。
6. **同じsurfaceで再検証する。** 元の再現が通ること、失敗testが通ることを確認する。加えて、隣接する正常系と、修正が触れた境界のtestを実行する。unit testだけでは欠陥の不在を証明しない。
7. **独立checkとread-only reviewを行う。** qualityContractのchecksをsandboxで実行する。Reviewerは再現手順、mechanism、before/after証跡を確認する。証跡が修正後の自己申告だけなら差し戻す。
8. **修正は同一Workerで有限回。** 同じ指摘の再発、covered pathの新規blocking、evidence不一致の再発は`NEEDS_PLANNER`。回数上限は`CHANGES_REQUIRED`。モデル切替・fallbackはしない。
9. **報告する。** 何が壊れていたか、root cause、修正、検証方法を書く。失敗→成功のcommand出力をそのまま貼り、再現できなかったpathは未検証として残す。

commit、push、PR作成は明示指示があるまで行わない。証跡はcleanup後も残す。
