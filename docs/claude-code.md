# Claude Code で使う

[README](../README.md) / [使い方](./usage.md) / [開発パイプライン](./development-pipeline.md)

pi を使わず、Claude Code と Claude のモデルだけで Yorishiro を使うためのガイドです。Skill、workflow、開発パイプラインの契約・sandbox・証跡は pi 版と共通で、親と子の実行環境だけが Claude Code に替わります。

## 起動

```bash
./bin/yorishiro-claude
```

`claude --plugin-dir <yorishiro>` を実行し、`skills/` の Skill を plugin として読み込みます。あわせて、Skill が CLI を呼ぶための `YORISHIRO_ROOT` を設定します。残りの引数はそのまま `claude` に渡します。

起動したディレクトリが作業場所になります。作業リポジトリは `work/` の下に置いても、任意のディレクトリにあってもかまいません。

```bash
cd ~/src/example
~/path/to/yorishiro/bin/yorishiro-claude
```

PATH の通ったディレクトリにシンボリックリンクを置けば、どこでも `yorishiro-claude` だけで起動できます。ランチャーはリンクをたどって yorishiro の場所を見つけます。

```bash
ln -s ~/path/to/yorishiro/bin/yorishiro-claude ~/.local/bin/yorishiro-claude
cd ~/src/example
yorishiro-claude
```

- yorishiro の中（`work/` の下を含む）では、Claude Code が親ディレクトリをたどって yorishiro の `AGENTS.md` を自分で読み込みます。
- それ以外の場所では、ランチャーが `AGENTS.md`（あれば `AGENTS.local.md` も）を `--append-system-prompt` で渡します。文中の相対パスは yorishiro を基準に読むよう添えます。作業ディレクトリにある `CLAUDE.md` などのプロジェクトの指示も、通常どおり読み込まれます。
- パイプラインの対象は、入力で `cwd` を省いた場合、CLI を実行したディレクトリ（ふつうは起動したディレクトリ）です。証跡は、どこで起動しても yorishiro の `artifacts/<対象ディレクトリ名>/` に保存されます。

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

- 共通：`--model` でモデルを固定し、`--permission-mode dontAsk`（Worker は入力の `workerPermissionMode` が `bypass` のときだけ代わりに `--dangerously-skip-permissions`。[下記](#worker-の権限workerpermissionmode)）、`--strict-mcp-config` を付けます。報告ツール `submit_stage_report` は、run ごとに生成する stdio MCP サーバー（`extensions/development-pipeline/claude-mcp.mjs`）から渡します。
- Worker：`--setting-sources project` で利用者の個人設定を読みません。ツールは Read/Grep/Glob/Bash/Edit/Write です。
- Reviewer：`--restricted` で、コードを実行するツールを外し、設定ファイルを読まず、ファイル操作を作業ディレクトリに閉じ込めます。ツールは Read/Grep/Glob と、sandbox で検証を行う `run_verification_command` だけです。

### Worker の権限（workerPermissionMode）

入力の `workerPermissionMode` は `"default"`（既定。省略と同じ）か `"bypass"`。CLI も同じ JSON をそのまま渡します。それ以外の値と、Pi ランタイムでの `"bypass"` は、artifact もペインも作る前のエラーです。採用した値は `run.json` の `workerPermission`（`{ "mode": "bypass", "flag": "--dangerously-skip-permissions" }`、既定なら `{ "mode": "default", "flag": "--permission-mode dontAsk" }`）に残ります。

用途：Worker が保護された場所（`.claude/`、`.git/` など）へ Edit/Write で書く必要があるときだけ指定します。たとえば `.claude/skills/<名前>/` に skill を作る依頼です。`default` の Worker はここへ書けず、`IMPLEMENTATION_BLOCKED` になります。

`bypass` のとき変わるのは Worker 起動時の `--permission-mode dontAsk` が `--dangerously-skip-permissions` に替わる点だけです。`--setting-sources project`、`--tools`、`--allowedTools`、`--add-dir`、export する環境変数は同じで、修正ループで同じペインへ指示を送っても起動時の設定のままです。

保護された場所へ file tool で書けるかを、claude 2.1.322 で一時的な git リポジトリの中で、`claude -p` に `.claude/skills/t/a.txt` を Write させて確かめた結果（プロンプトは標準入力から渡す）：

| 権限の設定 | 結果 |
|---|---|
| dontAsk + `--allowedTools Write` | 拒否 |
| dontAsk + `Write(.claude/skills/**)` | 拒否（「file permission checks には Edit(path) だけが効く」と警告） |
| dontAsk + `Edit(.claude/skills/**)`（相対・絶対） | 拒否 |
| `--permission-mode acceptEdits` | 拒否 |
| `--dangerously-skip-permissions` | 書けた |

`.claude/` は allow rule では開けられず、skip-permissions だけが通ります。このため他の権限設定（acceptEdits など）は選べません。

危険：Worker はもともと Bash を制限なしで許されているので、増えるのは保護された場所への file tool での書き込みです。`.claude/settings.json` の hooks や `.git/` を直接書き換えられます。対象リポジトリの外は `allowedPathPrefixes` の照合の対象外で、これは Bash と同じです。信頼できる依頼にだけ使ってください。

Reviewer は `workerPermissionMode` に関係なく、常に `--restricted` と dontAsk の読み取り専用です。

### pi 版との違い

- model guard はありません。子は `--model` で固定して起動しますが、子ペインの TUI で人間が `/model` を使えば切り替えられます。`run.json` の `modelGuard.enabled` は `false` です。
- 起動前の確認は `claude auth status` のログイン状態だけです。Claude Code にはオフラインのモデル一覧がないので、モデル ID が使えるかは子の起動時まで分かりません。`run.json` の `modelPreflight` には認証方式、プラン種別、API キー用の環境変数があるかどうかだけを記録し、メールアドレスや組織、キーの値は残しません。
- 人間レビューのゲート（`planReviewMode`／`diffReviewMode`）は、CLI には確認 UI がないので `required` を指定できません。指定すると、何も作らずに exit 2 で止まります。計画の承認は Claude Code の会話の中で取ります。`cleanupMode` の `ask` も確認できないので、ペインを残します。

### 初回の信頼確認

Claude Code は、初めて開くフォルダで「このフォルダを信頼するか」を確認します。子がこの確認で止まると、Herdr はペインを `blocked` と表示し、パイプラインは「人間の確認待ち」と進捗に出したまま待ちます（stage の期限は既定で 90 分です。入力の `stageTimeoutMs` で変えられます）。ペインで承認すれば続きます。対象リポジトリで `yorishiro-claude` を起動したときに親の確認で承認していれば、同じディレクトリで動く子には確認は出ません。

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
