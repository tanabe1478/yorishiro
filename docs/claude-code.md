# Claude Code で使う

[README](../README.md) / [使い方](./usage.md) / [開発パイプライン](./development-pipeline.md)

pi を使わず、Claude Code と Claude のモデルだけで Yorishiro を使うためのガイドです。Skill、workflow、開発パイプラインの契約・sandbox・証跡は pi 版と共通で、親と子の実行環境だけが Claude Code に替わります。

## 起動

```bash
./bin/yorishiro-claude
```

`claude --plugin-dir <yorishiro>` を実行し、`skills/` の Skill を plugin として読み込みます。あわせて、Skill が CLI を呼ぶための `YORISHIRO_ROOT` を設定します。作業リポジトリは pi 版と同じく `work/` の下に置けます。

## 開発パイプライン

Claude Code には pi のツール登録の仕組みがないので、パイプラインは CLI から呼びます。

```bash
"$YORISHIRO_ROOT/bin/yorishiro-pipeline" run --input plan.json
```

- 入力は `development_pipeline` と同じ JSON です（`task`、`approvedPlan`、`qualityContract`、`workflow`、`cwd` など）。
- Herdr 内の Claude Code から、Bash のバックグラウンド実行で呼びます。最終結果は stdout に JSON（`outcome`、`artifactDir`）で出て、進捗は stderr に出ます。
- exit code は 0 が `SUCCESS`、3 がそれ以外の結果、2 が入力や前提の誤りです。
- 後片付けは `yorishiro-pipeline cleanup --run <artifactDir>`（成功 run）と `yorishiro-pipeline reset --run <artifactDir> --confirm`（失敗・中断 run）です。

### 役割とモデル

| 役割 | 既定モデル | 変え方 |
|---|---|---|
| Worker · Claude | `claude-sonnet-5-5`（effort `high`） | `--worker-model` または `YORISHIRO_CLAUDE_WORKER_MODEL` |
| Reviewer · Claude | `claude-opus-5-5`（effort `medium`） | `--reviewer-model` または `YORISHIRO_CLAUDE_REVIEWER_MODEL` |

モデルは run の開始時に固定され、`run.json` の `models` に記録されます。実行中に別のモデルへ切り替える仕組み（fallback）はありません。

### 子の起動条件

子は Herdr のペインで、対話型の `claude` として起動します。

- 共通：`--model` でモデルを固定し、`--permission-mode dontAsk`、`--strict-mcp-config` を付けます。報告ツール `submit_stage_report` は、run ごとに生成する stdio MCP サーバー（`extensions/development-pipeline/claude-mcp.mjs`）から渡します。
- Worker：`--setting-sources project` で利用者の個人設定を読みません。ツールは Read/Grep/Glob/Bash/Edit/Write です。
- Reviewer：`--restricted` で、コードを実行するツールを外し、設定ファイルを読まず、ファイル操作を作業ディレクトリに閉じ込めます。ツールは Read/Grep/Glob と、sandbox で検証を行う `run_verification_command` だけです。

### pi 版との違い

- model guard はありません。子は `--model` で固定して起動しますが、子ペインの TUI で人間が `/model` を使えば切り替えられます。`run.json` の `modelGuard.enabled` は `false` です。
- 起動前の確認は `claude auth status` のログイン状態だけです。Claude Code にはオフラインのモデル一覧がないので、モデル ID が使えるかは子の起動時まで分かりません。`run.json` の `modelPreflight` には認証方式、プラン種別、API キー用の環境変数があるかどうかだけを記録し、メールアドレスや組織、キーの値は残しません。
- 人間レビューのゲート（`planReviewMode`／`diffReviewMode`）は、CLI には確認 UI がないので `required` を指定できません。指定すると、何も作らずに exit 2 で止まります。計画の承認は Claude Code の会話の中で取ります。`cleanupMode` の `ask` も確認できないので、ペインを残します。

### 初回の信頼確認

Claude Code は、初めて開くフォルダで「このフォルダを信頼するか」を確認します。子がこの確認で止まると、Herdr はペインを `blocked` と表示し、パイプラインは「人間の確認待ち」と進捗に出したまま待ちます（stage の期限は既定で 30 分です）。ペインで承認すれば続きます。前もって対象リポジトリで一度 `claude` を起動して承認しておけば、確認は出ません。

### 利用枠

子の `claude` は親と同じ認証を使います。claude.ai のサブスクリプションでログインしていればその利用枠から、`ANTHROPIC_API_KEY` を設定していれば API の従量課金から消費します。どちらだったかは `run.json` の `modelPreflight.auth` で確認できます。

## 確認済みの範囲

Claude Code 2.1.310、Herdr 0.7.3（macOS）で、小さな検証用リポジトリを相手に一度通しました。

- Worker（Sonnet）の実装、quality gate の 2 チェック、Reviewer（Opus）の sandbox 検証まで進み、`SUCCESS` で終わりました。子のセッションログでも、Worker は `claude-sonnet-5-5`、Reviewer は `claude-opus-5-5` だけで動いていました。Reviewer が使ったのは Read/Glob と MCP の 2 ツールだけでした。
- 初回の信頼確認で Worker が `blocked` になり、ペインで承認したあとに続きました。
- `yorishiro-pipeline cleanup` で、両方の子ペインが閉じました。

まだ実機で確認していないもの：

- Reviewer の指摘を Worker に戻す修正ループ（同じペインへ `send-text` でプロンプトを送る経路）。偽の `herdr` を使ったテストでもまだ通していません。
- 中断（SIGINT）と `reset`
- Linux（bubblewrap）での実行
