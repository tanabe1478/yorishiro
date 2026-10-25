import * as fs from "node:fs/promises";
import * as path from "node:path";
import { INFO, MODELS, type Stage } from "./models.ts";

export const WORKFLOW_NAMES = ["feature", "bug-fix", "refactoring"] as const;
export type WorkflowName = (typeof WORKFLOW_NAMES)[number];

export function isWorkflowName(value: unknown): value is WorkflowName {
  return typeof value === "string" && (WORKFLOW_NAMES as readonly string[]).includes(value);
}

export function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
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

export type WorkflowBriefOptions = {
  artifactDir: string;
  cwd: string;
  workflow: WorkflowName;
  skillDir: string;
  playbookPath: string;
  verifySkills: string[];
  stage: Stage;
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
  const content = `# Child workflow brief

role: ${INFO[options.stage].label}
model: ${MODELS[options.stage]}
workflow: ${options.workflow}
target checkout: ${options.cwd}

${reviewerNote}
## 最初に必ず読むもの

- workflow Skill: ${path.join(options.skillDir, "SKILL.md")}
- playbook: ${options.playbookPath}
- このbrief: ${file}

skill自動探索は無効ですが、上記pathは明示的に読むこと。

## 対象checkoutのverification Skill（あれば）

${verify}

feature mapを読み、変更に対応するjourneyを実ユーザー面で実行する。存在しないcommandを捏造しない。実行できなかった場合は、試したcommandと未達の前提条件を証跡へ残す。

## 必須の進め方

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
  piBin?: string;
};

type WriteLauncherOptions = LauncherOptions & { promptFileContent: string };

/**
 * Render the exact shell launcher for a child. Exported so tests can assert the
 * generated fixed model, guard, skills, and evidence contract without starting
 * a pane.
 */
export function renderLauncher(options: LauncherOptions): string {
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
    ...(stage === "review" ? [`export YORISHIRO_TARGET_CWD=${shellQuote(options.cwd)}`] : []),
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

export async function writeLauncher(options: WriteLauncherOptions) {
  const promptFile = options.promptFile;
  const launcher = path.join(path.dirname(promptFile), `${options.stage}-launcher.sh`);
  await fs.writeFile(promptFile, options.promptFileContent, { encoding: "utf8", mode: 0o700 });
  await fs.writeFile(launcher, renderLauncher(options), { encoding: "utf8", mode: 0o700 });
  return { promptFile, launcher };
}
