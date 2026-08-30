import assert from "node:assert/strict";
const { monitorPane } = await import("../extensions/development-pipeline/pane-monitor.ts");
const { interrupt, routeMonitorFailure, abortBeforePaneStart } = await import("../extensions/development-pipeline/index.ts");

function fakeHerdr(observations, report = false) {
  let clock = 0;
  let index = 0;
  return {
    now: () => clock,
    sleep: async ms => { clock += ms; },
    poll: async () => { const observation = observations[Math.min(index++, observations.length - 1)]; return { ...observation, processInfoValid: observation.processInfoValid ?? true }; },
    reportExists: () => typeof report === "function" ? report(clock, index) : report,
  };
}

let fake = fakeHerdr([
  { status: "starting", processInfo: {} },
  { status: "idle", processInfo: { argv0: "pi" } },
], true);
assert.equal(await monitorPane({ ...fake, timeoutMs: 10_000, startupGraceMs: 2_000, onUpdate() {} }), "settled", "delayed Pi detection must remain startup");

fake = fakeHerdr([
  { status: "running", processInfo: { argv0: "pi" } },
  { status: "done", processInfo: { argv0: "pi" } },
], true);
assert.equal(await monitorPane({ ...fake, timeoutMs: 10_000, startupGraceMs: 2_000, onUpdate() {} }), "settled", "Herdr 0.7.3 done status with a durable report must settle immediately");

fake = fakeHerdr([
  { status: "working", processInfo: { argv0: "pi" } },
], true);
assert.equal(await monitorPane({ ...fake, timeoutMs: 10_000, startupGraceMs: 2_000, reportSettlementGraceMs: 2, pollIntervalMs: 1, onUpdate: async () => {} }), "settled", "a durable final report must bound waiting even when Herdr keeps an active status");

fake = fakeHerdr([
  { status: "future-finished-status", processInfo: { argv0: "pi" } },
], true);
assert.equal(await monitorPane({ ...fake, timeoutMs: 10_000, startupGraceMs: 2_000, reportSettlementGraceMs: 2, pollIntervalMs: 1, onUpdate() {} }), "settled", "unknown future Herdr statuses must not cause an unbounded wait after a durable report");

fake = fakeHerdr([
  { status: "running", processInfo: { argv0: "pi" } },
  { status: "idle", processInfo: {} },
], true);
assert.equal(await monitorPane({ ...fake, timeoutMs: 10_000, startupGraceMs: 2_000, onUpdate() {} }), "exited", "only an observed-then-missing Pi is an exit");

fake = fakeHerdr([
  { status: "starting", processInfo: {} },
  { status: "starting", processInfo: {} },
  { status: "starting", processInfo: {} },
]);
assert.equal(await monitorPane({ ...fake, timeoutMs: 10_000, startupGraceMs: 2_000, onUpdate() {} }), "startup-timeout");

fake = fakeHerdr([
  { status: "running", processInfo: { argv0: "pi" } },
  { status: "idle", processInfo: { argv0: "pi" } },
], false);
assert.equal(await monitorPane({ ...fake, timeoutMs: 10_000, startupGraceMs: 2_000, reportMissingGraceMs: 2, pollIntervalMs: 1, onUpdate() {} }), "report-missing", "activeからidleへ遷移してreportがない場合は有限猶予でfail closedする");

const continuityUpdates = [];
fake = fakeHerdr([
  { status: "running", processInfo: { argv0: "pi" } },
  { status: "idle", processInfo: { argv0: "pi" } },
  { status: "future-status", processInfo: { argv0: "pi" } },
  { status: "idle", processInfo: { argv0: "pi" } },
], false);
assert.equal(await monitorPane({ ...fake, timeoutMs: 10_000, startupGraceMs: 2_000, reportMissingGraceMs: 2, pollIntervalMs: 1, onUpdate: message => continuityUpdates.push(message) }), "report-missing", "unknown status後のidleは新しいquiescent区間として計測する");
assert.equal(continuityUpdates.filter(message => message.includes("report-missing猶予を開始")).length, 2, "unknown status must reset the missing-report timer");

const undefinedContinuityUpdates = [];
fake = fakeHerdr([
  { status: "running", processInfo: { argv0: "pi" } },
  { status: "idle", processInfo: { argv0: "pi" } },
  { processInfo: { argv0: "pi" } },
  { status: "idle", processInfo: { argv0: "pi" } },
], false);
assert.equal(await monitorPane({ ...fake, timeoutMs: 10_000, startupGraceMs: 2_000, reportMissingGraceMs: 2, pollIntervalMs: 1, onUpdate: message => undefinedContinuityUpdates.push(message) }), "report-missing", "undefined status後のidleは新しいquiescent区間として計測する");
assert.equal(undefinedContinuityUpdates.filter(message => message.includes("report-missing猶予を開始")).length, 2, "undefined status must reset the missing-report timer");

