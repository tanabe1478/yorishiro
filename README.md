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

要件と実装計画が親Sol会話で承認済みの作業は `development_pipeline` ツールへ委譲できます。親エージェントが実装を重複して行わず、承認済みのタスクと計画を渡してください。計画用の子ペインは作りません。

| 役割 | 固定モデル | 権限 |
|---|---|---|
| 計画・調査・要件（親Sol会話） | `openai-codex/gpt-5.6-sol` | 親会話で実施 |
| 実装 | `openai-codex/gpt-5.6-luna` | coding tools |
| 検証 | `openai-codex/gpt-5.6-terra` | read, grep, find, ls, sandboxed verification command |
| レビュー | `openai-codex/gpt-5.6-sol` | read-only |

パイプラインは **Herdr 上で起動した Pi からのみ**実行できます。計画は親Sol会話で承認済みである必要があり、実行時に `approvedPlan` として保存します。`HERDR_PANE_ID`、`HERDR_TAB_ID`、`HERDR_WORKSPACE_ID`、`HERDR_SOCKET_PATH` を検証し、現在のタブを右分割して各ステージの通常のインタラクティブ Pi TUI を表示します。親ペインは残り、自動フォーカス・ズーム・ペイン削除は行いません。各ペインのプロンプト、ツール呼び出し、編集、差分、テスト出力を直接確認できます。

子ステージのペイン名は `Implement · Luna`、`Verify · Terra`、`Review · Sol` です。検証にはmacOSの`/usr/bin/sandbox-exec`、またはLinuxの`/usr/bin/bwrap`と利用可能なuser namespaceが必要です。その他のOS、sandbox未導入環境、`/tmp`配下の対象リポジトリは実装開始前に明確に拒否します。修復・再検証・再レビューは同じペインとPiセッションへ追加入力し、ペイン名を変えません。完了・失敗・中断後もペインは保持されるため、不要になったペインは Herdr で手動削除してください。Pi の公式 Herdr integration は現在未導入です。この実装は Herdr CLI 0.7.3 の画面・ペイン検出を使い、グローバル設定は変更しません。

各ペインはまず `startup` 状態で最大15秒、`argv0` が厳密に `pi` のプロセス情報を待ちます。Piを観測するまでは欠落情報を終了とは扱いません。観測後に有効なプロセス情報からPiが消えた場合だけ `exited`、起動猶予または通常の30分制限を超えた場合は別の失敗として記録します。プロセス情報のコマンド失敗・JSON解析失敗も終了とはみなさず、再試行後に専用エラーにします。タイムアウト・中断時は `ctrl+c`、`escape`、idle確認で子作業を停止しますが、ペインと証跡は保持します。

成功時のworkerペイン整理は `cleanupMode`（`ask` / `on-success` / `never`、既定値`ask`）で制御します。失敗・中断・CHANGES_REQUIREDでは自動削除せず、拒否時もペインを残します。後から `development_pipeline_cleanup` に成果物runディレクトリを渡して整理できます（実パスをcanonicalizeし、`SUCCESS` runだけを受け付けます）。親ペインは常に保護されます。各ステージは、明示的にロードした `submit_stage_report` 拡張ツール（オーケストレータが選んだ pending パスだけへ原子的に書ける狭い報告機構）で、厳密な verdict を含む成果物を保存します。Verifyのコマンドはカーネル強制のread-only sandbox内で実行され、プロセスグループ単位でキャンセルされます。各結果にはモデル可視のexit status（通常終了・TIMEOUT・CANCELLED）が含まれ、出力はUTF-8バイト単位でstatus/通知を含めて64 KiBに制限されます。ソースや報告を変更できません。Planは親Sol会話から供給し、子ペインを作りません。実行記録は `artifacts/<repository>/<run-id>/`（Git管理外）の `request.md`、レポート、`diffs/`、`run.json` にあり、ペイン ID と状態（pending/running/passed/failed/blocked/aborted）も記録されます。有効な検証 FAIL またはレビュー CHANGES_REQUESTED は最大1回だけ修復できます。欠落・不正レポート、プロセス失敗、タイムアウト、中断は終端失敗です。修復・再検証・再レビューは既存セッションで続行します。開始時の dirty tree は baseline として保存しますが、既存変更との帰属は完全には判定できません。

## 育て方

1. まず `AGENTS.md` と設定だけで使う
2. 同じ説明や作業を繰り返したら `skills/<name>/SKILL.md` にする
3. 危険操作の禁止や確認、外部サービス連携が必要になったら `extensions/` に実装する
4. 常設コンテキストが増えすぎたら、原則だけを残して Skill へ移す

秘密情報や端末固有の絶対パスは、追跡対象ファイルへ書かないでください。
