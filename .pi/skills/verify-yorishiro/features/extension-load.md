# Extension load

Pi/Jitiが`extensions/development-pipeline/index.ts`を実際に初期化し、RPC sessionが応答することを確認する。TypeScript extensionの構文・import・登録が壊れていないことの実load証拠。

## Sub-features

- `extension-file-load` PiがJiti経由でTypeScript extensionをloadする。
- `extension-tool-register` development-pipeline extensionがtoolを登録し、sessionが起動する。
- `extension-rpc-ready` load後にRPC `get_state`が成功する。

## How to get to it (user POV)

- `pi --extension extensions/development-pipeline/index.ts`で起動する。
- RPC modeで`get_state`を送り、extension load後のsession状態を得る。

## Driving it with verify-yorishiro

Preconditions:

- repository rootにいる。
- `extensions/development-pipeline/index.ts`が存在する。
- `pi`が`PATH`または`YORISHIRO_PI_BIN`で解決できる。

- **Run doctor.** 実行: `node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs doctor --json`。`pi`と`package-extension`がokになる。
- **Load extension.** 実行: `node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs drive extension-load --json`。`exit`がok、`extension load`がokになる。
- **Confirm direct load.** `command.json`のargvに`-e extensions/development-pipeline/index.ts`が残る。
- **Proof.** `artifacts/verify-yorishiro/<run-id>-extension-load/summary.json`と`stdout.txt`を保存する。

## Gotchas

- `--no-extensions`はdiscoveryを止めるが、明示`-e`はloadされる。
- `--no-tools`でもextension登録自体は行われる。このrecipeはtool実行を検証しない。
- global extensionやMCP serverをloadしない。`--no-extensions --no-skills`を付ける。
- load失敗時は`stderr.txt`にJitiのParseError等が残る。stdoutだけを見て成功と判断しない。
