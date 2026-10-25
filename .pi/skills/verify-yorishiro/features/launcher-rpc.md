# Launcher RPC

実際の`bin/yorishiro`を起動し、Yorishiro packageのextensionが読み込まれたPiがRPC `get_state`へ応答し、model identityを返すことを確認する。userが最初に触るentry pointのsmoke proof。

## Sub-features

- `launcher-start` 実際のlauncher scriptがPi RPC processを起動する。
- `launcher-package-load` launcherがYorishiro packageを`--extension`で明示loadする。
- `launcher-get-state` `get_state`が成功し、provider/model identityを返す。
- `launcher-no-model-call` `--no-tools --no-session --no-skills`でmodel APIを呼ばずに応答する。

## How to get to it (user POV)

- repository rootから`./bin/yorishiro`を実行する。
- RPC modeで起動し、`get_state`を送る。
- 通常のTUI起動ではなく、同じlauncher scriptとpackage loadを確認する最短経路を使う。

## Driving it with verify-yorishiro

Preconditions:

- repository rootにいる。
- `doctor`が完了し、`launcher`と`pi`のcheckがokである。
- `artifacts/verify-yorishiro/`へ書ける。

- **Run doctor.** 実行: `node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs doctor --json`。`checks[]`の`launcher`と`pi`が`ok:true`になる。
- **Launch RPC.** 実行: `node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs drive launcher-rpc --json`。processが終了し、`exit` checkがokになる。
- **Confirm RPC response.** 同じresultの`checks[]`で`rpc response`がok、`summary.json`のstdoutに`"command":"get_state"`が残る。
- **Confirm model identity.** `checks[]`の`model identity`が`provider/id`形式のdetailを持つ。ここではmodel APIを呼ばない。
- **Proof.** `artifacts/verify-yorishiro/<run-id>-launcher-rpc/summary.json`、`command.json`、`stdout.txt`を保存する。cleanup後も残ることを確認する。

## Gotchas

- `--no-extensions`を付けても、launcherが明示的に渡す`--extension <repo>`はloadされる。`--no-skills`はproject Skillの自動探索を止める。
- `--no-session`を付けないとsession fileが増える。このrecipeは付けている。
- model APIを呼ぶpromptを送らない。`get_state`だけならofflineで完結する。
- globalなagent設定や認証を変更しない。`PI_OFFLINE=1`をhelperが設定する。
- `doctor`が`degraded`でも、`launcher`と`pi`がokならこのfeatureは実行できる。bwrap/herdrの欠落は別featureの前提。
