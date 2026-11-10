import assert from "node:assert/strict";
import { DEFAULT_STAGE_TIMEOUT_MS, MAX_STAGE_TIMEOUT_MS, MIN_STAGE_TIMEOUT_MS, resolveStageTimeout } from "../extensions/development-pipeline/stage-timeout.ts";
import { MAX_CHECK_TIMEOUT_MS } from "../extensions/development-pipeline/quality-contract.ts";

// Constants named by the plan.
assert.equal(MIN_STAGE_TIMEOUT_MS, 60000);
assert.equal(MAX_STAGE_TIMEOUT_MS, 14400000);
assert.equal(DEFAULT_STAGE_TIMEOUT_MS, 5400000);
// One long check must not use up the whole stage: the default is longer than the longest single check.
assert.ok(DEFAULT_STAGE_TIMEOUT_MS > MAX_CHECK_TIMEOUT_MS);

// Range of the input: 59999 no, 60000 yes, 14400000 yes, 14400001 no, non-integers no.
const rejects = value => assert.throws(() => resolveStageTimeout(value, {}), /stageTimeoutMs must be an integer from 60000 to 14400000/, `rejects ${String(value)}`);
for (const bad of [59999, 14400001, 0, -1, 60000.5, Number.NaN, Number.POSITIVE_INFINITY, "60000", null, true, {}, []]) rejects(bad);
assert.deepEqual(resolveStageTimeout(60000, {}), { ms: 60000, source: "input" });
assert.deepEqual(resolveStageTimeout(14400000, {}), { ms: 14400000, source: "input" });

// Precedence: input > environment > default.
assert.deepEqual(resolveStageTimeout(undefined, {}), { ms: 5400000, source: "default" });
assert.deepEqual(resolveStageTimeout(undefined, { YORISHIRO_STAGE_TIMEOUT_MS: "" }), { ms: 5400000, source: "default" });
assert.deepEqual(resolveStageTimeout(undefined, { YORISHIRO_STAGE_TIMEOUT_MS: "1200000" }), { ms: 1200000, source: "env" });
assert.deepEqual(resolveStageTimeout(120000, { YORISHIRO_STAGE_TIMEOUT_MS: "1200000" }), { ms: 120000, source: "input" });
// The environment variable keeps its old behavior: no range limit (tests use a few hundred ms) ...
assert.deepEqual(resolveStageTimeout(undefined, { YORISHIRO_STAGE_TIMEOUT_MS: "500" }), { ms: 500, source: "env" });
// ... but an unusable value is an error rather than a deadline that never fires.
for (const bad of ["abc", "0", "-5", "Infinity"]) assert.throws(() => resolveStageTimeout(undefined, { YORISHIRO_STAGE_TIMEOUT_MS: bad }), /YORISHIRO_STAGE_TIMEOUT_MS must be a positive number/);
// An invalid input is an error even when the environment is valid (the input is not silently ignored).
assert.throws(() => resolveStageTimeout(59999, { YORISHIRO_STAGE_TIMEOUT_MS: "1200000" }), /stageTimeoutMs must be/);

// The registered tool: schema bounds, and rejection before anything starts (no Herdr context is needed to reach it).
delete process.env.YORISHIRO_ROOT;
delete process.env.YORISHIRO_RUNTIME;
const tools = [];
const { default: load } = await import("../extensions/development-pipeline/index.ts");
load({ registerTool(tool) { tools.push(tool); } });
const pipeline = tools.find(tool => tool.name === "development_pipeline");
assert.ok(pipeline, "production extension must register development_pipeline");
// The test loader stubs TypeBox (Type.Integer ignores its options), so the schema bounds are checked in the source text.
// Real TypeBox validation happens in Pi; the CLI skips it, which is why execute() validates again (below).
const { readFile } = await import("node:fs/promises");
const source = await readFile(new URL("../extensions/development-pipeline/index.ts", import.meta.url), "utf8");
assert.match(source, /stageTimeoutMs: Type\.Optional\(Type\.Integer\(\{ minimum: MIN_STAGE_TIMEOUT_MS, maximum: MAX_STAGE_TIMEOUT_MS,/, "stageTimeoutMs must be an optional integer bounded by the stage-timeout constants");
assert.ok("stageTimeoutMs" in pipeline.parameters, "development_pipeline must accept stageTimeoutMs");
for (const bad of [59999, 14400001, 60000.5]) {
  await assert.rejects(() => pipeline.execute("bad", { task: "t", approvedPlan: "p", qualityContract: { planItems: [], requiredChecks: [] }, stageTimeoutMs: bad }, new AbortController().signal, () => {}, { cwd: process.cwd(), hasUI: false }), /stageTimeoutMs must be an integer from 60000 to 14400000/);
}
console.log("stage timeout test passed");
