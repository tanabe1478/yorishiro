# Yorishiro verification map

Yorishiro自身のuser-facing entry pointを、実processで確認するためのfeature mapです。最初にこのindexを読み、対象のfeature fileをrecipeとして使ってください。

## Baseline preconditions

- repository rootで実行する（`bin/yorishiro`、`.pi/skills/verify-yorishiro/`、`extensions/development-pipeline/`が存在する）。
- Node 22.19以上。
- `pi`が`PATH`にあるか、`YORISHIRO_PI_BIN`で実体を指定する。
- 検証用の`PI_OFFLINE=1`をhelperが設定する。model APIは呼ばない。
- 証跡先は`artifacts/verify-yorishiro/`（Git管理外）。`YORISHIRO_VERIFY_EVIDENCE_ROOT`で上書きできる。
- 実Herdr pane、実LLM、`development_pipeline`のlive runはこのmapの対象外。

## Driving conventions

- 各recipeは`node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs`の実commandで駆動する。
- `doctor`を先に実行し、欠けた前提を確認する。
- commandはliteralに扱い、flagやpathを変えない。
- 一つのDriveは一回のprocess起動で完結させる。常駐processを残さない。
- `--json`はmachine-readable確認に使う。人間向けにはsummaryを使う。
- 失敗したiterationも`cleanup --run`を実行し、`.scratch`だけを片付ける。証跡は消さない。

## Proof and skip reporting

- proofはargv、cwd、exit code、stdout/stderr、RPC response、`get_commands`の登録名で示す。
- 読んだだけのcode、未実行command、推測、cleanupで消えたtempはproofにしない。
- mocked testはpipeline制御の証拠だが、実user surfaceの証拠として数えない。
- 到達できない場合は、試したcommandと未達の前提条件を`summary.json`に残す。
- help surfaceだけの検証は、その限界を明記する。

## Feature entry contract

各feature fileはH1の後に、この順序で4つのH2だけを使う。

1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it with verify-yorishiro`
4. `Gotchas`

## Features

- [Launcher RPC](./launcher-rpc.md) — 実際の`bin/yorishiro`をRPC modeで起動し、Pi model identityまで確認する。
- [Extension load](./extension-load.md) — Pi/Jitiが`extensions/development-pipeline/index.ts`を実loadすることを確認する。
- [Skill discovery](./skill-discovery.md) — `--no-skills`下の明示`--skill`でverify Skillとworkflow Skillが登録されることを確認する。
- [Observer help](./observer-help.md) — `bin/yorishiro-observe --help`のuser surfaceを確認する（helpのみ）。
