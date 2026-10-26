# 使い方

[README](../README.md) / [開発パイプライン](./development-pipeline.md) / [observer](./observer.md) / [検証Skill](./verification.md)

Yorishiroを日常で使うための入門ガイドです。セットアップ、作業リポジトリからの起動、依頼から結果までの流れ、ハーネスの育て方を扱います。パイプラインの内部仕様が必要になったら[開発パイプライン](./development-pipeline.md)へ進んでください。

## ハーネスの構成

- `AGENTS.md`: すべての作業で常に使う原則（最小限に保つ）
- `AGENTS.local.md`: 公開しない個人的な補足（Git 管理外、任意）
- `skills/`: 必要なときだけ読む再利用可能な手順
- `extensions/`: 指示だけでは保証できない制御や外部連携
- `package.json`: yorishiro の Skill と Extension をpiへ登録するマニフェスト
- `work/`: このハーネスで扱う作業リポジトリ（Git 管理外）

認証、通常設定、セッションは標準の `~/.pi/agent/` を共有します。yorishiro はそれらを複製せず、リポジトリ固有の能力だけを追加します。

## セットアップ

通常のpiをインストールしてログインしたうえで、Yorishiroを起動します。

```bash
./bin/yorishiro
```

既存のpi認証、グローバル設定、グローバルSkillをそのまま利用します。ランチャーはyorishiroをローカルpiパッケージとして追加ロードします。Node 22.19以上が必要です。

個人的な補足を残したい場合だけ、ローカル設定を作成します（必須ではありません）。

```bash
cp AGENTS.local.example.md AGENTS.local.md
```

`AGENTS.local.md`はGit管理外に置き、端末固有の絶対パスや個人の好みだけを書きます。

## 作業リポジトリで起動する

`work/` 配下にリポジトリを置くと、yorishiro の `AGENTS.md` を親ディレクトリのコンテキストとして利用できます。

```bash
git clone <repository-url> work/example
cd work/example
../../bin/yorishiro
```

ランチャーは起動時のカレントディレクトリを維持したまま、yorishiroのSkillとExtensionを追加します。piのホームやセッション保存先は変更しません。

## 日常の流れ

1. **依頼する。** 普通の言葉で目的と制約を伝えます。例:「このリポジトリの○○が失敗するので、まず原因を調べて修正計画を出して」。
2. **計画に合意する。** 親Piが[`development-workflow`](../skills/development-workflow/SKILL.md)に沿って調査し、計画と変更予定pathを示します。内容を確認し、「その計画で進めて」と承認します。
3. **委譲する。** 承認後に`development_pipeline`を実行すると、Herdrの可視ペインでWorker · DeepSeekが実装し、Reviewer · Solがread-onlyで独立検証します。計画レビュー・差分レビューを求める設定では、その場で人間の確認が入ります。
4. **結果を使う。** 実行結果、差分、検証の証跡、レビュー判定が`artifacts/<repository>/<run-id>/`に残ります。commit・pushは自動で行われないため、内容を確認して自分で判断します。

計画が曖昧なまま委譲しないこと、失敗や`NEEDS_PLANNER`ではペインと証跡が残ることを前提にしてください。詳しい状態遷移、契約、監視、cleanupの挙動は[開発パイプライン](./development-pipeline.md)にあります。

セッションの様子を横から眺めたいときは[observer](./observer.md)を使います。project-localの検証手順を用意したいときは[検証Skill](./verification.md)を読んでください。

## パイプラインを使う前に

`development_pipeline`を実行できるのは、Herdr内で起動した親Piからだけです。開始時点で現在タブに親以外のペインがないこと、対象リポジトリがread-only検証sandboxを使えること、対象が`/tmp`配下でないことが前提で、満たさなければ開始前に停止します。正確な条件は[開発パイプラインの前提](./development-pipeline.md#前提)にあります。

## ハーネスを育てる

1. まず `AGENTS.md` と設定だけで使う
2. 同じ説明や作業を繰り返したら `skills/<name>/SKILL.md` にする
3. 危険操作の禁止や確認、外部サービス連携が必要になったら `extensions/` に実装する
4. 常設コンテキストが増えすぎたら、原則だけを残して Skill へ移す

入口と常設指示は最小限にし、詳細な文書は関係する作業のときだけ読みます。

秘密情報や端末固有の絶対パスは、追跡対象ファイルへ書かないでください。

## 参考

- pstackから何を取り込み、何を採らなかったか: [pstack-adoption.md](./pstack-adoption.md)
- 開発workflowそのもの: [`skills/development-workflow/SKILL.md`](../skills/development-workflow/SKILL.md)
- パイプラインの実行時入口: [`skills/development-pipeline/SKILL.md`](../skills/development-pipeline/SKILL.md)
