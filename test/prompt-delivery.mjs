import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Follow-up prompt delivery (Claude runtime): file plus one-line pointer, submit
// confirmation, bounded Enter retries, and the dedicated failure. Also the
// Worker evidence inventory and the Pi runtime's unchanged prompt.
delete process.env.YORISHIRO_RUNTIME;
const {
  PROMPT_NOT_SUBMITTED, MAX_ENTER_RETRIES, SUBMIT_CONFIRM_WINDOW_MS, deliverPrompt, describePromptFailure, followUpInstruction, followUpPromptFile, indicatesSubmission, writeFollowUpPrompt,
} = await import("../extensions/development-pipeline/prompt-delivery.ts");
const { inventoryWorkerEvidence, workerEvidenceDir } = await import("../extensions/development-pipeline/worker-evidence.ts");
const { promptFor } = await import("../extensions/development-pipeline/index.ts");

const ok = { code: 0, stdout: "", stderr: "" };
/** A fake pane: `statusAt(ms since the first Enter)` decides what Herdr reports. */
function fakePane(statusAt, options = {}) {
  let clock = 0, firstEnterAt;
  const calls = [];
  const deps = {
    now: () => clock,
    sleep: async ms => { clock += ms; },
    sendText: async text => { calls.push(["text", text]); return options.textResult ?? ok; },
    sendEnter: async () => { calls.push(["enter", clock]); firstEnterAt ??= clock; return options.enterResult ?? ok; },
    readStatus: async () => statusAt(clock - (firstEnterAt ?? clock), calls.filter(call => call[0] === "enter").length),
    reportExists: () => options.reportAt !== undefined && clock >= options.reportAt,
    signal: options.signal,
  };
  return { deps, calls, clock: () => clock };
}

// Defaults are the values the plan asks for.
assert.equal(SUBMIT_CONFIRM_WINDOW_MS, 5000);
assert.equal(MAX_ENTER_RETRIES, 2);
assert.equal(PROMPT_NOT_SUBMITTED, "PROMPT_NOT_SUBMITTED");

// The pane becomes working right away: one Enter, no retry.
{
  const pane = fakePane(() => "working");
  const result = await deliverPrompt("指示", pane.deps);
  assert.equal(result.submitted, true);
  assert.equal(result.via, "status");
  assert.equal(result.enterPresses, 1);
  assert.deepEqual(pane.calls.map(call => call[0]), ["text", "enter"]);
}

// Idle after the first Enter, working after the second: exactly one resend.
{
  const pane = fakePane((_elapsed, enters) => (enters >= 2 ? "working" : "idle"));
  const result = await deliverPrompt("指示", pane.deps);
  assert.equal(result.submitted, true);
  assert.equal(result.enterPresses, 2);
  assert.deepEqual(pane.calls.map(call => call[0]), ["text", "enter", "enter"], "the text is sent once; only Enter is repeated");
  assert.ok(pane.calls[2][1] - pane.calls[1][1] >= SUBMIT_CONFIRM_WINDOW_MS, "the second Enter waits for the confirmation window");
}

// Idle throughout: first Enter plus two retries, then the dedicated failure.
{
  const pane = fakePane(() => "idle");
  const result = await deliverPrompt("指示", pane.deps);
  assert.equal(result.submitted, false);
  assert.equal(result.code, PROMPT_NOT_SUBMITTED);
  assert.equal(result.enterPresses, 1 + MAX_ENTER_RETRIES);
  assert.equal(result.lastStatus, "idle");
  assert.equal(pane.calls.filter(call => call[0] === "text").length, 1);
  assert.equal(pane.calls.filter(call => call[0] === "enter").length, 3);
  assert.ok(result.elapsedMs >= 3 * SUBMIT_CONFIRM_WINDOW_MS, "waits the full window after every Enter");
  const message = describePromptFailure("w1:p2", result, "/artifacts/run/review-prompt-2.md");
  assert.match(message, /^PROMPT_NOT_SUBMITTED: /);
  assert.ok(message.includes("w1:p2") && message.includes("/artifacts/run/review-prompt-2.md") && message.includes("idle") && message.includes("3回"));
}

