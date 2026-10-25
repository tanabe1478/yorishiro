---
name: create-verification-skill
description: Generate a project-local verification Skill for any language or platform. Use when a project has no scripted way to prove CLI/TUI/web/API/library behavior, or when asked to create a verify Skill, feature map, or launch/drive/evidence harness.
license: MIT
---

# Create a verification Skill

実ユーザーが触るsurfaceを、agentが再現可能に起動・操作・証跡化できるproject-local Skillを生成します。生成物は`.pi/skills/verify-<project>/`へ置き、次に読むagentのために書きます。人間向けの説明資料ではありません。

## 実行主体（必須）

生成するSkill、feature map、harness、helperの**すべてのfile編集**は、固定モデル`opencode-go/deepseek-v4.1-flash`のWorkerへ委譲します。親modelが自分でfileを書きません。`development_pipeline`を使い、`workflow: "feature"`、生成対象path、成功条件、実行する検証を`qualityContract`へ入れます。read-only Reviewerは独立確認だけを行い、fileを書きません。

委譲環境が無い、または固定Workerを起動できない場合は、生成物を書かずに**blocked**として理由を報告します。親modelによる代筆は、このSkillの完了条件を満たしません。

## 1. repositoryをinterviewする

codebaseとdocsから答え、観測できないことだけ人間へ聞きます。

- **Surface:** ユーザーが実際に触るのはどれか。CLI/TUI、web UI、API、library、desktop、mobile。複数ある場合はprimaryを一つ選び、他は「secondary / not covered」と明記する。
- **Launch:** repo自身のdev command、package script、Makefile、README quickstartを使う。port、env var、seed data、migration、auth、起動完了のlog行を特定する。空のdata dirから使える状態まで到達する手順にする。
- **Drive:** 既存harnessを最優先する（test helper、PTY/expect、Playwright/Cypress、curl可能なendpoint、debug port）。無い場合だけ、PTY/tmux、HTTP、browser/CDPなどのgeneric recipeを選ぶ。推測のselectorや存在しないcommandを書かない。
- **Observe:** screenshot、terminal transcript、response body、log、exit code、DB/file stateのどれが証拠になるか。
- **Isolate:** 二つのinstanceを同時に起動できるか。port、data dir、profile、socketを分離できるか。できない場合は「同じ共有instanceを二重操作しない」と明記する。
- **Prerequisites:** OS、runtime、sandbox、credential、外部service。実行できない環境は隠さず書く。

checkoutがそのままbuild/startしない場合は、生成前に直すか、正確なblockerを報告します。壊れた土台の上に手順を書かない。

## 2. Skillを生成する

`.pi/skills/verify-<project>/SKILL.md`を作り、frontmatterに`name: verify-<project>`と、対象app・surface・使う場面が分かる`description`を書きます。

必ず次のsectionを、interviewで確認した実command・path・値で埋めます。placeholder、架空command、未知のtool名、未確認のflagは禁止です。

- **Launch:** 起動command、readyの判定（log行、prompt、portの所有者、health endpoint）、teardown。短命CLI/TUIは「build/installは一度、各driveはisolated PTY/tmuxで起動」と分ける。
- **Doctor:** read-onlyの健全性check。process、version/build、port所有者、auth、data dirが今回のrunのものか。怪しいときはdrive前に必ず実行する。
- **Drive:** 実repoのselector、command、route、prompt文字列を使う。座標やtab順より、ARIA label、data attribute、安定したprompt、route pathを優先する。
- **Evidence:** 何を、どこへ保存するか。actionと結果状態の両方、副作用（file、row、message、git ref）も確認する。mockはproduction境界が既に外部系を分離している箇所だけ。dry-run/test modeは「何をskipしたか」を観測して確認する。証跡は`artifacts/verify-<project>/<run-id>/`など、cleanupで消えない場所へ置く。
- **Cleanup:** このrunが起動したinstanceとscratch stateだけを片付ける。process名でkillしない。証跡は消さない。
- **Helpers:** Skillが同梱するscriptは実行可能にし、呼び出し方を本文に書く。読者が逆解析しないと使えないhelperは不可。

## 3. feature mapを作る

`.pi/skills/verify-<project>/features/README.md`と、user-facing featureごとのfileを3〜5件作ります。indexにはbaseline preconditions、driving convention、proof/skip reporting、feature entry contract、各featureへのlinkを書きます。

各feature fileはH1の後に、**この順序で4つのH2**だけを使います。

1. `Sub-features` — 短いIDと1行の振る舞い。
2. `How to get to it (user POV)` — ユーザーが到達できる全entry point。
3. `Driving it with <harness>` — `Preconditions:`で始め、ユーザーactionとexact command、観測できる結果を対応させる。
4. `Gotchas` — 検証を無効化する罠、共有state、待ち時間、前提の欠落。

feature fileには実装詳細ではなく、user path、安定したhandle、必要state、command、observable proofだけを書きます。seed dataが前提を満たさない場合、journeyを弱めず失敗として報告し、理由を`Gotchas`へ書きます。mapが複数entry pointを持つなら、都合のよい一つだけの検証では不十分です。

## 4. 生成物を実証してから渡す

生成したSkillの指示を一度、最後まで実行します。

1. Launch
2. Doctor
3. mapから**1つ以上のfeature**をDrive
4. Evidenceをcapture
5. Cleanup
6. cleanup後にEvidenceが指定場所に残っていることを確認

失敗したiterationでもcleanupを実行し、process/portを残しません。証跡がcleanupで消えるなら、そのSkillは不合格です。修正して再実行します。

実行できなかった場合は、**draft**または**blocked**と明記します。stand-in環境（container、別のlocal stack）で実証した場合は、targetでは未検証のsetup手順を列挙します。一度も実行していない生成物をdeliverableと呼ばない。

## 5. 保守へ渡す

生成後は`maintain-verification-skill`を案内します。cadenceを勝手に決めません。project-local Skillはこのrepositoryのgeneric `skills/` manifestとは別で、必要なら`.gitignore`や配布方針を確認します。

## 帰属

pstackの`create-verification-skill`（`cursor/plugins` revision `99b609a72323b70204eab407c622f436e858e112`、MIT、Copyright (c) 2026 Lauren Tan）をPi向けに再構成したものです。MIT全文は`../../docs/licenses/pstack-MIT.txt`。
