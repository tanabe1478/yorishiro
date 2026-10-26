# セッション観測（observer）

[README](../README.md) / [使い方](./usage.md) / [判定・設定の詳細](./observer-reference.md)

`bin/yorishiro-observe` は、動いている pi または Claude Code のセッションログ（JSONL）を読み取り専用で追いかけ、人間向けに状態を要約します。エージェントには介入せず、あなたが「いま見る価値があるか」を判断する材料だけを出します。この文書はobserverを使うときだけ読む利用ガイドです。判定の閾値・分類器・コスト式・設定の全項目は[observer-reference.md](./observer-reference.md)にあります。

## 起動

```bash
# カレントディレクトリの最新セッション（pi / Claude Code の新しい方）を追いかける
./bin/yorishiro-observe

# Herdr のペインに紐づくセッションを追う / 形式を固定 / 1回だけ評価 / macOS 通知
./bin/yorishiro-observe --pane w5:p8S
./bin/yorishiro-observe --claude --once
./bin/yorishiro-observe --pi --notify
./bin/yorishiro-observe path/to/session.jsonl --json

# Herdr の現在ペインを下に分割し、そこで自分のセッションを追う observer を起動する
./bin/yorishiro-observe --open-pane --notify
```

全オプションは`./bin/yorishiro-observe --help`にあります。

## 表示の見方

表示は緑（放置してよい）、黄（そろそろ確認）、赤（介入を検討）の3段階で、根拠と「エージェントに何を伝えるか」の文案を添えます。何を黄・赤とみなすかは[observer-reference.md](./observer-reference.md)の判定表にまとめてあります。

## Web ダッシュボード

Herdr を使わない場合や複数セッションをまとめて見たい場合は、ローカルの Web サーバーとして起動します。

```bash
./bin/yorishiro-observe serve --open            # http://127.0.0.1:4877/ をブラウザで開く
./bin/yorishiro-observe serve --notify --hours 6  # 6時間以内に動いたセッションだけ追い、黄・赤で macOS 通知
```

`~/.pi/agent/sessions/` と `~/.claude/projects/` を走査して動いているセッションを自動検出し、1枚ずつカードで表示します。カードには判定と根拠、エージェントへ送る文案（コピーボタン付き）、コスト判定と運転の変え方、コンテキスト・検証・差分・トークン内訳が載ります。Herdr が動いていればペイン ID も付きます。bind 先は `127.0.0.1` 固定が既定で、`--host` で変えられます。API は `/api/sessions`（JSON）と `/api/events`（SSE）です。`?all=1` でフィルタを外した状態、`?nosse=1` で SSE を使わないポーリング表示（ヘッドレスブラウザでの撮影用）になります。

## Claude Code hook 連携

```bash
./bin/yorishiro-observe install-hooks
```

`~/.claude/settings.json` にバックアップを作ってから SessionStart / Stop / Notification の hook を追加します（登録済みなら何もしません）。

- SessionStart: セッション ID、transcript のパス、Herdr のペイン ID を `~/.local/state/yorishiro/observer/sessions/` に記録
- Stop: transcript を読んで終了時監査（未検証編集、TODO 混入、差分の増大、エラー反復など）を `audits/` に保存し、黄・赤なら macOS 通知
- Notification: Claude Code の通知（権限待ちなど）を macOS 通知へ転送し `notifications/` に記録

hook は常に exit 0 で、エージェントの動作を止めません。pi には外部 hook がないため、pi の終了時監査は追従モードの observer が担います。

## 分類器（安いモデル）の扱い

既定では、黄・赤に変わったとき、またはターンが終わったときにだけ、構造化サマリを安いモデルへ渡して5分類で助言させます。全文の会話は渡しません。ルールだけで通知したいときは`--advisor none`を使います。分類の種類、呼び出し先とモデルの指定（`--advisor-model`、`YORISHIRO_OBSERVER_ADVISOR`）、コスト判定の項目は[observer-reference.md](./observer-reference.md)にあります。

## ログの場所と限界

セッションログの場所は pi が `~/.pi/agent/sessions/`、Claude Code が `~/.claude/projects/` で、作業ディレクトリのパスか Herdr が持つセッション ID から導出します。エージェントの内部推論は記録されないため、観測できるのは会話、ツール呼び出し、その結果だけです。
