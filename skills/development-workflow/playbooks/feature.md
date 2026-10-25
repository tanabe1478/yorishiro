# Feature playbook

新機能または振る舞いの変更を、名前の付いたdata shapeから組み立てる。親が設計と成功条件を所有し、実装は固定モデルのWorkerへ委譲する。

1. **関連codeを読む。** 変更対象のentry point、呼び出し元、既存のtest、verification Skill/feature mapを読む。対象checkoutの`.pi/skills/verify-*/`があれば、そのLaunch/Doctor/Drive/Evidence/Cleanupに従う。
2. **data shapeを選ぶ。** 状態、入力、出力、永続化、境界をどう表すかを決める。state machine、typed model、registry/table、純粋関数のどれが最小かを選び、散在するbooleanや条件分岐を増やさない。
3. **最小scopeと成功条件を書く。** 変更するpath、変更しないpath、実ユーザー面での観測項目、独立check、既知の制約を列挙する。成功条件はcommandの出力・exit code・画面・保存値で表す。
4. **親で計画を合意する。** `approvedPlan`に設計、scope、成功条件、対象feature journeyを書く。`qualityContract`のplanItemsは検証可能な単位に分け、requiredChecksは実際に走るcommandにする。必要なら人間の計画/差分レビューを使う。
5. **Workerへ委譲する。** Workerはbrief、`development-workflow`、このplaybook、対象verify Skillを読む。承認済みscopeだけを実装し、source、test、必要なfixtureを変更する。親は同じ実装を重複しない。
6. **実ユーザー面で確認する。** Launch/Doctor/Driveで対象機能に到達し、actionと結果状態の両方を証跡にする。副作用（file、DB row、出力、状態遷移）も確認する。compilationだけ、内部setterだけ、test専用endpointだけを証拠にしない。
7. **独立checkとreviewを行う。** 契約のrequiredChecksをsandboxで実行し、Reviewerにactual diff、quality gate、証跡を渡す。Reviewerはread-onlyで、実装を変更しない。
8. **修正は同一Workerで有限回。** blocking findingはsanitized dataだけを同じWorkerへ返す。モデル切替やfallbackをしない。上限到達は`CHANGES_REQUIRED`、再発や設計判断は`NEEDS_PLANNER`で止める。
9. **証跡と限界を報告する。** 実行したcommand、exit code、観測値、証跡path、未実行項目と前提条件を書く。cleanup後も証跡が残ることを確認する。

完了報告には、何を作ったか、何を選ばなかったか、実ユーザー面の証拠、残る制約を含める。commit、push、PR作成は明示指示があるまで行わない。
