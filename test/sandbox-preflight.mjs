import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const { preflightVerifierSandbox, darwinTargetRejection, verificationRoot } = await import("../extensions/development-pipeline/sandbox.ts");
const { runSandboxedVerification } = await import("../extensions/development-pipeline/verifier-tools.ts");
await assert.rejects(() => preflightVerifierSandbox("/tmp"), /does not support repositories under \/tmp/);

// A temporary directory inside the target (what the TMPDIR of a verification
// run is) must stop the run before any snapshot is made. Only the preflight and
// the entry point are called, so no sandbox is started and none is nested.
const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "yorishiro-preflight-")));
const originalTmpdir = process.env.TMPDIR;
try {
  const target = path.join(base, "target"), inner = path.join(target, ".yorishiro-tmp");
  await mkdir(inner, { recursive: true });
  process.env.TMPDIR = inner;
  await assert.rejects(() => preflightVerifierSandbox(target), /contains the temporary directory .*\.yorishiro-tmp is inside .*target/);
  process.env.TMPDIR = target;
  await assert.rejects(() => preflightVerifierSandbox(target), /contains the temporary directory/, "a temporary directory that is the target itself");
  process.env.TMPDIR = inner;
  await assert.rejects(() => runSandboxedVerification("/usr/bin/true", [], target, 5000), /contains the temporary directory/);
  assert.deepEqual(await readdir(inner), [], "no snapshot or other leftover is created in the temporary directory");
  assert.deepEqual((await readdir(target)).sort(), [".yorishiro-tmp"], "the target is not changed");
  // A temporary directory that only shares the name prefix of the target is outside it.
  const sibling = path.join(base, "target-tmp");
  await mkdir(sibling);
  process.env.TMPDIR = sibling;
  await assert.doesNotReject(() => preflightVerifierSandbox(target).catch(error => { if (/contains the temporary directory/.test(error.message)) throw error; }));
} finally {
  if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir;
  await rm(base, { recursive: true, force: true });
}

// macOS: targets under DARWIN_USER_TEMP_DIR or under the snapshot directory are rejected, as is a target that contains the snapshot directory.
// Pure decision on realpaths; nothing is created or started (the real-filesystem checks are in test:verifier-snapshot-root).
{
  const userTemp = "/private/var/folders/ab/cd/T", snapshots = "/Users/me/Library/Caches/yorishiro/verification";
  assert.match(darwinTargetRejection(`${userTemp}/repo`, userTemp, snapshots) ?? "", /under the macOS user temporary directory DARWIN_USER_TEMP_DIR/);
  assert.match(darwinTargetRejection(userTemp, userTemp, snapshots) ?? "", /DARWIN_USER_TEMP_DIR/, "the directory itself");
  assert.match(darwinTargetRejection(`${snapshots}/yorishiro-verification-x/workspace`, userTemp, snapshots) ?? "", /under the verification snapshot directory/);
  assert.match(darwinTargetRejection(snapshots, undefined, snapshots) ?? "", /under the verification snapshot directory/, "the directory itself, without a user temp directory");
  assert.match(darwinTargetRejection("/Users/me", userTemp, snapshots) ?? "", /contains the verification snapshot directory/);
  assert.doesNotMatch(darwinTargetRejection("/Users/me", userTemp, snapshots) ?? "", /contains the temporary directory/, "a different message from the TMPDIR check");
  assert.equal(darwinTargetRejection("/Users/me/work/repo", userTemp, snapshots), undefined);
  assert.equal(darwinTargetRejection(`${userTemp}-other/repo`, userTemp, snapshots), undefined, "a sibling that only shares the name prefix");
  assert.equal(darwinTargetRejection(`${snapshots}-other/repo`, userTemp, snapshots), undefined);
  assert.equal(darwinTargetRejection("/Users/me/work/repo", undefined, snapshots), undefined, "no user temp directory known: nothing to reject for it");
  // Where snapshots are made: a Yorishiro-only directory on macOS, tmpdir() elsewhere.
  if (process.platform === "darwin") assert.equal(verificationRoot(), path.join(os.homedir(), "Library", "Caches", "yorishiro", "verification"));
  else assert.equal(verificationRoot(), os.tmpdir());
}
console.log("sandbox target preflight test passed");
