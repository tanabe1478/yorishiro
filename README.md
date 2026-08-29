# yorishiro

自分の判断基準、作業習慣、再利用可能な手順を育てるための [pi](https://pi.dev) ハーネスです。

## 設計

- `AGENTS.md`: すべての作業で常に使う原則
- `AGENTS.local.md`: 公開しない個人的な補足（Git 管理外）
- `skills/`: 必要なときだけ読む再利用可能な手順
- `extensions/`: 指示だけでは保証できない制御や外部連携
- `package.json`: yorishiro の Skill と Extension をpiへ登録するマニフェスト
- `work/`: このハーネスで扱う作業リポジトリ（Git 管理外）

認証、通常設定、セッションは標準の `~/.pi/agent/` を共有します。yorishiro はそれらを複製せず、リポジトリ固有の能力だけを追加します。

## セットアップ

通常のpiをインストールしてログインしたうえで、必要ならローカル設定を作成します。

```bash
cp AGENTS.local.example.md AGENTS.local.md
./bin/yorishiro
```

既存のpi認証、グローバル設定、グローバルSkillをそのまま利用します。ランチャーはyorishiroをローカルpiパッケージとして追加ロードします。

## 作業リポジトリで起動する

`work/` 配下にリポジトリを置くと、yorishiro の `AGENTS.md` を親ディレクトリのコンテキストとして利用できます。

```bash
git clone <repository-url> work/example
cd work/example
../../bin/yorishiro
```

ランチャーは起動時のカレントディレクトリを維持したまま、yorishiroのSkillとExtensionを追加します。piのホームやセッション保存先は変更しません。

## 開発パイプライン

親Piで要件と実装計画を合意した作業は、`development_pipeline`へ委譲できます。Plannerは親セッション自身であり、子Plannerは起動しません。

| 役割 | 固定モデル | 担当 |
|---|---|---|
| Planner（親） | 親セッションのモデル | 要件、計画、Reviewer指摘の採否 |
| Worker · Luna | `openai-codex/gpt-5.6-luna` | 実装、テスト、ビルド、動作確認、修正 |
| Reviewer · Sol | `openai-codex/gpt-5.6-sol` | read-onlyレビュー、sandbox内の独立検証 |

パイプラインはHerdr内で起動したPiからのみ実行できます。現在のタブを、親55%、右45%のWorker／Reviewer上下2段へ分割します。子は通常のPi TUIとして表示され、修正と再レビューでは同じペインを再利用します。子からパイプラインを再帰起動することはできません。

WorkerとReviewerは中央validatorが検証する構造化JSONで報告します。Reviewerの判定は`APPROVED`、`APPROVED_WITH_NOTES`、`CHANGES_REQUESTED`、`NEEDS_PLANNER`です。Workerへ戻す情報はblocking findingだけに制限し、Reviewerの生出力やtranscriptは渡しません。同じ指摘IDの再発や、修正後に理由なく追加されたblockingは`NEEDS_PLANNER`で止まります。

修正回数は`maxReviewCycles`で指定でき、既定2、上限3です。旧`maxRepairCycles`も互換入力として受理し、両方指定時は`maxReviewCycles`を優先します。欠落・不正レポート、プロセス失敗、timeout、中断は安全側で停止します。失敗・中断・Planner判断待ちでは子ペインを残します。

Reviewerの検証コマンドはmacOSの`sandbox-exec`またはLinuxのbubblewrap/user namespaceによるread-only sandboxで実行します。未対応環境、sandbox未導入環境、`/tmp`配下の対象は作業開始前に拒否します。

成果物は`artifacts/<repository>/<run-id>/`に保存されます。主な内容は依頼、承認済み計画、`plan-review.json`、`diff-review.json`、各attemptの構造化report、baselineと各stageのstatus/diff、`run.json`です。既存のdirty変更はbaselineとして保持しますが、変更の帰属を完全には判定できません。

成功時の整理は`cleanupMode`で制御します。

- `ask`（既定）: UIで確認する
- `on-success`: 成功時だけ整理する
- `never`: ペインを残す

後から`development_pipeline_cleanup`へrunディレクトリを渡して整理できます。新構成はReviewer→Worker、旧構成はReview→Verify→Implementの順に閉じます。親ペイン、非idleペイン、別runのペインは保護されます。

人間レビューは`planReviewMode`と`diffReviewMode`で制御します（`ask`既定、`required`、`skip`）。計画レビューは子ペイン起動前、差分レビューはReviewer完了後かつcleanup前に実行し、結果と計画SHA-256をrun artifactへ保存します。変更要求や必須レビューの失敗では安全側で停止し、commit・pushは行いません。

## 育て方

1. まず `AGENTS.md` と設定だけで使う
2. 同じ説明や作業を繰り返したら `skills/<name>/SKILL.md` にする
3. 危険操作の禁止や確認、外部サービス連携が必要になったら `extensions/` に実装する
4. 常設コンテキストが増えすぎたら、原則だけを残して Skill へ移す

秘密情報や端末固有の絶対パスは、追跡対象ファイルへ書かないでください。