// A status Herdr cannot read is not evidence of submission.
{
  const pane = fakePane(() => undefined);
  const result = await deliverPrompt("指示", pane.deps);
  assert.equal(result.submitted, false);
  assert.equal(result.lastStatus, undefined);
}
// `unknown` and `idle` do not count; working, blocked and a durable report do.
assert.deepEqual(["working", "blocked", "active", "idle", "unknown", "done", undefined].map(indicatesSubmission), [true, true, true, false, false, false, false]);
{
  const blocked = fakePane(() => "blocked");
  assert.equal((await deliverPrompt("指示", blocked.deps)).submitted, true, "a permission or trust dialog only appears after a submit");
  const reported = fakePane(() => "idle", { reportAt: 1000 });
  const result = await deliverPrompt("指示", reported.deps);
  assert.equal(result.submitted, true);
  assert.equal(result.via, "report");
}

// Herdr command failures are errors, not PROMPT_NOT_SUBMITTED.
await assert.rejects(deliverPrompt("指示", fakePane(() => "idle", { textResult: { code: 1, stdout: "", stderr: "no such pane" } }).deps), /Could not send prompt: no such pane/);
await assert.rejects(deliverPrompt("指示", fakePane(() => "idle", { enterResult: { code: 1, stdout: "", stderr: "pane gone" } }).deps), /Could not submit prompt: pane gone/);

// An abort during the wait ends the delivery without a failure verdict.
{
  const controller = new AbortController();
  const pane = fakePane(() => "idle", { signal: controller.signal });
  const original = pane.deps.sleep;
  pane.deps.sleep = async ms => { await original(ms); controller.abort(); };
  const result = await deliverPrompt("指示", pane.deps);
  assert.equal(result.submitted, false);
  assert.equal(result.aborted, true);
  assert.equal(pane.calls.filter(call => call[0] === "enter").length, 1);
}

