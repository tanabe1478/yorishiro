---
name: verify-yorishiro
description: Dogfood verification for the Yorishiro repository itself. Use when proving that the real launcher, Pi extension load, project Skill discovery, or observer help surface still works after a change.
license: MIT
---

# verify-yorishiro

Yorishiro自身のuser-facing entry pointを、実processで確認するためのproject-local Skillです。このSkillは`.pi/skills/`配下のローカル資産で、Yorishiro packageのgeneric `skills/` manifestからは配布されません。

## Launch

短命のCLI/RPC検証なので、常駐serverはありません。各Driveが自分でprocessを起動し、終了を待ちます。事前準備は依存関係の確認だけです。

```bash
node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs doctor
```

`doctor`はNode 22.19以上、`pi`、`bin/yorishiro`、このSkillをrequiredとして確認し、`/usr/bin/bwrap`、`herdr`、`bin/yorishiro-observe`、development-pipeline extensionをoptionalとして確認します。requiredが欠ければ`blocked`（exit 2）、optionalだけが欠ければ`degraded`（exit 0）です。結果は`artifacts/verify-yorishiro/<run-id>/`へ保存します。

## Doctor

```bash
node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs doctor --json
```

`status`は`ok`、`degraded`、`blocked`のいずれかです。`checks[].required`で必須か任意かが分かります。`blocked`ならDriveせず、不足したrequired前提を直します。optionalの不足はfeatureごとの前提を確認してから進めます。

## Drive

```bash
node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs drive launcher-rpc
node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs drive extension-load
node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs drive skill-discovery
node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs drive workflow-skill
node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs drive observer-help
```

各Driveは`--json`でmachine-readable resultを出します。featureごとの具体的なactionと観測点は`features/`を読んでください。`launcher-rpc`は実際の`bin/yorishiro`をRPC modeで起動し、`get_state`のmodel identityまで確認します。`extension-load`はPi/Jitiによるextension初期化、`skill-discovery`と`workflow-skill`は`--no-skills`下での明示`--skill`ロードを確認します。

## Evidence

`artifacts/verify-yorishiro/<run-id>-<feature>/`へ`command.json`、`stdout.txt`、`stderr.txt`、`summary.json`を保存します。`summary.json`にはargv、exit、signal、checks、限界（help surfaceのみ等）が入ります。`artifacts/`はGit管理外で、cleanup後も残ります。

証拠として認めるもの:

- 実行したargvとcwd
- 実際のexit code
- RPC responseの`success`とmodel identity
- `get_commands`に現れた`skill:verify-yorishiro`／`skill:development-workflow`
- observerのhelp出力

認めないもの:

- 読んだだけのcodeやdocs
- 実行していないcommandの推測
- mocked harnessだけの成功
- cleanupで消えたtemp file

## Cleanup

```bash
node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs cleanup --run artifacts/verify-yorishiro/<run-id>-<feature>
```

helperは同期spawnしたprocessの終了を待つため、常駐processを残しません。cleanupはevidence rootとrun directoryをcanonical pathで照合し、symlink ancestorでroot外へ出るrun、symlinkのrun directory、symlinkの`summary.json`、symlinkの`.scratch`を拒否します。run directory内の`.scratch`だけを削除し、evidence（`summary.json`等）は削除しません。

## Helpers

- `scripts/verify-yorishiro.mjs` — `doctor`、`drive <feature>`、`cleanup --run <dir>`。実行可能で、本文のcommandがそのまま動きます。
- `features/README.md` — baseline preconditions、driving convention、proof/skip reporting、feature index。
- `features/*.md` — 各featureの4-H2 journey。

## 限界

- このSkillは実際のHerdr+LLM pane起動を検証しません。`npm test`のmocked production-flow testはpipeline制御の証拠ですが、実LLM runの代わりではありません。
- `launcher-rpc`と`extension-load`はmodel APIを呼びません。RPC `get_state`/`get_commands`までです。
- `observer-help`はhelp surfaceだけです。live sessionの監視は検証しません。
- `doctor`の`bwrap`/`herdr`確認はpipelineの前提確認であり、pipeline実行そのものではありません。
