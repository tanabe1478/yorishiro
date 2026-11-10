import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The Pi runtime is what the brief and launcher assertions below describe; models.ts reads this at import time.
delete process.env.YORISHIRO_RUNTIME;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = name => path.join(root, "extensions", "development-pipeline", name);
const quality = await import(dir("quality-contract.ts"));
const repositoriesModule = await import(dir("repositories.ts"));
const launcher = await import(dir("launcher.ts"));
const trust = await import(dir("workspace-trust.ts"));
const gates = await import(dir("human-review-gates.ts"));
const pipeline = await import(dir("index.ts"));
const mcp = await import(dir("claude-mcp.mjs"));
const { parseRepositories, assertGitRoots, isWithinRepositories, repositoryArtifactName } = repositoriesModule;
const { validateQualityContract, hashQualityContract, canonicalQualityContract, qualityContractArtifact, captureFingerprintMap, captureWorkspaceFingerprintMap, changedPathsBetween, compareWorkerEvidence } = quality;

const git = (args, cwd) => new Promise((resolve, reject) => { const p = spawn("git", args, { cwd, stdio: "ignore" }); p.once("error", reject); p.once("close", code => code ? reject(new Error(`git ${args.join(" ")}=${code}`)) : resolve()); });
async function repository(workspace, name) {
  const target = path.join(workspace, name);
  await mkdir(path.join(target, "src"), { recursive: true });
  await git(["init", "-q"], target); await git(["config", "user.email", "test@example.invalid"], target); await git(["config", "user.name", "test"], target);
  await writeFile(path.join(target, "src", "index.ts"), `export const name = ${JSON.stringify(name)};\n`);
  await git(["add", "."], target); await git(["commit", "-qm", "base"], target);
  return target;
}

// (e) the shape of `repositories`
for (const good of [["api"], ["api", "backend"], ["apps/admin", "apps/api"], ["a", "a-b", "a_b"]]) assert.deepEqual(parseRepositories(good), { valid: true, value: good });
for (const [bad, reason] of [
  [undefined, "undefined"], [null, "null"], ["api", "a string"], [[], "empty"], [[1], "not a string"], [[""], "empty name"],
  [["/abs/api"], "absolute"], [["../api"], "parent"], [["api/../backend"], "inner parent"], [["."], "dot"], [["./api"], "leading dot"], [["api/"], "trailing slash"], [["api\\x"], "backslash"], [["C:/api"], "drive letter"],
  [["api", "api"], "duplicate"], [["api", "api/sub"], "nested"], [["api/sub", "api"], "nested, reversed order"],
]) assert.equal(parseRepositories(bad).valid, false, `repositories must reject ${reason}`);
assert.match(parseRepositories(["api", "api"]).error, /duplicates/);
assert.match(parseRepositories(["api", "api/sub"]).error, /nested/);
assert.equal(isWithinRepositories("backend/src", ["api", "backend"]), true);
assert.equal(isWithinRepositories("backend", ["api", "backend"]), true);
assert.equal(isWithinRepositories("backend-extra", ["api", "backend"]), false, "a string prefix is not a path prefix");
assert.equal(isWithinRepositories("other", ["api", "backend"]), false);
assert.equal(isWithinRepositories("api", undefined), false);
assert.notEqual(repositoryArtifactName("a/b"), repositoryArtifactName("a_b"), "colliding slugs stay apart");
assert.match(repositoryArtifactName("apps/admin"), /^apps__admin-[0-9a-f]{8}$/);