const base = await mkdtemp(path.join(os.tmpdir(), "yorishiro-prompt-delivery-"));
try {
  // The long text goes to <stage>-prompt-<attempt>.md; the pane gets one short line.
  const artifactDir = path.join(base, "run");
  await mkdir(artifactDir, { recursive: true });
  const long = Array.from({ length: 200 }, (_, index) => `${index + 1}行目の指示。複数行の貼り付けになる長さです。`).join("\n");
  const written = await writeFollowUpPrompt(artifactDir, "review", 2, long);
  assert.equal(written.file, followUpPromptFile(artifactDir, "review", 2));
  assert.equal(path.basename(written.file), "review-prompt-2.md");
  assert.equal(await readFile(written.file, "utf8"), long, "the file holds the whole instruction");
  assert.equal((await stat(written.file)).mode & 0o777, 0o600);
  assert.equal(written.instruction, followUpInstruction(written.file));
  assert.equal(written.instruction.includes("\n"), false);
  assert.ok(written.instruction.length < 300, "the pointer stays short however long the instruction is");
  assert.ok(written.instruction.includes(written.file) && written.instruction.includes("最後まで読み"));
  assert.notEqual(path.basename(followUpPromptFile(artifactDir, "implement", 2)), "implement-prompt.md", "never overwrites the launcher's first prompt file");

  // Through the real herdr command plumbing: a fake `herdr` on PATH.
  const bin = path.join(base, "bin");
  await mkdir(bin, { recursive: true });
  const log = path.join(base, "herdr.log"), statusFile = path.join(base, "status");
  await writeFile(statusFile, "idle");
  await writeFile(path.join(bin, "herdr"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "pane get") printf '{"result":{"pane":{"pane_id":"%s","agent_status":"%s"}}}\\n' "$3" "$(cat "$FAKE_STATUS")" ;;
  "pane send-keys") if [ "$FAKE_ENTER_STARTS" = "$(grep -c 'send-keys' "$FAKE_LOG")" ]; then printf working > "$FAKE_STATUS"; fi ;;
esac
`);
  await chmod(path.join(bin, "herdr"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_LOG = log;
  process.env.FAKE_STATUS = statusFile;
  process.env.FAKE_ENTER_STARTS = "2";
  const { sendFollowUpPrompt } = await import("../extensions/development-pipeline/index.ts");
  const sent = await sendFollowUpPrompt("w1:p9", artifactDir, "implement", 3, long, path.join(artifactDir, "implement-pending.json"), undefined, { confirmWindowMs: 600, pollIntervalMs: 100, settleBeforeEnterMs: 10 });
  assert.equal(sent.result.submitted, true);
  assert.equal(sent.result.enterPresses, 2, "the first Enter was lost; the retry started the child");
  const lines = (await readFile(log, "utf8")).trim().split("\n");
  assert.equal(lines.filter(line => line.startsWith("pane send-text w1:p9 ")).length, 1);
  assert.equal(lines.find(line => line.startsWith("pane send-text")), `pane send-text w1:p9 ${sent.instruction}`);
  assert.equal(lines.filter(line => line === "pane send-keys w1:p9 enter").length, 2);
  assert.equal(await readFile(path.join(artifactDir, "implement-prompt-3.md"), "utf8"), long);

  // Same plumbing, Enter never taking effect.
  process.env.FAKE_ENTER_STARTS = "0";
  await writeFile(statusFile, "idle");
  await writeFile(log, "");
  const stuck = await sendFollowUpPrompt("w1:p9", artifactDir, "implement", 4, "短い指示", path.join(artifactDir, "implement-pending.json"), undefined, { confirmWindowMs: 300, pollIntervalMs: 100, settleBeforeEnterMs: 10 });
  assert.equal(stuck.result.submitted, false);
  assert.equal(stuck.result.enterPresses, 3);

  // Worker evidence: inventory only, same limits as the Reviewer's collection.
  const evidence = workerEvidenceDir(artifactDir);
  assert.equal(evidence, path.join(artifactDir, "evidence", "worker"));
  assert.deepEqual(await inventoryWorkerEvidence(artifactDir), { dir: "evidence/worker", files: [], bytes: 0, visited: 0, truncated: false, skipped: [], skippedCount: 0 }, "a missing directory is an empty inventory");
  await mkdir(path.join(evidence, "attempt-1"), { recursive: true });
  await writeFile(path.join(evidence, "attempt-1", "screen.png"), "png-bytes");
  await writeFile(path.join(evidence, "attempt-1", "observation.json"), "{}");
  await symlink("/etc/hosts", path.join(evidence, "attempt-1", "leak"));
  const inventory = await inventoryWorkerEvidence(artifactDir);
  assert.deepEqual(inventory.files.map(file => file.path).sort(), ["attempt-1/observation.json", "attempt-1/screen.png"]);
  assert.equal(inventory.bytes, "png-bytes".length + 2);
  assert.deepEqual(inventory.skipped, [{ path: "attempt-1/leak", reason: "symlink" }]);
  assert.equal(inventory.truncated, true, "a symlink makes the inventory incomplete");
  const capped = await inventoryWorkerEvidence(artifactDir, { maxFiles: 1 });
  assert.equal(capped.files.length, 1);
  assert.equal(capped.truncated, true);
  assert.ok(capped.skipped.some(item => item.reason === "file count limit"));
  assert.equal((await inventoryWorkerEvidence(artifactDir, { maxFileBytes: 3 })).files.length, 1, "the file size limit applies");
} finally {
  await rm(base, { recursive: true, force: true });
}

// The Pi runtime's Worker has neither run_verification_command nor an evidence directory, so its prompt does not mention them.
{
  const prompt = promptFor("implement", "依頼", "/artifacts/run", "計画", "", 1, "", "", "{}");
  assert.doesNotMatch(prompt, /run_verification_command|YORISHIRO_EVIDENCE_DIR/);
  assert.match(prompt, /submit_stage_report/);
}

console.log("prompt delivery, evidence inventory, and Pi prompt tests passed");
