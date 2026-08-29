import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const { splitPane, inspectLayout, validateGeometry, assertInitialLayout, renameDetectedPane, shouldSplitForAttempt, clearLaunchersAfterCleanup } = await import("../extensions/development-pipeline/index.ts");
assert.equal(shouldSplitForAttempt(""), true);
assert.equal(shouldSplitForAttempt("existing-worker"), false, "retries reuse geometry and do not split again");
assertInitialLayout({ panes: [{ pane_id: "parent" }], splits: [], zoomed: false }, "parent");
assert.throws(() => assertInitialLayout({ panes: [{ pane_id: "parent" }, { pane_id: "other" }], splits: [{ direction: "right", ratio: 0.5 }], zoomed: false }, "parent"), /LAYOUT_OCCUPIED.*other/);
await renameDetectedPane("worker", "Worker · Luna", async () => ({ code: 0, stdout: JSON.stringify({ result: { type: "pane_info", pane: { pane_id: "worker" } } }), stderr: "" }));
await renameDetectedPane("worker", "Worker · Luna", async () => ({ code: 0, stdout: JSON.stringify({ result: { type: "ok", pane: { pane_id: "worker" } } }), stderr: "" }));
await assert.rejects(() => renameDetectedPane("worker", "Worker · Luna", async () => ({ code: 0, stdout: JSON.stringify({ result: { type: "pane_info", pane: { pane_id: "other" } } }), stderr: "" })), /matching pane ID/);
const calls = [];
const layouts = [
  { panes: [{ pane_id: "parent" }, { pane_id: "implement" }], splits: [{ direction: "right", ratio: 0.55 }], zoomed: false },
  { panes: [{ pane_id: "parent" }, { pane_id: "implement" }, { pane_id: "verify" }], splits: [{ direction: "right", ratio: 0.55 }, { direction: "down", ratio: 0.33333334 }], zoomed: false },
  { panes: [{ pane_id: "parent" }, { pane_id: "implement" }, { pane_id: "verify" }, { pane_id: "review" }], splits: [{ direction: "right", ratio: 0.55 }, { direction: "down", ratio: 0.33333334 }, { direction: "down", ratio: 0.5 }], zoomed: false },
];
let index = 0;
const fakeHerdr = async (_program, args) => {
  calls.push(args);
  if (args[1] === "split") return { code: 0, stdout: JSON.stringify({ id: "cli:pane:split", result: { pane: { pane_id: ["implement", "verify", "review"][index++] } } }), stderr: "" };
  return { code: 0, stdout: JSON.stringify({ id: "cli:pane:layout", result: { layout: layouts[index - 1] } }), stderr: "" };
};
const a = await splitPane("parent", "right", "0.55", "/safe/repo", fakeHerdr);
assert.equal(a.paneId, "implement");
validateGeometry(await inspectLayout("parent", fakeHerdr), "parent", ["implement"], ["right"], [0.55]);
const b = await splitPane("implement", "down", "0.3333333333", "/safe/repo", fakeHerdr);
assert.equal(b.paneId, "verify");
validateGeometry(await inspectLayout("parent", fakeHerdr), "parent", ["implement", "verify"], ["right", "down"], [0.55, 0.3333333333]);
const c = await splitPane("verify", "down", "0.5", "/safe/repo", fakeHerdr);
assert.equal(c.paneId, "review");
validateGeometry(await inspectLayout("parent", fakeHerdr), "parent", ["implement", "verify", "review"], ["right", "down", "down"], [0.55, 0.3333333333, 0.5]);
assert.deepEqual(calls.filter(a => a[1] === "split").map(a => a.slice(2)), [
  ["parent", "--direction", "right", "--ratio", "0.55", "--cwd", "/safe/repo", "--no-focus"],
  ["implement", "--direction", "down", "--ratio", "0.3333333333", "--cwd", "/safe/repo", "--no-focus"],
  ["verify", "--direction", "down", "--ratio", "0.5", "--cwd", "/safe/repo", "--no-focus"],
]);
assert.equal(calls.some(a => a[1] === "move" || a[1] === "zoom" || a[1] === "close"), false);
await assert.rejects(() => splitPane("parent", "right", "0.55", "/safe/repo", async () => ({ code: 1, stdout: "", stderr: "split failed" })), /split failed/);
const auditDir = await mkdtemp(path.join(os.tmpdir(), "yorishiro-audit-"));
await writeFile(path.join(auditDir, "worker-launcher.sh"), "launcher");
await writeFile(path.join(auditDir, "run.json"), JSON.stringify({ outcome: "SUCCESS", cleanup: { status: "completed", results: [{ status: "closed" }] }, launchers: ["worker-launcher.sh"] }));
const audited = await clearLaunchersAfterCleanup(auditDir);
assert.equal(audited.cleanup.status, "completed");
assert.deepEqual(audited.cleanup.results, [{ status: "closed" }]);
assert.deepEqual(audited.launchers, []);
await assert.rejects(() => readFile(path.join(auditDir, "worker-launcher.sh")));
await rm(auditDir, { recursive: true, force: true });
console.log("real-envelope pipeline layout test passed");