fake = fakeHerdr([{ status: "idle", processInfo: { argv0: "pi" } }], false);
assert.equal(await monitorPane({ ...fake, timeoutMs: 10_000, startupGraceMs: 2, reportMissingGraceMs: 2, pollIntervalMs: 1, onUpdate() {} }), "report-missing", "起動直後からidleでもstartup grace後に有限猶予でfail closedする");

fake = fakeHerdr([
  { status: "running", processInfo: { argv0: "pi" } },
  { status: "idle", processInfo: { argv0: "pi" } },
], (clock) => clock >= 2);
assert.equal(await monitorPane({ ...fake, timeoutMs: 10_000, startupGraceMs: 2_000, reportMissingGraceMs: 10, reportSettlementGraceMs: 10, pollIntervalMs: 1, onUpdate() {} }), "settled", "missing report猶予内にreportが現れれば通常settleする");

fake = fakeHerdr([
  { status: "running", processInfo: { argv0: "pi" } },
  { status: "idle", processInfo: { argv0: "pi" } },
  { status: "running", processInfo: { argv0: "pi" } },
  { status: "idle", processInfo: { argv0: "pi" } },
], false);
assert.equal(await monitorPane({ ...fake, timeoutMs: 10_000, startupGraceMs: 2_000, reportMissingGraceMs: 2, pollIntervalMs: 1, onUpdate() {} }), "report-missing", "active復帰時は欠落timerを解除し、次のidleから再計測する");

fake = fakeHerdr([{ status: "future-status", processInfo: { argv0: "pi" } }], false);
assert.equal(await monitorPane({ ...fake, timeoutMs: 4, startupGraceMs: 1, reportMissingGraceMs: 1, pollIntervalMs: 1, onUpdate() {} }), "timeout", "unknown statusだけではreport欠落と断定しない");
fake = fakeHerdr([{ processInfo: { argv0: "pi" } }], false);
assert.equal(await monitorPane({ ...fake, timeoutMs: 4, startupGraceMs: 1, reportMissingGraceMs: 1, pollIntervalMs: 1, onUpdate() {} }), "timeout", "undefined statusだけではreport欠落と断定しない");

fake = fakeHerdr([
  { status: "running", processInfo: {}, processInfoValid: false },
  { status: "running", processInfo: { argv0: "pi" } },
  { status: "idle", processInfo: {}, processInfoValid: true },
], true);
assert.equal(await monitorPane({ ...fake, timeoutMs: 10_000, startupGraceMs: 2_000, onUpdate() {} }), "exited", "a transient invalid snapshot must be retried, not treated as exit");

fake = fakeHerdr([
  { status: "running", processInfo: {}, processInfoValid: false },
  { status: "running", processInfo: {}, processInfoValid: false },
  { status: "running", processInfo: {}, processInfoValid: false },
]);
assert.equal(await monitorPane({ ...fake, timeoutMs: 10_000, startupGraceMs: 2_000, onUpdate() {} }), "process-info-failure");

let reportMissingStops = 0;
const reportMissing = await routeMonitorFailure("report-missing", async () => { reportMissingStops++; return true; });
assert.equal(reportMissing.status, "failed");
assert.equal(reportMissingStops, 0, "report-missing must preserve the quiescent pane without interrupting it");
assert.match(reportMissing.evidence, /durable report missing/);

for (const state of ["startup-timeout", "timeout", "process-info-failure", "aborted"]) {
  let stops = 0;
  const closed = [];
  const result = await routeMonitorFailure(state, async () => { stops++; return true; });
  assert.equal(result.status, state === "aborted" ? "aborted" : "failed");
  assert.equal(stops, 1, `${state} must interrupt the active child`);
  assert.match(result.evidence, /active child stopped; pane preserved/);
  assert.deepEqual(closed, [], `${state} must not close its pane`);
}
const beforeStart = abortBeforePaneStart();
assert.equal(beforeStart.status, "aborted");
assert.match(beforeStart.evidence, /no child was started; pane preserved/);

const controller = new AbortController();
fake = fakeHerdr([{ status: "starting", processInfo: {} }]);
const aborted = monitorPane({ ...fake, timeoutMs: 10_000, startupGraceMs: 2_000, onUpdate() {}, sleep: async () => controller.abort() , signal: controller.signal });
assert.equal(await aborted, "aborted");

const calls = [];
const ok = await interrupt("pane", async (program, args) => { calls.push([program, args]); return { code: 0, stdout: "", stderr: "" }; }, async () => ({ agent_status: "idle" }));
assert.equal(ok, true);
assert.deepEqual(calls.slice(0, 3), [
  ["herdr", ["pane", "send-keys", "pane", "ctrl+c"]],
  ["herdr", ["pane", "send-keys", "pane", "escape"]],
  ["herdr", ["agent", "wait", "pane", "--status", "idle", "--timeout", "2000"]],
]);
console.log("deterministic pane startup/exit and interrupt tests passed");
