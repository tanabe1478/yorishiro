import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The runtime is read once at module load: run this suite as Pi whatever the host environment says.
delete process.env.YORISHIRO_ROOT;
delete process.env.YORISHIRO_RUNTIME;
const { WORKER_PERMISSION_MODES, describeWorkerPermission, resolveWorkerPermissionMode } = await import("../extensions/development-pipeline/worker-permission.ts");

// The mode: unset and "default" are the same; "bypass" is the only other value.
assert.deepEqual([...WORKER_PERMISSION_MODES], ["default", "bypass"]);
assert.equal(resolveWorkerPermissionMode(undefined, "claude"), "default");
assert.equal(resolveWorkerPermissionMode("default", "claude"), "default");
assert.equal(resolveWorkerPermissionMode("bypass", "claude"), "bypass");
// Pi: default is fine (nothing changes), bypass is refused.
assert.equal(resolveWorkerPermissionMode(undefined, "pi"), "default");
assert.equal(resolveWorkerPermissionMode("default", "pi"), "default");
assert.throws(() => resolveWorkerPermissionMode("bypass", "pi"), /workerPermissionMode bypass is only available in the Claude runtime/);
// Anything else is an error, in either runtime, including near misses and non-strings.
for (const bad of ["", "Bypass", "BYPASS", "acceptEdits", "dontAsk", " bypass", "bypass ", 1, true, null, {}, []]) {
  for (const runtime of ["claude", "pi"]) assert.throws(() => resolveWorkerPermissionMode(bad, runtime), /workerPermissionMode must be one of default, bypass/, `rejects ${JSON.stringify(bad)} in ${runtime}`);
}
// What run.json records.
assert.deepEqual(describeWorkerPermission("default"), { mode: "default", flag: "--permission-mode dontAsk" });
assert.deepEqual(describeWorkerPermission("bypass"), { mode: "bypass", flag: "--dangerously-skip-permissions" });

// The registered tool (Pi runtime here): the field exists, and bad values fail before anything starts (no Herdr context is needed to reach the check).
const tools = [];
const { default: load } = await import("../extensions/development-pipeline/index.ts");
load({ registerTool(tool) { tools.push(tool); } });
const pipeline = tools.find(tool => tool.name === "development_pipeline");
assert.ok(pipeline, "production extension must register development_pipeline");
assert.ok("workerPermissionMode" in pipeline.parameters, "development_pipeline must accept workerPermissionMode");
const source = await readFile(new URL("../extensions/development-pipeline/index.ts", import.meta.url), "utf8");
assert.match(source, /workerPermissionMode: Type\.Optional\(Type\.String\(/, "workerPermissionMode must be an optional string in the schema");
const run = input => pipeline.execute("wp", { task: "t", approvedPlan: "p", qualityContract: { planItems: [], requiredChecks: [] }, ...input }, new AbortController().signal, () => {}, { cwd: process.cwd(), hasUI: false });
for (const bad of ["Bypass", "acceptEdits", "", 1, null]) await assert.rejects(() => run({ workerPermissionMode: bad }), /workerPermissionMode must be one of default, bypass/);
await assert.rejects(() => run({ workerPermissionMode: "bypass" }), /workerPermissionMode bypass is only available in the Claude runtime/);

console.log("worker permission test passed");
