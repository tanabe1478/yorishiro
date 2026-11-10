// 実 sandbox（runSandboxedVerification）で、macOS の snapshot の置き場と、別の snapshot への書き込み拒否を確かめる。
// sandbox を起動するので test:gate には入れない（test/gate-exclusions.json）。純粋な判定は test:sandbox-preflight が gate で確かめる。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
const { runSandboxedVerification, darwinUserTempDir } = await import("../extensions/development-pipeline/verifier-tools.ts");
const { preflightVerifierSandbox, preflightWorkspaceSandbox, verificationRoot } = await import("../extensions/development-pipeline/sandbox.ts");

if (process.platform !== "darwin") {
  console.log("skipped verifier snapshot root test: not macOS (Linux keeps snapshots under tmpdir())");
  process.exit(0);
}

const userTemp = darwinUserTempDir();
assert.ok(userTemp, "getconf DARWIN_USER_TEMP_DIR is available on macOS");
const snapshotRoot = verificationRoot();
assert.equal(snapshotRoot, path.join(os.homedir(), "Library", "Caches", "yorishiro", "verification"));
assert.notEqual(path.dirname(snapshotRoot), userTemp);

// 同時に走る 2 つの検証コマンド A と B。それぞれが自分の snapshot の場所を DARWIN_USER_TEMP_DIR（書ける）に置き、相手の場所が現れるのを待ってから、
// 相手の snapshot の作業ツリーと .yorishiro-evidence へ書こうとする。
const id = `${process.pid}-${Date.now()}`;
const tempFile = name => path.join(userTemp, `yorishiro-snapshot-root-${id}-${name}`);
const probe = `
const fs = require("node:fs");
const [me, other] = process.argv.slice(1);
const attempt = (file) => { try { fs.writeFileSync(file, "x"); return true; } catch { return false; } };
const mine = fs.realpathSync(process.cwd());
const userTemp = ${JSON.stringify(userTemp)};
const file = name => userTemp + "/yorishiro-snapshot-root-" + ${JSON.stringify(id)} + "-" + name;
fs.writeFileSync(file(me), JSON.stringify({ cwd: mine, evidence: process.env.YORISHIRO_EVIDENCE_DIR }));
const deadline = Date.now() + 60000;
while (!fs.existsSync(file(other)) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
const theirs = JSON.parse(fs.readFileSync(file(other), "utf8"));
const result = {
  cwd: mine,
  writeOwn: attempt(mine + "/own-write"),
  writeOtherWorkspace: attempt(theirs.cwd + "/cross-write"),
  writeOtherEvidence: attempt(theirs.evidence + "/cross-write"),
  writeUserTemp: attempt(file(me + "-written")),
};
process.stdout.write(JSON.stringify(result));
// 相手が書き終えるまで自分の snapshot を残す。
fs.writeFileSync(file(me + "-done"), "x");
while (!fs.existsSync(file(other + "-done")) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
`;
const before = new Set(existsSync(snapshotRoot) ? await readdir(snapshotRoot) : []);
try {
  const [a, b] = await Promise.all([
    runSandboxedVerification(process.execPath, ["-e", probe, "A", "B"], process.cwd(), 120_000),
    runSandboxedVerification(process.execPath, ["-e", probe, "B", "A"], process.cwd(), 120_000),
  ]);
  for (const result of [a, b]) assert.equal(result.code, 0, result.stdout + result.stderr);
  const seen = [a, b].map(result => JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))));
  const resolvedRoot = await realpath(snapshotRoot);
  for (const one of seen) {
    assert.ok(one.cwd.startsWith(`${resolvedRoot}${path.sep}yorishiro-verification-`), `the snapshot is under ${resolvedRoot}: ${one.cwd}`);
    assert.ok(!one.cwd.startsWith(`${userTemp}${path.sep}`), "the snapshot is not under DARWIN_USER_TEMP_DIR");
    assert.equal(one.writeOwn, true, "a command writes its own snapshot");
    assert.equal(one.writeOtherWorkspace, false, "a command cannot write another run's snapshot");
    assert.equal(one.writeOtherEvidence, false, "a command cannot write another run's .yorishiro-evidence");
    assert.equal(one.writeUserTemp, true, "DARWIN_USER_TEMP_DIR is still writable (HotSpot attach socket, Kotlin compiler alive file)");
  }
  assert.notEqual(seen[0].cwd, seen[1].cwd);
  assert.equal(((await stat(snapshotRoot)).mode & 0o777).toString(8), "700", "the snapshot directory is private to the user");
  const after = (await readdir(snapshotRoot)).filter(name => !before.has(name));
  assert.deepEqual(after, [], "snapshots are removed when the commands finish");
  for (const name of ["A", "B"]) assert.equal(existsSync(tempFile(`${name}-written`)), true);
} finally {
  for (const name of ["A", "B", "A-written", "B-written", "A-done", "B-done"]) await rm(tempFile(name), { force: true });
}

// preflight: DARWIN_USER_TEMP_DIR の下の対象は、TMPDIR が別の場所でも拒否される。snapshot の置き場の下の対象も拒否される。
const target = path.join(userTemp, `yorishiro-snapshot-root-target-${id}`);
const originalTmpdir = process.env.TMPDIR;
let createdSnapshotRoot = false;
try {
  await mkdir(target, { recursive: true });
  process.env.TMPDIR = "/private/var/tmp";
  assert.notEqual(await realpath(os.tmpdir()), userTemp, "TMPDIR differs from DARWIN_USER_TEMP_DIR in this scenario");
  await assert.rejects(() => preflightVerifierSandbox(target), /under the macOS user temporary directory DARWIN_USER_TEMP_DIR/);
  await assert.rejects(() => preflightWorkspaceSandbox(path.dirname(target), [path.basename(target)]), /DARWIN_USER_TEMP_DIR/, "each repository of a multi-repository run is checked");
  await assert.rejects(() => runSandboxedVerification("/usr/bin/true", [], target, 5000), /DARWIN_USER_TEMP_DIR/);
  assert.deepEqual(await readdir(target), [], "the rejected target is not changed");

  createdSnapshotRoot = !existsSync(snapshotRoot);
  const inside = path.join(snapshotRoot, `preflight-target-${id}`);
  await mkdir(inside, { recursive: true, mode: 0o700 });
  try {
    await assert.rejects(() => preflightVerifierSandbox(inside), /under the verification snapshot directory/);
    await assert.rejects(() => preflightVerifierSandbox(path.dirname(path.dirname(snapshotRoot))), /contains the verification snapshot directory/, "~/Library/Caches contains it");
  } finally { await rm(inside, { recursive: true, force: true }); }

  // 普通の対象（このチェックアウト）は通る。
  await assert.doesNotReject(() => preflightVerifierSandbox(process.cwd()));
} finally {
  if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir;
  await rm(target, { recursive: true, force: true });
  if (createdSnapshotRoot) await rm(snapshotRoot, { recursive: true, force: true });
}
console.log("verifier snapshot root test passed");
