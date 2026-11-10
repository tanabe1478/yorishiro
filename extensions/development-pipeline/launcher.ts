import * as fs from "node:fs/promises";
import * as path from "node:path";
import { INFO, MODELS, RUNTIME, type Stage } from "./models.ts";
import { renderInputFilesSection, type InputFilesReport } from "./input-files.ts";
import { repositoryDir } from "./repositories.ts";

export const WORKFLOW_NAMES = ["feature", "bug-fix", "refactoring"] as const;
export type WorkflowName = (typeof WORKFLOW_NAMES)[number];

export function isWorkflowName(value: unknown): value is WorkflowName {
  return typeof value === "string" && (WORKFLOW_NAMES as readonly string[]).includes(value);
}

export function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Where a Claude Worker writes evidence directly (YORISHIRO_EVIDENCE_DIR). The Reviewer's evidence goes to `evidence/reviewer/` and `evidence/quality-gate-N/`. */
export const WORKER_EVIDENCE_SUBDIR = "worker";

export function workerEvidenceDir(artifactDir: string) {
  return path.join(artifactDir, "evidence", WORKER_EVIDENCE_SUBDIR);
}

/**
 * Worker-only instructions of the Claude runtime, shared by the brief and the
 * prompt. The Worker has `run_verification_command` and a writable evidence
 * directory only there; Pi Workers have neither, so they are not told about them.
 */
export function workerToolingInstructions(artifactDir: string, attempt?: number, repositories?: string[]) {
  const evidence = workerEvidenceDir(artifactDir);
  const where = attempt === undefined ? `${evidence}/attempt-<n>/` : `${evidence}/attempt-${attempt}/`;
  return [
    "報告前に、qualityContractのrequiredChecksを`run_verification_command`（MCPツール。programとargsを渡す）で実行し、exit 0を確かめる。本番のquality gateと同じsnapshotとsandbox条件で実行されるので、gateで落ちる原因を報告前に見つけられる。APFS cloneやsandbox-execで検証用の複製や環境を手作りしない。",
    ...(repositories ? ["複数リポジトリのrunでは、requiredChecksの`cwd`（ワークスペース相対）があればそのcheckは`run_verification_command`の`cwd`引数に同じ値を渡して実行する。`cwd`なしのcheckは、cwdを渡さずワークスペースのルートで実行する。"] : []),
    `スクリーンショットや観測JSONなどの証跡は、環境変数\$YORISHIRO_EVIDENCE_DIR（${evidence}）の下の${where}に置く。orchestratorがartifactの一部として保存する。scratchpadやtempにだけ置かない。`,
  ];
}

