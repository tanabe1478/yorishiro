import assert from "node:assert/strict";
const { repairAction } = await import("../extensions/development-pipeline/pipeline-control.ts");
assert.equal(repairAction(true, false, 0, 1), "repair");
assert.equal(repairAction(true, false, 1, 1), "terminal");
assert.equal(repairAction(false, false, 0, 1), "terminal");
assert.equal(repairAction(true, true, 0, 1), "continue");
console.log("pipeline control-flow test passed");