const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "yorishiro-multi-repo-")));
try {
  // The workspace root itself is not a git repository.
  const api = await repository(base, "api"), backend = await repository(base, "backend"), admin = await repository(path.join(base, "apps"), "admin");
  await mkdir(path.join(base, "plain"), { recursive: true });
  await writeFile(path.join(base, "file.txt"), "not a directory\n");
  await symlink(api, path.join(base, "link-to-api"));

  // (e) each repository must be a git root under cwd
  await assertGitRoots(base, ["api", "backend", "apps/admin"]);
  for (const [name, expected] of [["plain", /not inside a git work tree|not the root/], ["api/src", /not the root of a git work tree/], ["missing", /does not exist/], ["file.txt", /not a directory/], ["link-to-api", /symbolic link/], ["apps", /not inside a git work tree|not the root/]]) {
    await assert.rejects(() => assertGitRoots(base, [name]), expected, `${name} must be rejected`);
  }
  await assert.rejects(() => assertGitRoots(base, ["api", "plain"]), /plain/, "one bad entry rejects the list and names it");

  // (a) both repositories' changes appear with workspace-relative paths and do not mix
  const repositories = ["api", "backend"];
  const baseline = await captureWorkspaceFingerprintMap(base, repositories);
  assert.deepEqual(baseline, {}, "clean repositories have an empty fingerprint");
  await writeFile(path.join(api, "src", "index.ts"), "export const name = 'api changed';\n");
  assert.deepEqual(changedPathsBetween(baseline, await captureWorkspaceFingerprintMap(base, repositories)), ["api/src/index.ts"], "a change in one repository does not show up under the other, although both have src/index.ts");
  await writeFile(path.join(backend, "src", "index.ts"), "export const name = 'backend changed';\n");
  await writeFile(path.join(backend, "src", "new.ts"), "export {};\n");
  const after = await captureWorkspaceFingerprintMap(base, repositories);
  assert.deepEqual(changedPathsBetween(baseline, after), ["api/src/index.ts", "backend/src/index.ts", "backend/src/new.ts"]);
  assert.notEqual(after["api/src/index.ts"], after["backend/src/index.ts"]);
  assert.deepEqual(Object.keys(await captureWorkspaceFingerprintMap(base, ["backend"])).sort(), ["backend/src/index.ts", "backend/src/new.ts"], "only the listed repositories are fingerprinted");
  assert.deepEqual(await captureWorkspaceFingerprintMap(api), await captureFingerprintMap(api), "without repositories the fingerprint is the cwd's own, unchanged");
  assert.deepEqual(Object.keys(await captureWorkspaceFingerprintMap(api)), ["src/index.ts"], "and its paths are not prefixed");
  assert.deepEqual(changedPathsBetween(await captureWorkspaceFingerprintMap(base, ["apps/admin"]), await captureWorkspaceFingerprintMap(base, ["apps/admin"])), []);
  await writeFile(path.join(admin, "src", "index.ts"), "export const name = 'admin changed';\n");
  assert.deepEqual(changedPathsBetween({}, await captureWorkspaceFingerprintMap(base, ["apps/admin"])), ["apps/admin/src/index.ts"], "a nested repository path keeps its directory");

  // (b) allowedPathPrefixes are workspace-relative: a change outside them is a prefix violation
  const contract = { planItems: [{ id: "P", description: "実装する" }], requiredChecks: [{ id: "C", program: "/usr/bin/true", args: [] }], allowedPathPrefixes: ["api/src"] };
  const report = paths => ({ verdict: "COMPLETED", completedPlanItems: [{ id: "P", evidence: "確認した" }], changedPaths: paths });
  const actual = changedPathsBetween(baseline, after);
  const outside = compareWorkerEvidence(report(actual), contract, actual);
  assert.equal(outside.valid, false);
  assert.deepEqual(outside.outside, ["backend/src/index.ts", "backend/src/new.ts"]);
  assert.equal(outside.signature, "prefix:allowedPathPrefixes");
  assert.equal(compareWorkerEvidence(report(actual), { ...contract, allowedPathPrefixes: ["api/src", "backend/src"] }, actual).valid, true);
  assert.equal(compareWorkerEvidence(report(["api/src/index.ts"]), contract, ["api/src/index.ts"]).valid, true);
  assert.equal(compareWorkerEvidence(report(["src/index.ts"]), { ...contract, allowedPathPrefixes: ["src"] }, ["api/src/index.ts"]).valid, false, "a repository-relative prefix does not match a workspace-relative path");
  const missing = compareWorkerEvidence(report(["src/index.ts"]), { ...contract, allowedPathPrefixes: undefined }, ["api/src/index.ts"]);
  assert.deepEqual([missing.missingPaths, missing.unknownPaths], [["api/src/index.ts"], ["src/index.ts"]], "reporting repository-relative paths in a multi-repository run is a changedPaths mismatch");

  // (c) requiredChecks cwd
  const withCwd = cwd => ({ ...contract, requiredChecks: [{ id: "C", program: "/usr/bin/true", args: [], ...(cwd === undefined ? {} : { cwd }) }] });
  for (const cwd of ["backend", "api", "api/sub/dir", "apps/admin/src"]) assert.equal(validateQualityContract(withCwd(cwd), { repositories: ["api", "backend", "apps/admin"] }).valid, true, `cwd ${cwd} is accepted`);
  for (const cwd of ["../backend", "/abs/backend", "backend/../api", ".", "", "other", "backend-extra", "backend/", "apps", 1, null, undefined]) {
    const candidate = { ...contract, requiredChecks: [{ id: "C", program: "/usr/bin/true", args: [], cwd }] };
    assert.equal(validateQualityContract(candidate, { repositories: ["api", "backend", "apps/admin"] }).valid, false, `cwd ${JSON.stringify(cwd)} is rejected`);
  }
  const withoutRepositories = validateQualityContract(withCwd("backend"));
  assert.equal(withoutRepositories.valid, false, "cwd without repositories is a contract error");
  assert.match(withoutRepositories.error, /only allowed when the run has repositories/);
  assert.equal(validateQualityContract(withCwd("backend"), { repositories: undefined }).valid, false);
  assert.equal(validateQualityContract(withCwd(undefined)).valid, true, "a contract without cwd is valid with or without repositories");
  assert.equal(validateQualityContract(withCwd(undefined), { repositories: ["api"] }).valid, true);
  assert.equal(validateQualityContract({ ...contract, requiredChecks: [{ id: "C", program: "x", args: [], extra: 1 }] }, { repositories: ["api"] }).valid, false, "unknown check fields are still rejected");
  assert.equal(validateQualityContract({ ...contract, requiredChecks: [{ id: "C", program: "x", args: [], timeoutMs: 1000, cwd: "api" }] }, { repositories: ["api"] }).valid, true, "timeoutMs and cwd together");

  // (c) the hash covers cwd, and a contract without cwd hashes as before
  const hashed = cwd => hashQualityContract(withCwd(cwd));
  assert.notEqual(hashed("api"), hashed(undefined), "adding a cwd changes the hash");
  assert.notEqual(hashed("api"), hashed("backend"), "a different cwd changes the hash");
  assert.equal(hashed("api"), hashed("api"));
  assert.match(canonicalQualityContract(withCwd("api")), /"cwd":"api"/);
  const legacy = { planItems: contract.planItems, requiredChecks: [{ id: "C", program: "/usr/bin/true", args: [], timeoutMs: 1000 }, { id: "D", program: "/usr/bin/true", args: ["x"] }], allowedPathPrefixes: ["src/"] };
  const legacyCanonical = JSON.stringify({ planItems: [{ id: "P", description: "実装する" }], requiredChecks: [{ id: "C", program: "/usr/bin/true", args: [], timeoutMs: 1000 }, { id: "D", program: "/usr/bin/true", args: ["x"] }], allowedPathPrefixes: ["src"] });
  assert.equal(canonicalQualityContract(legacy), legacyCanonical, "the canonical form of a contract without cwd is unchanged");
  assert.equal(hashQualityContract(legacy), createHash("sha256").update(legacyCanonical, "utf8").digest("hex"));
  const artifact = qualityContractArtifact(withCwd("backend"));
  assert.equal(artifact.requiredChecks[0].cwd, "backend");
  assert.equal(artifact.contract.requiredChecks[0].cwd, "backend");
  assert.equal(artifact.sha256, hashed("backend"));

  // (d, the part that needs no sandbox) the verifier tool takes a cwd and the launchers pass the repositories
  const schema = mcp.inputSchema("run_verification_command");
  assert.equal(schema.properties.cwd.type, "string");
  assert.equal(schema.required.includes("cwd"), false, "cwd is optional for run_verification_command");
  assert.deepEqual(schema.required, ["program", "args"]);

  // (per-repo-aux) verify skills are discovered per repository
  const skill = path.join(backend, ".pi", "skills", "verify-backend");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: verify-backend\ndescription: demo\n---\n# Demo\n");
  const adminSkill = path.join(admin, ".agents", "skills", "verify-admin");
  await mkdir(adminSkill, { recursive: true });
  await writeFile(path.join(adminSkill, "SKILL.md"), "---\nname: verify-admin\ndescription: demo\n---\n# Demo\n");
  assert.deepEqual(await launcher.discoverWorkspaceVerifySkills(base, ["api", "backend", "apps/admin"]), [await realpath(adminSkill), await realpath(skill)].sort());
  assert.deepEqual(await launcher.discoverWorkspaceVerifySkills(base, ["api"]), [], "a repository without a verify skill contributes none");
  assert.deepEqual(await launcher.discoverWorkspaceVerifySkills(backend), [await realpath(skill)], "without repositories it is the cwd's own discovery");

  // (per-repo-aux) the brief names the repositories and the path convention; the single-repository brief is unchanged
  const artifactDir = path.join(base, "run"); await mkdir(artifactDir);
  const skillDir = path.join(root, "skills", "development-workflow"), playbookPath = path.join(skillDir, "playbooks", "feature.md");
  const brief = async (stage, extra) => readFile(await launcher.writeWorkflowBrief({ artifactDir, cwd: base, workflow: "feature", skillDir, playbookPath, verifySkills: [skill], stage, ...extra }), "utf8");
  for (const stage of ["implement", "review"]) {
    const multi = await brief(stage, { repositories: ["api", "backend"] });
    assert.match(multi, /^target checkout: .*（ワークスペースのルート）$/m);
    assert.match(multi, /## 対象リポジトリ/);
    assert.ok(multi.includes(`- api（${path.join(base, "api")}）`) && multi.includes(`- backend（${path.join(base, "backend")}）`));
    assert.match(multi, /changedPathsとallowedPathPrefixesは、ワークスペース相対で書く（例: `api\/src\/index\.ts`）/);
    assert.match(multi, /相対配置のまま複製する/);
    const single = await brief(stage, {});
    assert.doesNotMatch(single, /対象リポジトリ|ワークスペース/, `the single-repository ${stage} brief is unchanged`);
    assert.match(single, new RegExp(`^target checkout: ${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }
  assert.match(await brief("review", { repositories: ["api"] }), /`run_verification_command`の`cwd`引数/);
  assert.doesNotMatch(await brief("implement", { repositories: ["api"] }), /run_verification_command/, "a Pi Worker has no verification tool");
  assert.match(launcher.workerToolingInstructions(artifactDir, 1, ["api"]).join("\n"), /`cwd`引数に同じ値を渡して実行する/);
  assert.equal(launcher.workerToolingInstructions(artifactDir, 1).length, 2, "without repositories the Worker instructions are unchanged");

  // (per-repo-aux) the launchers hand the repositories to the verifier
  const launch = { name: "x", promptFile: path.join(artifactDir, "p.md"), cwd: base, reportPath: path.join(artifactDir, "r.json"), artifactDir, root, workflowSkillDir: skillDir, workflowPlaybook: playbookPath, workflowBrief: path.join(artifactDir, "b.md"), workflow: "feature", verifySkills: [] };
  assert.match(launcher.renderLauncher({ ...launch, stage: "review", repositories: ["api", "backend"] }), /export YORISHIRO_TARGET_REPOSITORIES='\["api","backend"\]'/);
  assert.doesNotMatch(launcher.renderLauncher({ ...launch, stage: "review" }), /YORISHIRO_TARGET_REPOSITORIES/);
  assert.doesNotMatch(launcher.renderLauncher({ ...launch, stage: "implement", repositories: ["api"] }), /YORISHIRO_TARGET_REPOSITORIES/, "the Pi Worker has no verifier");
  for (const stage of ["implement", "review"]) {
    assert.equal(launcher.renderClaudeMcpConfig({ ...launch, stage, repositories: ["api", "backend"] }).mcpServers.yorishiro.env.YORISHIRO_TARGET_REPOSITORIES, '["api","backend"]');
    assert.equal(launcher.renderClaudeMcpConfig({ ...launch, stage }).mcpServers.yorishiro.env.YORISHIRO_TARGET_REPOSITORIES, undefined);
    assert.equal(launcher.renderClaudeMcpConfig({ ...launch, stage, repositories: ["api"] }).mcpServers.yorishiro.env.YORISHIRO_TARGET_CWD, base);
  }

  // (per-repo-aux) the prompts name the repositories and the per-repository snapshot files
  const files = name => repositories.map(repo => [`${name}-${repositoryArtifactName(repo)}-status.txt`, `${name}-${repositoryArtifactName(repo)}-diff.patch`]).flat();
  const reviewPrompt = pipeline.promptFor("review", "t", artifactDir, "plan", "", 1, "", "", "{}", "", "", 1, repositories);
  for (const file of [...files("implement-1"), ...files("baseline"), "implement-1-fingerprint.json", "baseline-fingerprint.json"]) assert.ok(reviewPrompt.includes(path.join(artifactDir, "diffs", file)), `${file} is named in the multi-repository review prompt`);
  assert.doesNotMatch(reviewPrompt, /diffs\/implement-1-status\.txt/);
  assert.match(reviewPrompt, /複数リポジトリのrunです。.*api、backend.*ワークスペース相対pathで書きます/);
  assert.match(pipeline.promptFor("implement", "t", artifactDir, "plan", "", 1, "", "", "{}", "", "", 1, repositories), /複数リポジトリのrunです/);
  const singlePrompt = pipeline.promptFor("review", "t", artifactDir, "plan", "", 1, "", "", "{}", "", "", 1);
  for (const file of ["implement-1-status.txt", "implement-1-diff.patch", "implement-1-fingerprint.json", "baseline-status.txt", "baseline-diff.patch", "baseline-fingerprint.json"]) assert.ok(singlePrompt.includes(path.join(artifactDir, "diffs", file)), `${file} is named in the single-repository review prompt`);
  assert.doesNotMatch(singlePrompt, /複数リポジトリ/);

  // (per-repo-aux) workspace trust is checked for each repository
  const stateFile = path.join(base, "claude.json");
  await writeFile(stateFile, JSON.stringify({ projects: { [api]: { hasTrustDialogAccepted: true } } }));
  const checked = await trust.checkRepositoriesTrust(base, ["api", "backend"], { stateFile, gitCeiling: base });
  assert.deepEqual(checked.map(item => [item.repository, item.status]), [["api", "trusted"], ["backend", "untrusted"]]);
  assert.equal(checked[0].checkedDir, api);

  // (per-repo-aux) diffai runs once per repository, in order, with --cwd <repository>
  const decision = (value, feedback) => ({ code: 0, stdout: `log\nDIFFAI_REVIEW_RESULT=${JSON.stringify({ decision: value, ...(feedback ? { feedback } : {}) })}\n` });
  const runGate = async (answers, extra = {}) => {
    const calls = [];
    const result = await gates.reviewRepositoryDiffs({ mode: "required", cwd: base, repositories: ["api", "backend"], exec: async (command, args, cwd) => { calls.push({ command, args, cwd }); return answers[calls.length - 1] ?? decision("approved"); }, ...extra });
    return { result, calls };
  };
  {
    const { result, calls } = await runGate([]);
    assert.equal(result.decision, "approved");
    assert.deepEqual(calls.map(call => call.args), [["--yes", "github:tanabe1478/diffai", "--cwd", api], ["--yes", "github:tanabe1478/diffai", "--cwd", backend]]);
    assert.deepEqual(calls.map(call => call.cwd), [api, backend], "the process also starts in the repository");
    assert.deepEqual(result.repositories.map(item => [item.repository, item.decision]), [["api", "approved"], ["backend", "approved"]]);
  }
  {
    const { result, calls } = await runGate([decision("approved"), decision("changes_requested", "契約が食い違う")]);
    assert.equal(result.decision, "changes_requested");
    assert.equal(result.feedback, "[backend] 契約が食い違う");
    assert.equal(calls.length, 2);
  }
  {
    const { result, calls } = await runGate([decision("changes_requested", "直す")]);
    assert.equal(result.decision, "changes_requested");
    assert.equal(calls.length, 1, "later repositories are not reviewed after a change request");
  }
  {
    let asked = 0;
    const { result, calls } = await runGate([], { mode: "ask", confirm: async () => { asked++; return true; } });
    assert.equal(result.decision, "approved");
    assert.equal(asked, 1, "the human is asked once, not once per repository");
    assert.equal(calls.length, 2);
  }
  {
    const { result, calls } = await runGate([], { mode: "skip" });
    assert.equal(result.decision, "skipped");
    assert.equal(calls.length, 0);
  }
  {
    const { result } = await runGate([{ code: 1, stdout: "", stderr: "boom" }]);
    assert.equal(result.decision, "unavailable");
    assert.match(result.error, /^\[api\] boom/);
  }
} finally {
  await rm(base, { recursive: true, force: true });
}
console.log("multi-repository tests passed");
