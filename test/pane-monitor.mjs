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
    reportExists: () => report,
  };
}

let fake = fakeHerdr([
  { status: "starting", processInfo: {} },
  { status: "idle", processInfo: { argv0: "pi" } },
], true);
assert.equal(await monitorPane({ ...fake, timeoutMs: 10_000, startupGraceMs: 2_000, onUpdate() {} }), "settled", "delayed Pi detection must remain startup");

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
