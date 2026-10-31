import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
const { validateQualityContract, hashQualityContract, compareWorkerEvidence, pathsWithinPrefixes, captureFingerprintMap, changedPathsBetween, prefixHints, summarizeMismatchPaths, describeMismatchPaths } = await import("../extensions/development-pipeline/quality-contract.ts");
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

// Y7: prefixes match per path segment; a partial-string prefix is detected and a fix is suggested.
assert.deepEqual(pathsWithinPrefixes(["tsconfig.json", "tsconfig/base.json"], ["tsconfig"]), ["tsconfig.json"], "'tsconfig' does not match tsconfig.json");
assert.deepEqual(prefixHints(["tsconfig.json"], ["tsconfig", "src"]).length, 1);
assert.match(prefixHints(["tsconfig.json"], ["tsconfig"])[0], /パス区切り単位で照合します。tsconfig\.json を許可するなら 'tsconfig\.json' を明示してください/);
assert.deepEqual(prefixHints(["README.md"], ["tsconfig"]), [], "no hint when the path is not a string-prefix match");
assert.deepEqual(prefixHints(["tsconfig.json"], undefined), []);
assert.deepEqual(prefixHints(["tsconfig.json"], ["tsconfig/"]).length, 1, "a trailing slash does not change the hint");
{
  const contract = { ...valid, allowedPathPrefixes: ["tsconfig", "src"] };
  const report = { verdict: "COMPLETED", completedPlanItems: valid.planItems.map(item => ({ id: item.id, evidence: "確認" })), changedPaths: ["tsconfig.json", "src/a.ts"] };
  const result = compareWorkerEvidence(report, contract, ["tsconfig.json", "src/a.ts"]);
  assert.equal(result.valid, false);
  assert.deepEqual(result.outside, ["tsconfig.json"]);
  assert.equal(result.prefixHints.length, 1);
  assert.ok(result.errors.some(error => error.includes("'tsconfig.json' を明示してください")), "the suggestion is part of the errors");
  assert.equal(result.signature, "prefix:allowedPathPrefixes", "the hint must not change the signature");
  const fixed = compareWorkerEvidence(report, { ...contract, allowedPathPrefixes: ["tsconfig.json", "src"] }, ["tsconfig.json", "src/a.ts"]);
  assert.equal(fixed.valid, true, "following the suggestion makes the evidence valid");
}

// Y6: the repair finding names violating repository-relative paths, capped at 50 each, and nothing else.
{
  const many = Array.from({ length: 60 }, (_item, index) => `out/file-${String(index).padStart(2, "0")}.ts`);
  const summary = summarizeMismatchPaths({ outside: [...many, "/abs/leak.ts", "../up.ts"], missingPaths: ["src/missing.ts"], unknownPaths: ["src/ghost.ts"], prefixHints: [] });
  assert.equal(summary.outsidePaths.length, 50);
  assert.equal(summary.outsidePaths.includes("/abs/leak.ts"), false, "absolute paths are never included");
  assert.equal(summary.outsidePaths.includes("../up.ts"), false);
  assert.deepEqual(summary.missingPaths, ["src/missing.ts"]);
  assert.deepEqual(summary.unknownPaths, ["src/ghost.ts"]);
  assert.deepEqual(summary.omitted, { outsidePaths: 12 }, "truncation is reported, not silent");
  const text = describeMismatchPaths(summarizeMismatchPaths({ outside: ["tsconfig.json"], missingPaths: [], unknownPaths: ["x.ts"], prefixHints: prefixHints(["tsconfig.json"], ["tsconfig"]) }));
  assert.match(text, /prefix違反のpath: tsconfig\.json/);
  assert.match(text, /実diffに無いchangedPaths: x\.ts/);
  assert.match(text, /提案: prefixはパス区切り単位/);
  const mismatch = compareWorkerEvidence({ ...completed, changedPaths: ["src/ghost.ts"] }, valid, ["src/real.ts"]);
  assert.deepEqual(mismatch.missingPaths, ["src/real.ts"]);
  assert.deepEqual(mismatch.unknownPaths, ["src/ghost.ts"]);
}

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