async function isRegularFile(file: string) {
  try {
    return (await fs.lstat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Find project-local verification skills in the target checkout. Only real
 * `SKILL.md` files inside the checkout are returned; symlinked skill directories
 * are skipped so a target repository cannot redirect the child's skill load.
 */
export async function discoverVerifySkills(cwd: string): Promise<string[]> {
  const candidates: string[] = [];
  const canonicalCwd = await fs.realpath(cwd).catch(() => undefined);
  if (!canonicalCwd) return candidates;
  const isInside = (base: string, candidate: string) => {
    const relative = path.relative(base, candidate);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  for (const base of [path.join(cwd, ".pi", "skills"), path.join(cwd, ".agents", "skills")]) {
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.name.startsWith("verify-")) continue;
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const directory = path.join(base, entry.name);
      if (!(await isRegularFile(path.join(directory, "SKILL.md")))) continue;
      const canonicalBase = await fs.realpath(base).catch(() => undefined);
      const canonicalDirectory = await fs.realpath(directory).catch(() => undefined);
      if (!canonicalBase || !canonicalDirectory) continue;
      // A symlinked `.pi`, `.pi/skills`, or skill directory must not escape the
      // canonical checkout, even though it is canonically inside its own base.
      if (!isInside(canonicalCwd, canonicalDirectory) || !isInside(canonicalBase, canonicalDirectory)) continue;
      candidates.push(canonicalDirectory);
    }
  }
  return [...new Set(candidates)].sort();
}

/** Verify skills of every repository of a multi-repository run (the workspace root is not a repository). */
export async function discoverWorkspaceVerifySkills(cwd: string, repositories?: readonly string[]): Promise<string[]> {
  if (!repositories) return discoverVerifySkills(cwd);
  const found: string[] = [];
  for (const repository of repositories) found.push(...await discoverVerifySkills(repositoryDir(cwd, repository)));
  return [...new Set(found)].sort();
}

export type WorkflowBriefOptions = {
  artifactDir: string;
  cwd: string;
  workflow: WorkflowName;
  skillDir: string;
  playbookPath: string;
  verifySkills: string[];
  stage: Stage;
  /** External files copied into the artifact because the child cannot read their original location. */
  inputFiles?: InputFilesReport;
  /** Multi-repository run: cwd is the workspace root and these are the repositories (workspace-relative). */
  repositories?: string[];
};

export async function writeWorkflowBrief(options: WorkflowBriefOptions) {
  const file = path.join(options.artifactDir, `workflow-brief-${options.stage}.md`);
  const verify = options.verifySkills.length
    ? options.verifySkills.map(dir => `- ${path.join(dir, "SKILL.md")}\n- ${path.join(dir, "features", "README.md")}`).join("\n")
    : "- このcheckoutには project-local の `.pi/skills/verify-*/` はありません。対象の実ユーザー面を実行し、既存のharnessを優先してください。";
  const reviewerNote = options.stage === "review"
    ? "あなたはread-only Reviewerです。sourceを変更せず、verification SkillのLaunch/Doctor/Drive/Evidence/Cleanupに沿って独立検証してください。\n"
    : "あなたは編集を担当するWorkerです。計画の範囲だけを実装し、実ユーザー面の検証証跡を提出してください。\n";
  const writeBoundary = options.stage === "review"
    ? "Reviewerはsourceと対象checkoutを編集しない。`run_verification_command`などの検証commandはdisposable snapshot内だけに書き込み、元checkoutを変更しない。永続writeは`submit_stage_report`とorchestratorが回収する`YORISHIRO_EVIDENCE_DIR`に限る。"
    : "Workerは対象checkoutの承認済みpathを編集してよい。run artifactはorchestrator所有であり、指定されたreport以外を書き換えない。対象外pathや他repositoryへ書き込まない。";
  const workerTooling = options.stage === "implement" && RUNTIME === "claude"
    ? `## Workerの道具と証跡\n\n${workerToolingInstructions(options.artifactDir, undefined, options.repositories).map(line => `- ${line}`).join("\n")}\n\n`
    : "";
  const repositories = options.repositories;
  const hasVerifyTool = options.stage === "review" || RUNTIME === "claude";
  const repositoriesSection = repositories
    ? `\n## 対象リポジトリ\n\nこのrunは複数のgitリポジトリを扱う。cwdはワークスペースのルートで、対象は次のとおり（ワークスペース相対）。\n\n${repositories.map(repository => `- ${repository}（${repositoryDir(options.cwd, repository)}）`).join("\n")}\n\n- changedPathsとallowedPathPrefixesは、ワークスペース相対で書く（例: \`${repositories[0]}/src/index.ts\`）。リポジトリ内の相対pathでは照合されない。\n- 検証sandboxは上のリポジトリだけを、相対配置のまま複製する。\`../<別リポジトリ>\`の参照は解決できる。上に無いワークスペース配下は複製されず、そこへの書き込みは検出されない。\n${hasVerifyTool ? "- `run_verification_command`の`cwd`引数（任意、ワークスペース相対）で実行ディレクトリを指定する。省略するとワークスペースのルート。\n" : ""}`
    : "";
  const content = `# Child workflow brief

role: ${INFO[options.stage].label}
model: ${MODELS[options.stage]}
workflow: ${options.workflow}
target checkout: ${options.cwd}${repositories ? "（ワークスペースのルート）" : ""}

${reviewerNote}${repositoriesSection}
## 最初に必ず読むもの

- workflow Skill: ${path.join(options.skillDir, "SKILL.md")}
- playbook: ${options.playbookPath}
- このbrief: ${file}

skill自動探索は無効ですが、上記pathは明示的に読むこと。

## 対象checkoutのverification Skill（あれば）

${verify}

feature mapを読み、変更に対応するjourneyを実ユーザー面で実行する。存在しないcommandを捏造しない。実行できなかった場合は、試したcommandと未達の前提条件を証跡へ残す。

${renderInputFilesSection(options.inputFiles)}${workerTooling}## 必須の進め方

1. 関連codeを読み、domain/data shapeを選ぶ。
2. 最小の安全なscopeと成功条件を決める。
3. 実装する（Reviewerはread-onlyで確認する）。
4. 実ユーザー面で検証する。compilationだけを証拠にしない。
5. independent checkとread-only reviewを行う。
6. 証拠と限界を構造化reportへ書く。

## 書き込み境界

${writeBoundary}
共通: commit、push、PR作成、外部messageは行わない。秘密情報を保存しない。他者のsessionやペインへ介入しない。
`;
  await fs.writeFile(file, content, { encoding: "utf8", mode: 0o600 });
  return file;
}

export type LauncherOptions = {
  stage: Stage;
  name: string;
  promptFile: string;
  cwd: string;
  reportPath: string;
  artifactDir: string;
  root: string;
  workflowSkillDir: string;
  workflowPlaybook: string;
  workflowBrief: string;
  workflow: WorkflowName;
  verifySkills: string[];
  /** Multi-repository run: cwd is the workspace root and these are the repositories (workspace-relative). */
  repositories?: string[];
  piBin?: string;
  claudeBin?: string;
  nodeBin?: string;
};

type WriteLauncherOptions = LauncherOptions & { promptFileContent: string };

/**
 * Render the exact shell launcher for a child. Exported so tests can assert the
 * generated fixed model, guard, skills, and evidence contract without starting
 * a pane.
 */
export function renderLauncher(options: LauncherOptions): string {
  if (RUNTIME === "claude") return renderClaudeLauncher(options);
  const stage = options.stage;
  const role = INFO[stage].label;
  const schema = stage === "implement" ? "worker" : "reviewer";
  const reporter = path.join(options.root, "extensions", "development-pipeline", "stage-reporter.ts");
  const verifier = path.join(options.root, "extensions", "development-pipeline", "verifier-tools.ts");
  const guard = path.join(options.root, "extensions", "development-pipeline", "model-guard.ts");
  const piBin = options.piBin ?? process.env.YORISHIRO_PI_BIN ?? "pi";
  const extensions = [reporter, ...(stage === "review" ? [verifier] : []), guard];
  const skills = [options.workflowSkillDir, ...options.verifySkills];
  const exports = [
    `export YORISHIRO_REPORT_SCHEMA=${shellQuote(schema)}`,
    `export YORISHIRO_REPORT_STAGE=${shellQuote(stage)}`,
    `export YORISHIRO_ROLE=${shellQuote(role)}`,
    `export YORISHIRO_REPORT_PATH=${shellQuote(options.reportPath)}`,
    `export YORISHIRO_PROMPT_PATH=${shellQuote(options.promptFile)}`,
    `export YORISHIRO_MODEL_GUARD=${shellQuote("1")}`,
    `export YORISHIRO_EXPECTED_MODEL=${shellQuote(MODELS[stage])}`,
    `export YORISHIRO_GUARD_LOG=${shellQuote(path.join(options.artifactDir, "model-guard.log"))}`,
    `export YORISHIRO_EVIDENCE_ROOT=${shellQuote(path.join(options.artifactDir, "evidence"))}`,
    `export YORISHIRO_WORKFLOW=${shellQuote(options.workflow)}`,
    `export YORISHIRO_WORKFLOW_SKILL=${shellQuote(options.workflowSkillDir)}`,
    `export YORISHIRO_WORKFLOW_PLAYBOOK=${shellQuote(options.workflowPlaybook)}`,
    `export YORISHIRO_WORKFLOW_BRIEF=${shellQuote(options.workflowBrief)}`,
    ...(stage === "review" ? [`export YORISHIRO_TARGET_CWD=${shellQuote(options.cwd)}`, ...(options.repositories ? [`export YORISHIRO_TARGET_REPOSITORIES=${shellQuote(JSON.stringify(options.repositories))}`] : [])] : []),
  ].join("\n");
  const extensionArgs = extensions.map(file => ` -e ${shellQuote(file)}`).join("");
  const skillArgs = skills.map(dir => ` --skill ${shellQuote(dir)}`).join("");
  return `#!/bin/sh
set -eu
${exports}
prompt=$(cat -- ${shellQuote(options.promptFile)})
exec ${shellQuote(piBin)} --name ${shellQuote(options.name)} --model ${shellQuote(MODELS[stage])} --thinking ${shellQuote(INFO[stage].thinking)} --tools ${shellQuote(INFO[stage].tools)} --no-extensions --no-skills${extensionArgs}${skillArgs} "$prompt"
`;
}

export function claudeMcpConfigPath(options: Pick<LauncherOptions, "promptFile" | "stage">) {
  return path.join(path.dirname(options.promptFile), `${options.stage}-mcp.json`);
}

/** Tool names a Claude Code child sees from the stage-scoped Yorishiro MCP server. */
export function claudeMcpTools(_stage: Stage) {
  // Both roles verify in the same disposable snapshot and sandbox the quality gate uses. The Worker's original checkout stays writable; only the snapshot is.
  return ["submit_stage_report", "run_verification_command"];
}

/**
 * MCP server definition for one Claude Code child. The server runs the same
 * report validator and sandbox verifier as the Pi extensions, scoped by env.
 */
export function renderClaudeMcpConfig(options: LauncherOptions) {
  const stage = options.stage;
  const env: Record<string, string> = {
    YORISHIRO_RUNTIME: "claude",
    YORISHIRO_MCP_TOOLS: claudeMcpTools(stage).join(","),
    YORISHIRO_REPORT_SCHEMA: stage === "implement" ? "worker" : "reviewer",
    YORISHIRO_REPORT_STAGE: stage,
    YORISHIRO_ROLE: INFO[stage].label,
    YORISHIRO_REPORT_PATH: options.reportPath,
    YORISHIRO_EVIDENCE_ROOT: path.join(options.artifactDir, "evidence"),
    YORISHIRO_TARGET_CWD: options.cwd,
    ...(options.repositories ? { YORISHIRO_TARGET_REPOSITORIES: JSON.stringify(options.repositories) } : {}),
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  };
  const server = path.join(options.root, "extensions", "development-pipeline", "claude-mcp.mjs");
  return { mcpServers: { yorishiro: { type: "stdio", command: options.nodeBin ?? process.execPath, args: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", server], env } } };
}

/**
 * Claude Code child launcher. Variadic options (`--tools`, `--allowedTools`,
 * `--add-dir`) come first and single-value options last, so the positional
 * prompt is never consumed as an option value.
 */
/** Claude Code's idle timeout for a stdio MCP tool call (CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT); above the longest verification command (MAX_CHECK_TIMEOUT_MS). */
export const MCP_TOOL_IDLE_TIMEOUT_MS = 3_600_000;
export function renderClaudeLauncher(options: LauncherOptions): string {
  const stage = options.stage;
  const claudeBin = options.claudeBin ?? process.env.YORISHIRO_CLAUDE_BIN ?? "claude";
  const mcpTools = claudeMcpTools(stage).map(name => `mcp__yorishiro__${name}`);
  const allowed = stage === "implement" ? ["Bash", "Edit", "Write", ...mcpTools] : mcpTools;
  const dirs = [options.artifactDir, options.workflowSkillDir];
  const exports = [
    `export YORISHIRO_RUNTIME=${shellQuote("claude")}`,
    // Claude Code ends a stdio MCP tool call that is silent for 30 minutes (its default). One verification command may now run 30 minutes after its snapshot copy.
    `export CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=${shellQuote(String(MCP_TOOL_IDLE_TIMEOUT_MS))}`,
    // Claude Code moves an MCP call that runs over 120 s to the background and returns "moved to the background as task ...", so the child cannot wait for the result. 0 turns that off (read from the claude 2.1.322 binary; not documented).
    `export CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=${shellQuote("0")}`,
    `export YORISHIRO_REPORT_STAGE=${shellQuote(stage)}`,
    `export YORISHIRO_ROLE=${shellQuote(INFO[stage].label)}`,
    `export YORISHIRO_PROMPT_PATH=${shellQuote(options.promptFile)}`,
    `export YORISHIRO_EXPECTED_MODEL=${shellQuote(MODELS[stage])}`,
    `export YORISHIRO_WORKFLOW=${shellQuote(options.workflow)}`,
    `export YORISHIRO_WORKFLOW_BRIEF=${shellQuote(options.workflowBrief)}`,
    ...(stage === "implement" ? [`export YORISHIRO_EVIDENCE_DIR=${shellQuote(workerEvidenceDir(options.artifactDir))}`] : []),
  ].join("\n");
  // The Reviewer is read-only: --restricted drops code-running tools, ignores
  // settings files, and confines file tools to the working directories.
  const isolation = stage === "review" ? " --restricted" : ` --setting-sources ${shellQuote("project")}`;
  return `#!/bin/sh
set -eu
${exports}
prompt=$(cat -- ${shellQuote(options.promptFile)})
exec ${shellQuote(claudeBin)}${isolation} --strict-mcp-config --mcp-config ${shellQuote(claudeMcpConfigPath(options))} --permission-mode ${shellQuote("dontAsk")} --tools ${shellQuote(INFO[stage].tools)} --allowedTools ${shellQuote(allowed.join(","))} --add-dir ${dirs.map(shellQuote).join(" ")} --effort ${shellQuote(INFO[stage].thinking)} --name ${shellQuote(options.name)} --model ${shellQuote(MODELS[stage])} "$prompt"
`;
}

export async function writeLauncher(options: WriteLauncherOptions) {
  const promptFile = options.promptFile;
  const launcher = path.join(path.dirname(promptFile), `${options.stage}-launcher.sh`);
  await fs.writeFile(promptFile, options.promptFileContent, { encoding: "utf8", mode: 0o700 });
  let mcpConfig: string | undefined;
  if (RUNTIME === "claude") {
    if (options.stage === "implement") await fs.mkdir(workerEvidenceDir(options.artifactDir), { recursive: true });
    mcpConfig = claudeMcpConfigPath(options);
    await fs.writeFile(mcpConfig, JSON.stringify(renderClaudeMcpConfig(options), null, 2), { encoding: "utf8", mode: 0o600 });
  }
  await fs.writeFile(launcher, renderLauncher(options), { encoding: "utf8", mode: 0o700 });
  return { promptFile, launcher, ...(mcpConfig ? { mcpConfig } : {}) };
}
