# pstack adoption in Yorishiro

Yorishiro は [pstack](https://github.com/cursor/plugins/tree/main/pstack) の考え方の一部を、Pi と Herdr 上の安全境界に合わせて移植しました。これは pstack の完全な互換実装ではありません。ここでは、何を取り込み、何を取り込まず、なぜそうしたかを分類ごとに列挙します。

## 上流

- repository: `cursor/plugins`
- revision: `99b609a72323b70204eab407c622f436e858e112`
- path: `pstack/`
- license: MIT、Copyright (c) 2026 Lauren Tan
- license 全文: [`docs/licenses/pstack-MIT.txt`](./licenses/pstack-MIT.txt)

上流の取得・実行を Yorishiro の runtime が自動で行うことはありません。plugin marketplace、auto-update、download、remote script 実行は組み込みません。

## 採用・適応したもの

| pstack の要素 | Yorishiro の対応 | 状態 |
|---|---|---|
| `poteto-mode` の「理解 → 設計 → 計画 → 委譲 → 実ユーザー面の検証 → 独立review → 修正 → 報告」 | `skills/development-workflow/SKILL.md` と `development_pipeline` | 適応 |
| Feature playbook | `skills/development-workflow/playbooks/feature.md` | 適応 |
| Bug fix playbook（再現、mechanism、失敗→成功証拠） | `skills/development-workflow/playbooks/bug-fix.md` | 適応 |
| Refactoring playbook（振る舞い保存） | `skills/development-workflow/playbooks/refactoring.md` | 適応 |
| `create-verification-skill` | `skills/create-verification-skill/SKILL.md`、生成先`.pi/skills/verify-<project>/` | 適応 |
| `maintain-verification-skill` | `skills/maintain-verification-skill/SKILL.md` | 適応 |
| feature map の4-H2構造 | `.pi/skills/verify-yorishiro/features/` と生成Skillの規約 | 適応 |
| 検証を先に実行し、証拠を残す原則 | quality contract、sandbox check、evidence回収、Reviewer | Yorishiro既存能力と統合 |
| 「小さく検証可能な単位」 | `qualityContract.planItems` とrequiredChecks | Yorishiro既存能力と統合 |
| 同一モデルでの有限修正 | `maxReviewCycles`、`qualityRepair`、`NEEDS_PLANNER`/`CHANGES_REQUIRED` | Yorishiro既存能力と統合 |

### Yorishiro 側で再利用した既存能力

- Herdr の可視ペインと固定モデル子セッション
- 中央validator付きstructured report
- SHA-256付きquality contract
- kernel sandbox内の独立check（macOS `sandbox-exec` / Linux bubblewrap）
- 人間の計画・差分レビュー
- 失敗runのペイン保護とcleanup/reset
- read-only ReviewerとWorkerの分離

### モデル固定の移行

- 実装・修正 Worker: `opencode-go/deepseek-v4.1-flash`（role label `Worker · DeepSeek`）
- read-only Reviewer: `openai/gpt-5.6-sol`（role label `Reviewer · Sol`）
- 旧 `openai-codex/gpt-5.6-sol` はこのPi環境のcatalogに存在しないため、同じSol modelを提供するcanonical provider `openai`へ移行した。
- 子launcherは固定modelを`--model`で指定し、`model-guard.ts`が`tool_call`境界でactive modelの不一致・不明を拒否する。
- 親のモデルは変更しない。
- quality evidence違反は、同じWorkerペインでの有限repairだけを許可する。モデル切替・fallbackは行わず、再発時は`NEEDS_PLANNER`で停止理由を残す。
- `pi auth check --model ... --json --no-refresh`と`pi --offline --list-models`で、pane起動前に固定modelのcatalog存在とprovider readinessを確認する。credentialは保存・表示しない。

model guard は security sandbox ではありません。意図的に敵対的なWorker、改変されたPi runtime、任意のnested shell programは防げません。Piのtool実行境界で偶発的なmodel選択・cycle・restoreを止めるだけです。

## 取り込まなかったもの（分類別の全リスト）

### Skills

上流 README に列挙される Skill のうち、`create-verification-skill` と `maintain-verification-skill` 以外は standalone Skill として取り込んでいません。`poteto-mode` は workflow の考え方だけを適応し、Skill本体は取り込んでいません。

ここでの「未採用」は「Cursor専用だから除外」という意味ではありません。`how`、`why`、`tdd`、`unslop` などportableなものも含まれます。今回のscopeを「開発workflow」と「verification Skillの生成・保守」に絞ったため、残りはdeferredとした、というのが正確な理由です。常時ロードするSkillを増やさず、必要になった時に実際の利用履歴を根拠に追加する方針です。

| 分類 | 取り込まなかった Skill | 理由 | 代替・将来のtrigger |
|---|---|---|---|
| 入口・自己改善 | `poteto-mode`, `poteto-help`, `in-your-own-words`, `sharpen`, `automate-me`, `reflect`, `correct`, `teach`, `figure-it-out`, `show-me-your-work`, `setup-pstack` | 今回の採用scope外。`poteto-mode`のworkflowだけを適応し、mode/role設定、transcript mining、AskQuestion前提の自己改善loopはdeferred。一部はportableだが、Yorishiroの固定model・親Planner・run artifactで代替できる。 | 同じ手法が繰り返し必要になったら、Skillではなく`development-workflow`のplaybookかAGENTS原則へ昇格する。`show-me-your-work`相当はrun artifactで代替。 |
| 調査・文章 | `how`, `why`, `recall`, `ketchup`, `ketchup-video`, `bro`, `unslop`, `technical-writing`, `typescript-best-practices`, `no-comments`, `benchmark-checklist`, `blast-radius`, `tdd` | 今回の採用scope外。`how`/`why`/`tdd`などportableなものも多い。bug-fix playbookには失敗→成功の再現証拠だけを限定して反映したが、`benchmark-checklist`全体、`blast-radius`全体、TDD Skill全体は未移植。 | 実測値の検証、文章規範、test-firstが独立して繰り返されたら、必要になった一つだけを追加する。 |
| 並列・多model | `architect`, `arena`, `swarm`, `interrogate` | Yorishiroは固定Worker＋read-only Reviewerの分離を維持し、無制限fleet・multi-model coding fallback・arena選択を採用しない。 | 独立sliceが増え、共有書込みを分離できる具体的必要が出た場合だけ検討する。 |
| 製品・外部連携 | `make-bot-ui` | 外部Bot、webhook、Tailscale、sender-keyに依存する。 | 外部連携は`extensions/`で明示実装する。Skillでは追加しない。 |
| 形式検証 | `create-formal-verification-skill`, `maintain-formal-verification-skill`, `statechart` | **deferred。NOT implemented。** TLA+/TLC、statechart生成、model-checkの運用手順は未移植。 | 競合・retry・state machineのbugがtestで到達できず、継続的なverificationが必要になった時に、独立taskとして設計する。現時点で存在を主張しない。 |
| Cursor team kit | `deslop`, `control-cli`, `control-ui` | 上流でも別plugin。Cursor固有のUI/CLI controlに依存する。 | CLI/TUIの反復操作が必要になったら、Yorishiroのhelper scriptとして実装する。 |
| Cursor built-in | `create-skill`, `/autopilot`, `/loop`, `/model`, `AskQuestion`, custom mode | Cursorのslash command/mode/plugin marketplaceに依存する。 | PiのSkill authoring、RPC、Herdr、人間gateで代替する。 |

### Playbooks

上流の23 playbookのうち、`feature`、`bug-fix`、`refactoring` だけを適応しました。以下は取り込んでいません。

| 分類 | 取り込まなかった playbook | 理由 |
|---|---|---|
| 調査 | `investigation`, `runtime-forensics`, `trace-forensics` | Yorishiroでは親Plannerのread-only調査、または対象repoのverify Skillで代替する。 |
| 性能 | `perf-issue`, `hillclimb` | baseline計測と継続的最適化は独立した運用が必要。未実証の数値を出さない原則はworkflowに含めた。 |
| 設計探索 | `prototype`, `visual-parity` | 使い捨てprototypeやpixel比較のharnessを持たない。対象repoのverify Skillで扱う。 |
| Skill/eval | `authoring-a-skill`, `eval` | Skill authoringは手動。eval基盤は未導入。 |
| PR運用 | `babysit`, `shipping`, `opening-a-pr`, `autonomous-run`, `orchestrate`, `autopilot-full`, `autopilot-stack` | Yorishiroはcommit/push/PR/mergeを既定で行わず、外部操作前に人間確認を置く。無制限autonomy・watcher・fleetは採用しない。 |
| 継続作業 | `session-pickup`, `pause-safely`, `multi-phase-plan` | Pi sessionのresume/forkとrun artifactで部分代替。専用playbookは未導入。 |
| 環境整理 | `worktree-cleanup` | worktree/シミュレータ管理はYorishiroの対象外。 |

### Principles

24 principle は standalone Skill として取り込んでいません。上流自身も24個を常時コンテキストへ載せるのではなく、必要なleafをon-demandで読む設計です。Yorishiroが採用しなかったのは「常時ロードが重いから」ではなく、今回の採用scopeをworkflowとverificationに絞り、principle群の運用まで同時に持ち込まないと判断したためです。以下の名前は把握していますが、必要な考え方だけをworkflowへ折り込みました。

- core: `laziness-protocol`, `foundational-thinking`, `redesign-from-first-principles`, `attack-the-premise`, `subtract-before-you-add`, `minimize-reader-load`, `outcome-oriented-execution`, `experience-first`, `exhaust-the-design-space`, `build-the-lever`
- architecture: `model-the-domain`, `boundary-discipline`, `type-system-discipline`, `make-operations-idempotent`, `migrate-callers-then-delete-legacy-apis`, `separate-before-serializing-shared-state`
- verification: `prove-it-works`, `fix-root-causes`, `sequence-verifiable-units`, `test-behavior-not-implementation`, `explain-the-number`
- delegation: `guard-the-context-window`, `never-block-on-the-human`
- meta: `encode-lessons-in-structure`

理由: 今回のscopeでは、24個のleaf Skillとそのindex運用を維持するより、workflow、quality contract、repair bound、cleanupに必要な原則だけを明示的に埋め込む方が監査しやすい。`prove-it-works`、`fix-root-causes`、`sequence-verifiable-units`、`test-behavior-not-implementation`、`model-the-domain`、`boundary-discipline`、`laziness-protocol`、`make-operations-idempotent` の実質は、workflow、quality contract、repair bound、cleanupに反映した。`never-block-on-the-human` はYorishiroの人間確認方針と衝突するため採用しない。`benchmark-checklist` 全体や `blast-radius` 全体は未採用であり、採用済みとは主張しない。

### Agents / automations / harness

| 要素 | 状態 | 理由 |
|---|---|---|
| `poteto-agent` subagent | 未導入 | YorishiroはHerdrペインのWorker/Reviewerを使い、nested coding agentをspawnしない。 |
| `comment-sicko` subagent | 未導入 | read-only comment reviewはReviewerの任意の追加taskにできるが、専用agentは未導入。 |
| `automations/benny` | 未導入 | Cursor Automations専用。Slack triage、自動修復はYorishiroの外部操作確認方針と合わない。 |
| `docs/guide` 全体 | 未導入 | 必要な原則はworkflowとadoption docに要約。上流guideの逐語コピーはしない。 |
| Claude Code adapter / `harness/pstack` 生成物 | 未導入 | Pi/Herdr用の独自実装。plugin marketplace、`/plugin`、auto-updateを使わない。 |
| Bugbot / agentic security review | 未導入 | Cursor専用。YorishiroのReviewerと人間レビューで代替する。 |
| `control-cli` / `control-ui` | 未導入 | Cursor team kit。対象repoのverify Skillで代替する。 |
| PR shipping、autonomy、watchers、arena/swarm fleet | 未導入 | 外部可視操作、無制限並列、multi-model fallbackを既定にしない。 |

### 意図的に採用しなかった上流の既定

- **自動commit/push/PR/merge**: Yorishiroは明示指示と人間gateなしに実行しない。
- **外部操作の無確認**: 上流の広いautonomyではなく、Yorishiroの「不可逆・外部可視操作は確認」を維持する。
- **モデルの自動選択・fallback**: 固定Workerとread-only Reviewerを維持する。失敗は有限repair後にPlannerへ戻す。
- **runtimeでの上流取得・auto-update**: plugin marketplaceやremote script実行を組み込まない。
- **常時ロードされる大規模context**: 必要なSkillだけを明示`--skill`で子へ渡す。

## Yorishiro 側の実装対応表

| 機構 | file |
|---|---|
| 固定model・role | `extensions/development-pipeline/models.ts` |
| model guard | `extensions/development-pipeline/model-guard.ts` |
| 起動前auth/catalog確認 | `extensions/development-pipeline/model-preflight.ts` |
| child launcher、verify Skill探索、workflow brief | `extensions/development-pipeline/launcher.ts` |
| evidence回収 | `extensions/development-pipeline/verifier-tools.ts` |
| pipeline本体 | `extensions/development-pipeline/index.ts` |
| cleanup/reset互換 | `extensions/development-pipeline/cleanup.ts` |
| workflow Skill | `skills/development-workflow/` |
| verification Skill生成・保守 | `skills/create-verification-skill/`, `skills/maintain-verification-skill/` |
| Yorishiro自身のverify Skill（ローカル、非配布） | `.pi/skills/verify-yorishiro/` |

`.pi/skills/verify-yorishiro/` は repository-local のdogfood資産であり、`package.json`の`pi.skills`（`./skills`）には含まれない。他projectへgeneric配布しない。

## 既知の限界

- pstackの全Skill/playbook/principle/agent/automationと互換ではない。
- formal verificationとstatechartはdeferredであり、実装も検証も存在しない。
- model guardはPiのtool実行を守るが、敵対的Workerやnested shellのsecurity sandboxではない。
- verify-yorishiro helper自体は実Herdr+LLM pane起動を実行せず、pipelineの実runを証明しない。mocked pipeline testと実launcher/RPC proofを区別して報告する。
- 既存のopt-in `test:pipeline-layout-real-probe` はHerdr 0.7.3固定のassertを持ち、`npm test` の対象外。Herdr 0.9.5でのmanual smokeは別途証跡を保持しており、この古いprobeの成功を主張しない。
- 上流の更新を自動追従しない。revisionを固定して監査する。
