import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = path.join(root, ".pi", "skills", "verify-yorishiro", "scripts", "verify-yorishiro.mjs");
const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "yorishiro-verify-skill-evidence-"));

const invoke = (args, extraEnv = {}) => spawnSync(process.execPath, [helper, ...args], {
  cwd: root,
  encoding: "utf8",
  timeout: 60_000,
  env: { ...process.env, YORISHIRO_VERIFY_EVIDENCE_ROOT: evidenceRoot, PI_OFFLINE: "1", ...extraEnv },
});

try {
  const doctor = invoke(["doctor", "--json"]);
  assert.equal(doctor.status, 0, doctor.stderr);
  const doctorJson = JSON.parse(doctor.stdout);
  assert.ok(["ok", "degraded"].includes(doctorJson.status));
  assert.ok(doctorJson.checks.some(check => check.name === "launcher" && check.ok && check.required));
  assert.ok(doctorJson.checks.some(check => check.name === "verification-skill" && check.ok));
  assert.equal(existsSync(path.join(doctorJson.evidenceDir, "summary.json")), true);

  const blocked = invoke(["doctor", "--json"], { YORISHIRO_PI_BIN: path.join(evidenceRoot, "missing-pi") });
  assert.equal(blocked.status, 2, blocked.stderr);
  const blockedJson = JSON.parse(blocked.stdout);
  assert.equal(blockedJson.status, "blocked");
  assert.ok(blockedJson.checks.some(check => check.name === "pi" && !check.ok && check.required));

  const realPi = spawnSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).stdout.trim();
  // pi is a `#!/usr/bin/env node` script, so keep node resolvable while hiding herdr.
  const degraded = invoke(["doctor", "--json"], { YORISHIRO_PI_BIN: realPi, PATH: [path.dirname(realPi), path.dirname(process.execPath)].join(path.delimiter) });
  assert.equal(degraded.status, 0, degraded.stderr);
  const degradedJson = JSON.parse(degraded.stdout);
  assert.equal(degradedJson.status, "degraded");
  assert.ok(degradedJson.checks.some(check => check.name === "herdr" && !check.ok && !check.required));

  const drive = invoke(["drive", "launcher-rpc", "--json"]);
  assert.equal(drive.status, 0, drive.stderr);
  const driven = JSON.parse(drive.stdout);
  assert.equal(driven.status, "passed");
  assert.ok(driven.checks.find(check => check.name === "rpc response")?.ok);
  assert.match(driven.stdout, /"command":"get_state"/);
  assert.equal(existsSync(path.join(driven.evidenceDir, "command.json")), true);
  assert.equal(existsSync(path.join(driven.evidenceDir, "stdout.txt")), true);

  const cleanup = invoke(["cleanup", "--run", driven.evidenceDir, "--json"]);
  assert.equal(cleanup.status, 0, cleanup.stderr);
  const cleaned = JSON.parse(cleanup.stdout);
  assert.equal(cleaned.status, "ok");
  assert.equal(cleaned.evidenceRetained, true);
  const summary = JSON.parse(await readFile(path.join(driven.evidenceDir, "summary.json"), "utf8"));
  assert.equal(summary.cleanup.evidenceRetained, true);
  assert.equal(existsSync(path.join(driven.evidenceDir, "stdout.txt")), true, "cleanup must retain evidence");

  const outside = path.join(evidenceRoot, "..", "outside-run");
  await writeFile(outside, "outside");
  const rejected = invoke(["cleanup", "--run", outside]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /inside the verification evidence root/);
  await rm(outside, { force: true });

  // A symlinked ancestor must not turn an owned scratch fixture into an escape.
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "yorishiro-verify-outside-"));
  const outsideRun = path.join(outsideRoot, "run");
  await mkdir(path.join(outsideRun, ".scratch"), { recursive: true });
  await writeFile(path.join(outsideRun, ".scratch", "keep.txt"), "KEEP");
  await writeFile(path.join(outsideRun, "summary.json"), JSON.stringify({ marker: "OUTSIDE" }));
  await symlink(outsideRoot, path.join(evidenceRoot, "escape"));
  const escaped = invoke(["cleanup", "--run", path.join(evidenceRoot, "escape", "run")]);
  assert.notEqual(escaped.status, 0);
  assert.match(escaped.stderr, /inside the verification evidence root|canonical/);
  assert.equal(await readFile(path.join(outsideRun, ".scratch", "keep.txt"), "utf8"), "KEEP");
  assert.equal(JSON.parse(await readFile(path.join(outsideRun, "summary.json"), "utf8")).marker, "OUTSIDE");
  await rm(path.join(evidenceRoot, "escape"), { force: true });
  await rm(outsideRoot, { recursive: true, force: true });

  const unknown = invoke(["drive", "not-a-feature"]);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown feature/);

  assert.match(readFileSync(path.join(root, ".pi", "skills", "verify-yorishiro", "SKILL.md"), "utf8"), /## Helpers/);
} finally {
  await rm(evidenceRoot, { recursive: true, force: true });
}
console.log("generated verify-yorishiro helper real-entry test passed");
