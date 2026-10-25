# Observer help

`bin/yorishiro-observe --help`がuserにusageを返し、exit 0で終わることを確認する。observerのlive監視や通知はこのfeatureの対象外。

## Sub-features

- `observer-help-exit` help commandがexit 0で終わる。
- `observer-help-usage` help textにusage/observer名が含まれる。
- `observer-no-session` helpだけを実行し、session logやagentへ介入しない。

## How to get to it (user POV)

- repository rootから`./bin/yorishiro-observe --help`を実行する。
- 表示されたusageから、追随・serve・hookのentry pointを確認する。

## Driving it with verify-yorishiro

Preconditions:

- repository rootにいる。
- `bin/yorishiro-observe`が実行可能である。
- `doctor`の`observer` checkがokである。

- **Run doctor.** 実行: `node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs doctor --json`。`observer`がokになる。
- **Drive help.** 実行: `node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs drive observer-help --json`。`exit`と`usage`がokになる。
- **Confirm no live session.** `command.json`のargvが`bin/yorishiro-observe --help`だけで、session fileやpane IDを渡していないことを確認する。
- **Proof.** `artifacts/verify-yorishiro/<run-id>-observer-help/summary.json`と`stdout.txt`を保存する。`summary.json`の`limitation`がhelp surfaceのみと示す。

## Gotchas

- このfeatureはhelp surfaceのみで、live sessionの追従、分類器、通知、hook登録を検証しない。
- `serve`や`install-hooks`は外部状態を変更するため、このrecipeでは実行しない。
- help出力の文言は変更されうる。exit codeとusageの存在を主な観測点にし、特定の文面全体を固定しない。
- 実session logを読む検証が必要なら、別featureとして隔離fixtureとowned processで追加する。
