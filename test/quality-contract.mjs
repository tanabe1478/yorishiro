import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
const { validateQualityContract, hashQualityContract, compareWorkerEvidence, pathsWithinPrefixes, captureFingerprintMap, changedPathsBetween } = await import("../extensions/development-pipeline/quality-contract.ts");
const { validateWorkerReport } = await import("../extensions/development-pipeline/role-contracts.ts");

const valid = { planItems: [{ id: "IMPLEMENT", description: "実装する" }], requiredChecks: [{ id: "TEST", program: "/usr/bin/true", args: [], timeoutMs: 1000 }], allowedPathPrefixes: ["src"] };
assert.equal(validateQualityContract(valid).valid, true);
assert.equal(hashQualityContract(valid).length, 64);
for (const broken of [
  { ...valid, planItems: [] },
  { ...valid, planItems: [{ id: "A", description: "一" }, { id: "A", description: "二" }] },
  { ...valid, requiredChecks: [{ id: "A", program: "true", args: [] }, { id: "A", program: "true", args: [] }] },
  { ...valid, planItems: [{ id: "", description: "一" }] },
  { ...valid, allowedPathPrefixes: ["../src"] },
]) assert.equal(validateQualityContract(broken).valid, false);
assert.deepEqual(pathsWithinPrefixes(["src/a", "README.md"], ["src"]), ["README.md"]);

const completed = { verdict: "COMPLETED", completedPlanItems: [{ id: "IMPLEMENT", evidence: "実装を確認しました" }], changedPaths: ["src/a.ts"] };
assert.equal(compareWorkerEvidence(completed, valid, ["src/a.ts"]).valid, true);
for (const bad of [
  { ...completed, completedPlanItems: [] },
  { ...completed, completedPlanItems: [{ id: "UNKNOWN", evidence: "確認" }] },
  { ...completed, changedPaths: [] },
]) assert.equal(compareWorkerEvidence(bad, valid, ["src/a.ts"]).valid, false);
assert.equal(compareWorkerEvidence(completed, valid, ["README.md"]).valid, false);
const signatureA = compareWorkerEvidence({ ...completed, changedPaths: ["wrong-a.ts"] }, valid, ["src/a.ts"]).signature;
const signatureB = compareWorkerEvidence({ ...completed, changedPaths: ["wrong-b.ts"] }, valid, ["src/other.ts"]).signature;
assert.equal(signatureA, signatureB, "signature must not depend on full actual/reported paths");

const blockedSubset = { verdict: "BLOCKED", completedPlanItems: [], changedPaths: ["src/a.ts"] };
assert.equal(compareWorkerEvidence(blockedSubset, valid, ["src/a.ts"]).valid, true);
for (const bad of [
  { ...blockedSubset, completedPlanItems: [{ id: "UNKNOWN", evidence: "不明です" }] },
  { ...blockedSubset, changedPaths: ["src/fake.ts"] },
]) assert.equal(compareWorkerEvidence(bad, valid, ["src/a.ts"]).valid, false);
assert.equal(compareWorkerEvidence({ ...blockedSubset, changedPaths: ["README.md"] }, valid, ["README.md"]).valid, false);

const reportBase = { verdict: "COMPLETED", summary: "完了しました", changedScope: "変更しました", evidence: "確認しました", completedPlanItems: completed.completedPlanItems, changedPaths: [] };
assert.equal(validateWorkerReport(reportBase, valid).valid, true);
assert.equal(validateWorkerReport({ ...reportBase, verdict: "BLOCKED", completedPlanItems: [] }, valid).valid, true);
assert.equal(validateWorkerReport({ ...reportBase, verdict: "BLOCKED", completedPlanItems: [{ id: "UNKNOWN", evidence: "不明です" }] }, valid).valid, false);
for (const badPath of ["../escape", "/absolute", "C:/absolute", "a/../b"]) assert.equal(validateWorkerReport({ ...reportBase, changedPaths: [badPath] }).valid, false);

const run = (args, cwd) => new Promise((resolve, reject) => { const p = spawn("git", args, { cwd, stdio: "ignore" }); p.once("error", reject); p.once("close", code => code ? reject(new Error(`git ${args.join(" ")}=${code}`)) : resolve()); });
async function repository() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "yorishiro-quality-contract-"));
  await run(["init", "-q"], dir); await run(["config", "user.email", "test@example.invalid"], dir); await run(["config", "user.name", "test"], dir);
  await writeFile(path.join(dir, "tracked.txt"), "base\n"); await writeFile(path.join(dir, "move.txt"), "move\n"); await run(["add", "."], dir); await run(["commit", "-qm", "base"], dir);
  return dir;
}
async function fingerprintCase(expected, mutate, baselineDirty) {
  const dir = await repository();
  try {
    if (baselineDirty) await writeFile(path.join(dir, "tracked.txt"), "dirty baseline\n");
    const baseline = await captureFingerprintMap(dir);
    await mutate(dir);
    const changed = changedPathsBetween(baseline, await captureFingerprintMap(dir));
    assert.deepEqual(changed, expected);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
await fingerprintCase(["tracked.txt"], dir => writeFile(path.join(dir, "tracked.txt"), "dirty changed again\n"), true);
await fingerprintCase(["untracked.txt"], dir => writeFile(path.join(dir, "untracked.txt"), "new\n"));
await fingerprintCase(["tracked.txt"], dir => rm(path.join(dir, "tracked.txt")));
await fingerprintCase(["move.txt", "renamed.txt"], dir => run(["mv", "move.txt", "renamed.txt"], dir));
await fingerprintCase(["tracked.txt"], async dir => { await writeFile(path.join(dir, "tracked.txt"), "staged\n"); await run(["add", "tracked.txt"], dir); });
await fingerprintCase(["tracked.txt"], dir => writeFile(path.join(dir, "tracked.txt"), "unstaged\n"));
console.log("quality contract pure tests passed");
