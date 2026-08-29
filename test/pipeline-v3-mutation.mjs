import assert from "node:assert/strict";
import { assertScenario, collectObservedEvents, removeOneObservation } from "./support/pipeline-v3-harness.mjs";
import { assertSuccessQualityState } from "../extensions/development-pipeline/quality-contract.ts";

const prompt = "あなたはWorker · Lunaです。今回のattempt：2。";
const fixture = {
  commandLog: [
    ["pane", "split", "parent"],
    ["pane", "run", "worker", "worker-launcher.sh"],
    ["pane", "send-text", "worker", prompt],
  ],
  state: { events: [
    { kind: "launcher", source: "launcher-file", paneId: "worker", launch: { stage: "implement", schema: "worker" } },
    { kind: "settlement", source: "herdr-settlement", stage: "implement", attempt: 1, paneId: "worker" },
    { kind: "report", source: "registered-reporter", stage: "implement", attempt: 1 },
  ] },
  productionReturn: { details: { outcome: "SUCCESS", cleanupDecision: "never" } },
  promptRaw: `worker\t${Buffer.from(prompt).toString("base64")}\n`,
};
const valid = collectObservedEvents(fixture);
const scenarioContract = { outcome: "SUCCESS", attempts: { implement: 1 }, handoff: true };
assert.doesNotThrow(() => assertScenario(valid, scenarioContract));
for (let index = 0; index < valid.length; index++) {
  assert.throws(() => assertScenario(removeOneObservation(valid, index), scenarioContract), `removing actual observation ${index} must be RED`);
}
const wrongOutcome = valid.map(event => event.kind === "outcome" ? { ...event, value: "NEEDS_PLANNER" } : event);
assert.throws(() => assertScenario(wrongOutcome, scenarioContract), /production return outcome/, "production outcome mutation must be RED");
for (const missing of ["commandLog", "state", "productionReturn"]) {
  const broken = { ...fixture, [missing]: undefined };
  assert.throws(() => collectObservedEvents(broken), `missing ${missing} source must throw without fallback`);
}
const contract = { planItems: [{ id: "PLAN-1", description: "実装" }], requiredChecks: [{ id: "TEST-1", program: "/usr/bin/true", args: [] }] };
const check = { id: "TEST-1", exitCode: 0, timeout: false, cancelled: false };
const successEvidence = { workerValidations: [{ attempt: 1, accepted: true, verdict: "COMPLETED", validator: "validateWorkerReport" }], qualityGates: [{ gate: 1, status: "passed", artifact: "quality-gate-1.json", checks: [check] }] };
assert.doesNotThrow(() => assertSuccessQualityState(successEvidence, contract, ["quality-gate-1.json"]));
assert.throws(() => assertSuccessQualityState({ ...successEvidence, workerValidations: [] }, contract, ["quality-gate-1.json"]), /COMPLETED worker validation/, "validator bypass mutation must be RED");
assert.throws(() => assertSuccessQualityState({ ...successEvidence, qualityGates: [] }, contract, ["quality-gate-1.json"]), /quality gate event/, "quality gate event deletion must be RED");
assert.throws(() => assertSuccessQualityState(successEvidence, contract, []), /artifact observation/, "quality gate artifact deletion must be RED");
assert.throws(() => assertSuccessQualityState({ workerValidations: successEvidence.workerValidations, qualityGates: [] }, contract, []), /quality gate event/, "COMPLETED report alone must never permit SUCCESS");
console.log("non-vacuous direct-observation mutation tests passed");
