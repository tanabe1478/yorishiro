# yorishiro

自分の判断基準、作業習慣、再利用可能な手順を育てるための [pi](https://pi.dev) ハーネスです。常設の指示は最小限に保ち、詳細は必要なときだけ読みます。

## 前提

- pi をインストールしてログイン済みであること。認証、通常設定、セッションは標準の `~/.pi/agent/` を共有し、yorishiro は複製しません。
- Node 22.19 以上。開発パイプラインを使う場合は Herdr 内で起動した Pi から実行します。

## 最短起動

```bash
./bin/yorishiro
```

作業リポジトリは `work/` 配下に置くと、yorishiro の `AGENTS.md` を親ディレクトリのコンテキストとして使えます。

```bash
git clone <repository-url> work/example
cd work/example
../../bin/yorishiro
```

個人的な補足は `AGENTS.local.md` に書きます（任意、Git 管理外）。作り方は[使い方](docs/usage.md#セットアップ)にあります。

## 普段の依頼

普通の言葉で目的と制約を伝え、計画に合意してから実装を委譲します。

- 「このリポジトリで○○が失敗する。まず原因を調べて修正計画を出して」
- 計画を確認して「その計画で進めて」と伝えると、`development_pipeline` が Worker と Reviewer を可視ペインで動かします
- 結果は差分・検証証跡・レビュー判定として `artifacts/<repository>/<run-id>/` に残ります。commit と push は自動では行いません

## 目的別に読む

すべてを先に読む必要はありません。関係する作業を始めるときに、必要な行だけ辿ってください。

| 知りたいこと | 読むもの |
|---|---|
| セットアップ、日々の依頼から結果までの流れ、ハーネスの育て方 | [docs/usage.md](docs/usage.md) |
| パイプラインの役割・固定モデル・契約・監視・cleanup・人間レビューの詳細 | [docs/development-pipeline.md](docs/development-pipeline.md) |
| observer の起動、通知、Web ダッシュボード、Claude Code hook | [docs/observer.md](docs/observer.md) |
| 検証Skillの作り方・保守・Yorishiro 自身の検証範囲 | [docs/verification.md](docs/verification.md) |
| pstack から何を取り込み、何を採らなかったか | [docs/pstack-adoption.md](docs/pstack-adoption.md) |
| pi を使わず Claude Code と Claude のモデルだけで使う | [docs/claude-code.md](docs/claude-code.md) |

常設の原則は [`AGENTS.md`](AGENTS.md)、実行時の手順は `skills/*/SKILL.md`、判定の閾値や設定の全項目は [docs/observer-reference.md](docs/observer-reference.md) にあります。

秘密情報や端末固有の絶対パスは、追跡対象ファイルへ書かないでください。
