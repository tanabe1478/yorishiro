import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { discoverVerifySkills, isWorkflowName, renderLauncher, writeLauncher, writeWorkflowBrief } = await import("../extensions/development-pipeline/launcher.ts");

assert.equal(isWorkflowName("feature"), true);
assert.equal(isWorkflowName("bug-fix"), true);
assert.equal(isWorkflowName("refactoring"), true);
assert.equal(isWorkflowName("other"), false);

const base = await mkdtemp(path.join(os.tmpdir(), "yorishiro-launcher-"));
try {
  const safeCwd = path.join(base, "safe");
  const safeSkill = path.join(safeCwd, ".pi", "skills", "verify-demo");
  await mkdir(path.join(safeSkill, "features"), { recursive: true });
  await writeFile(path.join(safeSkill, "SKILL.md"), "---\nname: verify-demo\ndescription: demo\n---\n# Demo\n");
  await writeFile(path.join(safeSkill, "features", "README.md"), "# Demo map\n");
  assert.deepEqual(await discoverVerifySkills(safeCwd), [safeSkill]);

  const outside = path.join(base, "outside");
  const outsideSkill = path.join(outside, ".pi", "skills", "verify-evil");
  await mkdir(outsideSkill, { recursive: true });
  await writeFile(path.join(outsideSkill, "SKILL.md"), "---\nname: verify-evil\ndescription: evil\n---\n");
  const symlinkRoot = path.join(base, "symlink-root");
  await mkdir(symlinkRoot, { recursive: true });
  await symlink(path.join(outside, ".pi"), path.join(symlinkRoot, ".pi"));
  assert.deepEqual(await discoverVerifySkills(symlinkRoot), [], "a symlinked .pi ancestor must not escape the checkout");

  const symlinkSkills = path.join(base, "symlink-skills");
  await mkdir(path.join(symlinkSkills, ".pi"), { recursive: true });
  await symlink(path.join(outside, ".pi", "skills"), path.join(symlinkSkills, ".pi", "skills"));
  assert.deepEqual(await discoverVerifySkills(symlinkSkills), [], "a symlinked .pi/skills ancestor must not escape the checkout");

  const symlinkEntry = path.join(base, "symlink-entry");
  await mkdir(path.join(symlinkEntry, ".pi", "skills"), { recursive: true });
  await symlink(outsideSkill, path.join(symlinkEntry, ".pi", "skills", "verify-evil"));
  assert.deepEqual(await discoverVerifySkills(symlinkEntry), [], "a symlinked verify skill directory is skipped");

  const artifactDir = path.join(base, "run");
  await mkdir(artifactDir);
  const skillDir = path.join(root, "skills", "development-workflow");
  const playbookPath = path.join(skillDir, "playbooks", "feature.md");
  const implementBrief = await writeWorkflowBrief({ artifactDir, cwd: safeCwd, workflow: "feature", skillDir, playbookPath, verifySkills: [safeSkill], stage: "implement" });
  const reviewBrief = await writeWorkflowBrief({ artifactDir, cwd: safeCwd, workflow: "feature", skillDir, playbookPath, verifySkills: [safeSkill], stage: "review" });
  assert.equal(path.basename(implementBrief), "workflow-brief-implement.md");
  assert.equal(path.basename(reviewBrief), "workflow-brief-review.md");
  assert.notEqual(implementBrief, reviewBrief);
  const implementText = await readFile(implementBrief, "utf8");
  const reviewText = await readFile(reviewBrief, "utf8");
  assert.match(implementText, /あなたは編集を担当するWorker/);
  assert.match(reviewText, /あなたはread-only Reviewer/);
  assert.doesNotMatch(reviewText, /あなたは編集を担当するWorker/);
  assert.match(implementText, /Workerは対象checkoutの承認済みpathを編集してよい/);
  assert.match(reviewText, /Reviewerはsourceと対象checkoutを編集しない/);
  assert.doesNotMatch(implementText, /sandbox外への書き込み/);
  assert.doesNotMatch(reviewText, /sandbox外への書き込み/);
  assert.match(implementText, /skill自動探索は無効/);
  assert.match(implementText, new RegExp(path.join(safeSkill, "features", "README.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const promptFile = path.join(artifactDir, "implement-prompt.md");
  const options = {
    stage: "implement",
    name: "Worker · DeepSeek",
    promptFile,
    promptFileContent: "日本語のprompt",
    cwd: safeCwd,
    reportPath: path.join(artifactDir, "implement-pending.json"),
    artifactDir,
    root,
    workflowSkillDir: skillDir,
    workflowPlaybook: playbookPath,
    workflowBrief: implementBrief,
    workflow: "feature",
    verifySkills: [safeSkill],
    piBin: "pi",
  };
  const worker = renderLauncher(options);
  assert.match(worker, /--model 'opencode-go\/deepseek-v4\.1-flash'/);
  assert.match(worker, /--thinking 'high'/);
  assert.match(worker, /--tools 'read,grep,find,ls,bash,edit,write,submit_stage_report'/);
  assert.match(worker, /--no-extensions --no-skills/);
  assert.match(worker, /--skill '.*skills\/development-workflow'/);
  assert.match(worker, new RegExp(`--skill '${safeSkill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
  assert.match(worker, /model-guard\.ts/);
  assert.match(worker, /YORISHIRO_MODEL_GUARD='1'/);
  assert.match(worker, /YORISHIRO_EXPECTED_MODEL='opencode-go\/deepseek-v4\.1-flash'/);
  assert.match(worker, /YORISHIRO_EVIDENCE_ROOT='/);
  assert.match(worker, /YORISHIRO_GUARD_LOG='/);
  assert.match(worker, /stage-reporter\.ts/);
  assert.doesNotMatch(worker, /verifier-tools\.ts/);
  assert.doesNotMatch(worker, /YORISHIRO_TARGET_CWD/);

  const reviewer = renderLauncher({ ...options, stage: "review", name: "Reviewer · Sol", promptFile: path.join(artifactDir, "review-prompt.md"), promptFileContent: "review", reportPath: path.join(artifactDir, "review-pending.json") });
  assert.match(reviewer, /--model 'openai\/gpt-5\.6-sol'/);
  assert.match(reviewer, /--thinking 'medium'/);
  assert.match(reviewer, /run_verification_command/);
  assert.match(reviewer, /verifier-tools\.ts/);
  assert.match(reviewer, /YORISHIRO_TARGET_CWD='/);

  const written = await writeLauncher(options);
  assert.match(await readFile(written.launcher, "utf8"), /--model 'opencode-go\/deepseek-v4\.1-flash'/);
  const syntax = spawnSync("sh", ["-n", written.launcher], { encoding: "utf8" });
  assert.equal(syntax.status, 0, `generated launcher must be valid POSIX shell: ${syntax.stderr}`);
  const mode = (await lstat(written.launcher)).mode & 0o777;
  assert.equal(mode, 0o700);
} finally {
  await rm(base, { recursive: true, force: true });
}
console.log("launcher contract and verify-skill discovery tests passed");
