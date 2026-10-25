import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifierModule = await import("../extensions/development-pipeline/verifier-tools.ts");
const { collectEvidence, runSandboxedVerification, EVIDENCE_LIMITS } = verifierModule;
const loadVerifier = verifierModule.default;
const { evidenceSegment } = await import("../extensions/development-pipeline/index.ts");

const base = await mkdtemp(path.join(os.tmpdir(), "yorishiro-evidence-"));

try {
  const outside = path.join(base, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.txt"), "DO-NOT-COPY");

  // A command can replace the evidence root with a symlink. It must be rejected
  // before realpath follows it.
  const symlinkSource = path.join(base, "symlink-source");
  await symlink(outside, symlinkSource);
  const symlinkDestination = path.join(base, "symlink-destination");
  const symlinkResult = await collectEvidence(symlinkSource, symlinkDestination);
  assert.equal(symlinkResult.status, "empty");
  assert.equal(symlinkResult.files.length, 0);
  assert.equal(existsSync(path.join(symlinkDestination, "secret.txt")), false);
  assert.ok(symlinkResult.skipped.some(item => /evidence root symlink rejected/.test(item.reason)));

  const fileSource = path.join(base, "file-source");
  await writeFile(fileSource, "not a directory");
  const fileResult = await collectEvidence(fileSource, path.join(base, "file-destination"));
  assert.equal(fileResult.files.length, 0);
  assert.ok(fileResult.skipped.some(item => /not a directory/.test(item.reason)));

  const childSource = path.join(base, "child-source");
  await mkdir(childSource, { recursive: true });
  await writeFile(path.join(childSource, "ok.txt"), "proof");
  await symlink("/etc/passwd", path.join(childSource, "passwd-link"));
  const childResult = await collectEvidence(childSource, path.join(base, "child-destination"));
  assert.deepEqual(childResult.files.map(file => file.path), ["ok.txt"]);
  assert.ok(childResult.skipped.some(item => /symlink rejected/.test(item.reason)));
  assert.equal(existsSync(path.join(base, "child-destination", "passwd-link")), false);

  // An existing destination subdirectory symlink must not redirect a copied file.
  const redirectSource = path.join(base, "redirect-source");
  await mkdir(path.join(redirectSource, "sub"), { recursive: true });
  await writeFile(path.join(redirectSource, "sub", "proof.txt"), "proof");
  const redirectDestination = path.join(base, "redirect-destination");
  const redirectOutside = path.join(base, "redirect-outside");
  await mkdir(redirectDestination, { recursive: true });
  await mkdir(redirectOutside, { recursive: true });
  await symlink(redirectOutside, path.join(redirectDestination, "sub"));
  const redirectResult = await collectEvidence(redirectSource, redirectDestination);
  assert.equal(redirectResult.files.length, 0);
  assert.equal(existsSync(path.join(redirectOutside, "proof.txt")), false);
  assert.ok(redirectResult.skipped.some(item => /destination/.test(item.reason)));

  const boundedSource = path.join(base, "bounded-source");
  await mkdir(boundedSource, { recursive: true });
  for (let index = 0; index < 20; index++) await writeFile(path.join(boundedSource, `proof-${index}.txt`), "x");
  const bounded = await collectEvidence(boundedSource, path.join(base, "bounded-destination"), { maxEntries: 5 });
  assert.ok(bounded.visited <= 5, `visited must stay bounded, got ${bounded.visited}`);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.skipped.some(item => /entry limit/.test(item.reason)));

  const skipSource = path.join(base, "skip-source");
  await mkdir(skipSource, { recursive: true });
  for (let index = 0; index < 12; index++) await symlink("/etc/passwd", path.join(skipSource, `link-${index}`));
  const skipped = await collectEvidence(skipSource, path.join(base, "skip-destination"), { maxSkippedDiagnostics: 3 });
  assert.equal(skipped.skipped.length, 3, "diagnostic array must be bounded");
  assert.ok(skipped.skippedCount >= 12);
  assert.equal(skipped.truncated, true);

  // End-to-end: evidence survives snapshot teardown on success and failure, and
  // a stale `.yorishiro-evidence` from the target is never preserved as proof.
  const checkout = path.join(root, "artifacts", `evidence-fixture-${process.pid}`);
  await rm(checkout, { recursive: true, force: true });
  await mkdir(path.join(checkout, ".yorishiro-evidence"), { recursive: true });
  await writeFile(path.join(checkout, ".yorishiro-evidence", "stale.txt"), "STALE");
  try {
    for (const [label, code] of [["success", 0], ["failure", 1]]) {
      const destination = path.join(base, `end-to-end-${label}`);
      const script = `const fs=require('node:fs'),path=require('node:path');const dir=process.env.YORISHIRO_EVIDENCE_DIR;fs.mkdirSync(path.join(dir,'nested'),{recursive:true});fs.writeFileSync(path.join(dir,'proof.txt'),'proof-${label}');fs.writeFileSync(path.join(dir,'nested','detail.txt'),'detail');process.exit(${code});`;
      const result = await runSandboxedVerification(process.execPath, ["-e", script], checkout, 10_000, undefined, { evidenceDir: destination });
      assert.equal(result.code, code);
      assert.equal(result.evidence.status, "collected", JSON.stringify(result.evidence));
      assert.deepEqual(result.evidence.files.map(file => file.path).sort(), ["nested/detail.txt", "proof.txt"]);
      assert.equal(existsSync(path.join(destination, "proof.txt")), true, `evidence must survive ${label} cleanup`);
      assert.equal(await readFile(path.join(destination, "proof.txt"), "utf8"), `proof-${label}`);
      assert.equal(existsSync(path.join(destination, "stale.txt")), false, "stale target evidence must not be preserved");
      assert.equal(existsSync(checkout + path.sep + ".yorishiro-evidence" + path.sep + "stale.txt"), true, "source checkout is untouched");
    }

    // Model-facing reviewer output must disclose skipped/incomplete evidence.
    const tools = [];
    loadVerifier({ registerTool(tool) { tools.push(tool); } });
    const reviewerRoot = path.join(base, "reviewer-evidence");
    process.env.YORISHIRO_TARGET_CWD = checkout;
    process.env.YORISHIRO_EVIDENCE_ROOT = reviewerRoot;
    try {
      const script = "const fs=require('node:fs'),path=require('node:path');const dir=process.env.YORISHIRO_EVIDENCE_DIR;fs.writeFileSync(path.join(dir,'proof.txt'),'proof');fs.symlinkSync('/etc/passwd',path.join(dir,'leak'));";
      const reviewerResult = await tools[0].execute("test", { program: process.execPath, args: ["-e", script], timeoutMs: 10_000 }, new AbortController().signal);
      assert.match(reviewerResult.content[0].text, /\[evidence 1 files; skipped=1; truncated=yes;/);
      assert.match(reviewerResult.content[0].text, /verification EXIT exit=0/);
      assert.equal(reviewerResult.details.evidenceIncomplete, true);
      assert.equal(reviewerResult.details.evidence.truncated, true);
      const runs = await readdir(path.join(reviewerRoot, "reviewer"));
      assert.equal(runs.length, 1);
      assert.equal(existsSync(path.join(reviewerRoot, "reviewer", runs[0], "proof.txt")), true);
      assert.equal(existsSync(path.join(reviewerRoot, "reviewer", runs[0], "leak")), false);
    } finally {
      delete process.env.YORISHIRO_TARGET_CWD;
      delete process.env.YORISHIRO_EVIDENCE_ROOT;
    }
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }

  assert.equal(EVIDENCE_LIMITS.maxFiles, 100);
  assert.notEqual(evidenceSegment("a/b", 0), evidenceSegment("a_b", 0), "colliding contracted IDs must not share an evidence directory");
  assert.notEqual(evidenceSegment("x".repeat(120), 0), evidenceSegment("x".repeat(121), 0));
  assert.notEqual(evidenceSegment("same", 0), evidenceSegment("same", 1));
} finally {
  await rm(base, { recursive: true, force: true });
}
console.log("bounded evidence persistence and rejection tests passed");
