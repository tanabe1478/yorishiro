import assert from "node:assert/strict";
import { assertScenario, collectObservedEvents, removeOneObservation } from "./support/pipeline-v3-harness.mjs";

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
assert.doesNotThrow(() => assertScenario(valid, { attempts: { implement: 1 }, handoff: true }));
for (let index = 0; index < valid.length; index++) {
  assert.throws(() => assertScenario(removeOneObservation(valid, index), { attempts: { implement: 1 }, handoff: true }), `removing actual observation ${index} must be RED`);
}
for (const missing of ["commandLog", "state", "productionReturn"]) {
  const broken = { ...fixture, [missing]: undefined };
  assert.throws(() => collectObservedEvents(broken), `missing ${missing} source must throw without fallback`);
}
console.log("non-vacuous direct-observation mutation tests passed");
