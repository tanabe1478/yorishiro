# Refactoring playbook

構造・名前・配置を変え、ユーザーから観測できる振る舞いを変えない。振る舞いの変更が必要になったらFeatureまたはBug fixへ切り替える。

1. **振る舞いの基準を固定する。** 変更前に対象の実ユーザー面をLaunch/Doctor/Driveで動かし、入力、出力、exit code、画面、保存値、logのうち比較する項目を決める。既存testだけで足りない場合は、基準となる証跡を先に保存する。
2. **関連codeと境界を読む。** 対象の呼び出し元、公開API、型、永続化、test、verification Skill/feature mapを読む。変更してよいpathと、触らない外部契約を列挙する。
3. **最小の構造変更を計画する。** rename、extract、inline、move、dedupeのどれか一つを単位にする。機能追加、挙動修正、不要な抽象化を混ぜない。移行が必要ならcallerの移行と旧APIの削除を同じ計画に入れる。
4. **親で計画を合意する。** `approvedPlan`に変更前の基準、変更後の構造、振る舞い不変の確認方法を書く。qualityContractのrequiredChecksには、既存のtestに加えて実ユーザー面の比較を含める。
5. **Workerへ委譲する。** Workerはbrief、`development-workflow`、このplaybook、対象verify Skillを読む。scope外の整形やrenameを広げない。
6. **振る舞いの保存を証明する。** 変更前後で同じ入力・手順を使い、比較対象が一致することを示す。test suiteの成功だけでなく、実ユーザー面の出力、exit code、保存値、必要な画面状態を比較する。差分が意図した構造変更だけであることをactual diffで確認する。
7. **独立checkとread-only reviewを行う。** 契約のchecksをsandboxで実行し、Reviewerはactual diff、before/after証跡、公開契約の不変性を確認する。Reviewerはsourceを変更しない。
8. **修正は同一Workerで有限回。** 振る舞いの差分が見つかった場合はbug fixとして扱い、原因を確認してから直す。指摘再発・evidence不一致は`NEEDS_PLANNER`、上限は`CHANGES_REQUIRED`。モデル切替・fallbackはしない。
9. **報告する。** 何をどう構造化したか、振る舞い不変をどう証明したか、比較できなかった項目を書く。変更前後のcommand出力と証跡pathを示す。

commit、push、PR作成は明示指示があるまで行わない。cleanup後も証跡を残す。
