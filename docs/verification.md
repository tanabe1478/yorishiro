# 検証Skill

[README](../README.md) / [使い方](./usage.md) / [開発パイプライン](./development-pipeline.md)

project-localの検証手順（verification Skill）を作る・保守する・実行するときのガイドです。workflow全体の中での位置づけは[開発パイプライン](./development-pipeline.md)と[`skills/development-workflow/SKILL.md`](../skills/development-workflow/SKILL.md)にあります。

## 使い分け

| 目的 | 読むもの | 生成・変更先 |
|---|---|---|
| 新しいprojectの検証Skillを作る | [`skills/create-verification-skill/SKILL.md`](../skills/create-verification-skill/SKILL.md) | `.pi/skills/verify-<project>/` |
| 既存の検証Skillを監査・更新する | [`skills/maintain-verification-skill/SKILL.md`](../skills/maintain-verification-skill/SKILL.md) | 同上（既存Skillのみ） |
| Yorishiro自身の起動面を確認する | [`.pi/skills/verify-yorishiro/SKILL.md`](../.pi/skills/verify-yorishiro/SKILL.md) | `.pi/skills/verify-yorishiro/`（repository-local） |

## 生成と配置

project-localの検証手順は`.pi/skills/verify-<project>/`に置けます。`create-verification-skill`は、repositoryをinterviewし、Launch／Doctor／Drive／Evidence／Cleanup／Helpersと4-H2のfeature mapを生成する手順を定義します。生成物は一度、実ユーザー面で1つ以上のfeatureを実行し、cleanup後も証跡が残ることを確認するまでdeliverableと呼びません。`maintain-verification-skill`はsourceとliveの両方で全featureを監査し、doc drift、harness gap、product regressionを区別します。どちらもfile編集は固定DeepSeek Workerへ委譲し、親modelやread-only Reviewerは書きません。

生成された検証ファイルは`.pi/skills/`配下のproject-local資産であり、packageのgeneric `skills/` manifestからは配布されません。

## 証拠として認めるもの

どのprojectでも、次の3点が揃って初めて証拠になります。

- 実際に実行した操作（argvとcwd、または画面での実操作）
- その操作が返した結果（exit code、stdout/stderr、保存値、表示）
- 副作用と、cleanup後に残る証跡

次のいずれかだけでは証拠になりません。

- 読んだだけのcodeやdocs
- 実行していないcommandの推測
- mocked harnessだけの成功
- cleanupで消えたtemp file

Yorishiro自身について何を証拠とみなすかは`.pi/skills/verify-yorishiro/`がsource of truthです。RPC responseの`success`とmodel identity、`get_commands`に現れた登録名、observerのhelp出力など、このrepository固有の確認範囲と一覧は[`.pi/skills/verify-yorishiro/SKILL.md`](../.pi/skills/verify-yorishiro/SKILL.md)を参照してください。証跡は`artifacts/`のようなGit管理外の場所へ保存し、cleanup後も残します。

## Yorishiro自身の検証

Yorishiro自身のdogfood用Skillは`.pi/skills/verify-yorishiro/`にあります。実`bin/yorishiro`のRPC起動、Pi/Jiti extension load、明示`--skill` discovery、observer helpを実行し、証跡を`artifacts/verify-yorishiro/`へ残します。

```bash
node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs doctor --json
node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs drive launcher-rpc
node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs drive workflow-skill
```

`doctor`は`status`が`ok`／`degraded`／`blocked`のいずれかと、各前提の必須・任意を返します。`blocked`ならDriveせず、不足したrequired前提を直します。各Driveは`--json`でmachine-readable resultを出し、featureごとの手順は`.pi/skills/verify-yorishiro/features/`にあります。

## 到達範囲と限界

- このSkillは実際のHerdr+LLM pane起動を検証しません。`npm test`のmocked production-flow testはpipeline制御の証拠ですが、実LLM runの代わりではありません。
- `launcher-rpc`と`extension-load`はmodel APIを呼びません。RPC `get_state`/`get_commands`までです。
- `observer-help`はhelp surfaceだけです。live sessionの監視は検証しません。
- `doctor`の`bwrap`/`herdr`確認はpipelineの前提確認であり、pipeline実行そのものではありません。

これらは「未検証」「間接証拠」として区別して報告してください。成功と主張してよいのは、実行したcommandと観測した出力が揃っている範囲だけです。
