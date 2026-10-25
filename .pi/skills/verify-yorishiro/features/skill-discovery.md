# Skill discovery

`--no-skills`で自動探索を止めた状態でも、明示`--skill <path>`がproject-local Skillを登録することを確認する。pipelineの子セッションがverify Skillとworkflow Skillを読める前提の検証。

## Sub-features

- `verify-skill-register` `.pi/skills/verify-yorishiro`が`skill:verify-yorishiro`として登録される。
- `workflow-skill-register` `skills/development-workflow`が`skill:development-workflow`として登録される。
- `explicit-skill-only` `--no-skills`と明示`--skill`の組み合わせで登録される。
- `get-commands-integrity` RPC `get_commands`のresponseにskill名とdescriptionが現れる。

## How to get to it (user POV)

- Piを`--no-skills --skill <dir>`で起動する。
- RPC `get_commands`で利用可能なskill commandを列挙する。

## Driving it with verify-yorishiro

Preconditions:

- `.pi/skills/verify-yorishiro/SKILL.md`と`skills/development-workflow/SKILL.md`が存在する。
- `pi`が`PATH`または`YORISHIRO_PI_BIN`で解決できる。

- **Verify Skill.** 実行: `node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs drive skill-discovery --json`。`skill registered`がokになり、`summary.json`のstdoutに`skill:verify-yorishiro`が残る。
- **Workflow Skill.** 実行: `node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs drive workflow-skill --json`。`skill registered`がokになり、`skill:development-workflow`が残る。
- **Confirm explicit flag.** `command.json`のargvに`--no-skills`と`--skill <dir>`の両方が残る。
- **Proof.** `artifacts/verify-yorishiro/<run-id>-skill-discovery/`と`<run-id>-workflow-skill/`の`summary.json`を保存する。

## Gotchas

- `--no-skills`だけではproject Skillは登録されない。明示`--skill`が必要。
- skill directoryの`SKILL.md`にfrontmatterとdescriptionが無いと登録されない。
- 同名skillが先にloadされていると最初のものが残る。user global skillとの衝突を避けるため`--no-extensions --no-skills`を使う。
- `get_commands`のdata形状はPi versionで変わる可能性がある。helperは`data.commands`を読み、無ければ失敗する。
