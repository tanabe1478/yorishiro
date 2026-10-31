import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const { preflightVerifierSandbox } = await import("../extensions/development-pipeline/sandbox.ts");
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
console.log("sandbox target preflight test passed");
