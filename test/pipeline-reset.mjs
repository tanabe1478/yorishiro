import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetRun } from "../extensions/development-pipeline/cleanup.ts";

const base = await mkdtemp(path.join(os.tmpdir(), "yorishiro-reset-"));
const artifacts = path.join(base, "artifacts"), bin = path.join(base, "bin"), log = path.join(base, "herdr.log");
await mkdir(artifacts); await mkdir(bin); await writeFile(log, "");
const herdr = path.join(bin, "herdr");
await writeFile(herdr, `#!/bin/sh
printf '%s\\n' "$*" >> "$RESET_HERDR_LOG"
if [ "$1" = pane ] && [ "$2" = get ]; then
  case "$3" in worker) name='Worker · Luna';; reviewer) name='Reviewer · Sol';; *) name="$3";; esac
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
  for (const outcome of ["IMPLEMENTATION_FAILED", "ABORTED", "REVIEW_FAILED", "NEEDS_PLANNER", "HUMAN_CHANGES_REQUESTED"]) {
    await writeFile(log, ""); const dir = await make(`valid-${outcome}`, { outcome });
    const result = await resetRun(dir, artifacts, context, true); assert.equal(result.results[0].status, "closed");
  }
  await rejectsWithoutClose("success", { outcome: "SUCCESS" });
  await rejectsWithoutClose("noncanonical", { outcome: "TOTALLY_FAILED" });
  await rejectsWithoutClose("unfinished", { finishedAt: undefined });
  await rejectsWithoutClose("missing-run-identity", { workspaceId: "" });
  await rejectsWithoutClose("missing-current-identity", {}, { paneId: "parent", workspaceId: undefined, tabId: "tab" });
  await rejectsWithoutClose("wrong-current-pane", {}, { paneId: "other", workspaceId: "ws", tabId: "tab" });
  await rejectsWithoutClose("duplicate-role", { panes: [{ paneId: "worker", name: "Worker · Luna" }, { paneId: "worker-2", name: "Worker · Luna" }] });
  await rejectsWithoutClose("duplicate-pane-id", { panes: [{ paneId: "same", name: "Worker · Luna" }, { paneId: "same", name: "Reviewer · Sol" }] });
  await rejectsWithoutClose("missing-pane-id", { panes: [{ paneId: "", name: "Worker · Luna" }] });
} finally { process.env.PATH = oldPath; delete process.env.RESET_HERDR_LOG; await rm(base, { recursive: true, force: true }); }
console.log("production reset safety tests passed");
