import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetRun, cleanupRun, verifyLivePane } from "../extensions/development-pipeline/cleanup.ts";

const base = await mkdtemp(path.join(os.tmpdir(), "yorishiro-reset-"));
const artifacts = path.join(base, "artifacts"), bin = path.join(base, "bin"), log = path.join(base, "herdr.log");
await mkdir(artifacts); await mkdir(bin); await writeFile(log, "");
const herdr = path.join(bin, "herdr");
await writeFile(herdr, `#!/bin/sh
printf '%s\\n' "$*" >> "$RESET_HERDR_LOG"
if [ "$1" = pane ] && [ "$2" = get ]; then
  case "$3" in
    t-nolabel) printf '{"result":{"pane":{"workspace_id":"ws","tab_id":"tab","terminal_id":"term_nolabel","agent_status":"idle"}}}\\n'; exit 0;;
    t-relabel) printf '{"result":{"pane":{"workspace_id":"ws","tab_id":"tab","terminal_id":"term_relabel","label":"OSC title","agent_status":"idle"}}}\\n'; exit 0;;
    t-swapped) printf '{"result":{"pane":{"workspace_id":"ws","tab_id":"tab","terminal_id":"term_someone_else","label":"Worker · Claude","agent_status":"idle"}}}\\n'; exit 0;;
    t-busy) printf '{"result":{"pane":{"workspace_id":"ws","tab_id":"tab","terminal_id":"term_busy","agent_status":"working"}}}\\n'; exit 0;;
    t-otherws) printf '{"result":{"pane":{"workspace_id":"other","tab_id":"tab","terminal_id":"term_otherws","agent_status":"idle"}}}\\n'; exit 0;;
    t-noterminal) printf '{"result":{"pane":{"workspace_id":"ws","tab_id":"tab","label":"Worker · Claude","agent_status":"idle"}}}\\n'; exit 0;;
  esac
  case "$3" in worker) name='Worker · Luna';; deepseek) name='Worker · DeepSeek';; reviewer) name='Reviewer · Sol';; *) name="$3";; esac
  printf '{"workspace_id":"ws","tab_id":"tab","name":"%s","agent_status":"idle"}\\n' "$name"
fi
`);
await chmod(herdr, 0o755);
const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`; process.env.RESET_HERDR_LOG = log;
const finishedAt = "2026-01-01T00:00:00.000Z";
const make = async (name, overrides = {}) => {
  const dir = path.join(artifacts, name); await mkdir(dir);
  await writeFile(path.join(dir, "run.json"), JSON.stringify({ outcome: "ABORTED", finishedAt, parentPaneId: "parent", workspaceId: "ws", tabId: "tab", panes: [{ paneId: "worker", name: "Worker · Luna" }], ...overrides }));
  return dir;
};
const context = { paneId: "parent", workspaceId: "ws", tabId: "tab" };
const closeCount = async () => (await readFile(log, "utf8")).split("\n").filter(line => line.startsWith("pane close ")).length;
const rejectsWithoutClose = async (name, overrides, current = context) => {
  await writeFile(log, ""); const dir = await make(name, overrides);
  await assert.rejects(() => resetRun(dir, artifacts, current, true));
  assert.equal(await closeCount(), 0, `${name} must dispatch no close`);
};
try {
  for (const outcome of ["IMPLEMENTATION_FAILED", "WORKER_EVIDENCE_MISMATCH", "QUALITY_GATE_FAILED", "ABORTED", "REVIEW_FAILED", "NEEDS_PLANNER", "HUMAN_CHANGES_REQUESTED"]) {
    await writeFile(log, ""); const dir = await make(`valid-${outcome}`, { outcome });
    const result = await resetRun(dir, artifacts, context, true); assert.equal(result.results[0].status, "closed");
  }
  await writeFile(log, ""); const current = await make("valid-current", { panes: [{ paneId: "deepseek", name: "Worker · DeepSeek" }, { paneId: "reviewer", name: "Reviewer · Sol" }] });
  const currentResult = await resetRun(current, artifacts, context, true);
  assert.deepEqual(currentResult.results.map(result => result.status), ["closed", "closed"]);
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n").filter(line => line.startsWith("pane close ")), ["pane close reviewer", "pane close deepseek"]);
  await rejectsWithoutClose("success", { outcome: "SUCCESS" });
  await rejectsWithoutClose("noncanonical", { outcome: "TOTALLY_FAILED" });
  await rejectsWithoutClose("unfinished", { finishedAt: undefined });
  await rejectsWithoutClose("missing-run-identity", { workspaceId: "" });
  await rejectsWithoutClose("missing-current-identity", {}, { paneId: "parent", workspaceId: undefined, tabId: "tab" });
  await rejectsWithoutClose("wrong-current-pane", {}, { paneId: "other", workspaceId: "ws", tabId: "tab" });
  await rejectsWithoutClose("duplicate-role", { panes: [{ paneId: "worker", name: "Worker · Luna" }, { paneId: "worker-2", name: "Worker · Luna" }] });
  await rejectsWithoutClose("duplicate-pane-id", { panes: [{ paneId: "same", name: "Worker · Luna" }, { paneId: "same", name: "Reviewer · Sol" }] });
  await rejectsWithoutClose("missing-pane-id", { panes: [{ paneId: "", name: "Worker · Luna" }] });
  // Y3: a pane that failed before it settled was never renamed, so Herdr returns no label. The recorded terminal_id is the identity.
  const claudePane = (paneId, terminalId) => ({ paneId, terminalId, name: "Worker · Claude" });
  const resetOne = async (name, pane, overrides = {}) => { await writeFile(log, ""); const dir = await make(name, { panes: [pane], ...overrides }); const result = await resetRun(dir, artifacts, context, true); return { result: result.results[0], closes: await closeCount(), run: JSON.parse(await readFile(path.join(dir, "run.json"), "utf8")) }; };
  {
    const unlabeled = await resetOne("terminal-nolabel", claudePane("t-nolabel", "term_nolabel"));
    assert.equal(unlabeled.result.status, "closed", "an unlabeled pane with the recorded terminal_id is closed");
    assert.equal(unlabeled.closes, 1);
    assert.match(unlabeled.result.note, /表示名が記録と異なります/);
    assert.equal(unlabeled.run.reset.status, "completed");
    const relabeled = await resetOne("terminal-relabel", claudePane("t-relabel", "term_relabel"));
    assert.equal(relabeled.result.status, "closed", "a changed display name does not block the close");
    assert.match(relabeled.result.note, /OSC title/, "the mismatch is recorded");
    const swapped = await resetOne("terminal-swapped", claudePane("t-swapped", "term_original"));
    assert.equal(swapped.result.status, "skipped", "a different terminal_id is a different pane even when the label matches");
    assert.equal(swapped.result.reason, "pane identity changed or incomplete");
    assert.equal(swapped.closes, 0);
    const otherWorkspace = await resetOne("terminal-otherws", claudePane("t-otherws", "term_otherws"));
    assert.equal(otherWorkspace.result.status, "skipped", "workspace/tab must still match");
    assert.equal(otherWorkspace.closes, 0);
    const busy = await resetOne("terminal-busy", claudePane("t-busy", "term_busy"));
    assert.equal(busy.result.status, "skipped");
    assert.equal(busy.result.reason, "pane is working", "the idle/done condition is kept");
    assert.equal(busy.closes, 0);
    const missingTerminal = await resetOne("terminal-live-missing", claudePane("t-noterminal", "term_recorded"));
    assert.equal(missingTerminal.result.status, "skipped", "a recorded terminal_id the live pane does not report is not an identity");
    assert.equal(missingTerminal.closes, 0);
    // A run.json from before terminalId existed keeps the label comparison.
    const legacyNoLabel = await resetOne("legacy-nolabel", { paneId: "t-nolabel", name: "Worker · Claude" });
    assert.equal(legacyNoLabel.result.status, "skipped", "legacy records with no live label stay skipped");
    assert.equal(legacyNoLabel.closes, 0);
    const legacyLabeled = await resetOne("legacy-labeled", { paneId: "t-noterminal", name: "Worker · Claude" });
    assert.equal(legacyLabeled.result.status, "closed", "legacy records still close on a matching label");
    assert.equal(legacyLabeled.result.note, undefined);
    // Pure decision table.
    const expected = { workspaceId: "ws", tabId: "tab" };
    const live = { workspace_id: "ws", tab_id: "tab", terminal_id: "T", agent_status: "idle" };
    assert.deepEqual(verifyLivePane(live, { terminalId: "T", name: "N" }, expected).ok, true);
    assert.deepEqual(verifyLivePane({ ...live, label: "N" }, { terminalId: "T", name: "N" }, expected), { ok: true });
    assert.deepEqual(verifyLivePane(live, { terminalId: "X", name: "N" }, expected), { ok: false, reason: "changed" });
    assert.deepEqual(verifyLivePane({ ...live, label: "N" }, { name: "N" }, expected), { ok: true });
    assert.deepEqual(verifyLivePane(live, { name: "N" }, expected), { ok: false, reason: "incomplete" });
    // Success cleanup uses the same identity.
    await writeFile(log, "");
    const cleanupDir = path.join(artifacts, "cleanup-terminal"); await mkdir(cleanupDir);
    await writeFile(path.join(cleanupDir, "run.json"), JSON.stringify({ outcome: "SUCCESS", parentPaneId: "parent", workspaceId: "ws", tabId: "tab", panes: [claudePane("t-nolabel", "term_nolabel")] }));
    const cleaned = await cleanupRun(cleanupDir, artifacts, "parent");
    assert.equal(cleaned.results[0].status, "closed");
    assert.equal(await closeCount(), 1);
    await writeFile(log, "");
    const cleanupSwapped = path.join(artifacts, "cleanup-terminal-swapped"); await mkdir(cleanupSwapped);
    await writeFile(path.join(cleanupSwapped, "run.json"), JSON.stringify({ outcome: "SUCCESS", parentPaneId: "parent", workspaceId: "ws", tabId: "tab", panes: [claudePane("t-swapped", "term_original")] }));
    const notCleaned = await cleanupRun(cleanupSwapped, artifacts, "parent");
    assert.equal(notCleaned.results[0].reason, "pane identity changed");
    assert.equal(await closeCount(), 0);
  }
} finally { process.env.PATH = oldPath; delete process.env.RESET_HERDR_LOG; await rm(base, { recursive: true, force: true }); }
console.log("production reset safety tests passed");
