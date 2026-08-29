import assert from "node:assert/strict";

export const REQUIRED_EVENTS = ["dispatch", "settlement", "split", "report", "outcome", "cleanupDecision"];
const requiredSource = (events, kind, source) => {
  if (!events.some(event => event.kind === kind && event.source === source)) throw new Error(`required observation ${kind} from ${source} is missing`);
};

export function collectObservedEvents({ commandLog, state, productionReturn, promptRaw }) {
  if (!Array.isArray(commandLog)) throw new Error("required Herdr command log source is missing");
  if (!state || !Array.isArray(state.events)) throw new Error("required reporter/settlement source is missing");
  if (!productionReturn || typeof productionReturn !== "object") throw new Error("required production return source is missing");
  const events = [];
  for (const args of commandLog) {
    if (!Array.isArray(args) || args[0] !== "pane") continue;
    if (args[1] === "split") events.push({ kind: "split", source: "herdr-command-log", targetPaneId: args[2] });
    if (args[1] === "run") events.push({ kind: "dispatch", source: "herdr-command-log:pane-run", paneId: args[2] });
    if (args[1] === "send-text") events.push({ kind: "dispatch-command", source: "herdr-command-log:send-text", paneId: args[2] });
  }
  for (const event of state.events) {
    if (event?.kind === "launcher" && event.source === "launcher-file") events.push({ ...event });
    if (event?.kind === "settlement" && event.source === "herdr-settlement") events.push({ ...event });
    if (event?.kind === "report" && ["registered-reporter", "malformed-report-write"].includes(event.source)) events.push({ ...event });
  }
  for (const line of String(promptRaw ?? "").trim().split("\n").filter(Boolean)) {
    const [paneId, encoded] = line.split("\t"), prompt = Buffer.from(encoded ?? "", "base64").toString("utf8");
    const stage = prompt.includes("Worker · Luna") ? "implement" : prompt.includes("Reviewer · Sol") ? "review" : undefined;
    const attemptText = prompt.match(/今回のattempt：(\d+)/)?.[1];
    if (!paneId || !stage || !attemptText) throw new Error("prompt raw observation lacks pane/stage/attempt");
    events.push({ kind: "dispatch", source: "prompt-raw", paneId, stage, attempt: Number(attemptText), prompt });
  }
  const outcome = productionReturn.details?.outcome, cleanupDecision = productionReturn.details?.cleanupDecision;
  if (typeof outcome !== "string") throw new Error("production return outcome observation is missing");
  if (typeof cleanupDecision !== "string") throw new Error("production return cleanup decision observation is missing");
  events.push({ kind: "outcome", source: "production-return", value: outcome });
  events.push({ kind: "cleanupDecision", source: "production-return", value: cleanupDecision });
  requiredSource(events, "split", "herdr-command-log");
  requiredSource(events, "dispatch", "herdr-command-log:pane-run");
  requiredSource(events, "settlement", "herdr-settlement");
  if (!events.some(event => event.kind === "report" && ["registered-reporter", "malformed-report-write"].includes(event.source))) throw new Error("required direct report observation is missing");
  const sendTextCommands = events.filter(event => event.kind === "dispatch-command");
  const promptDispatches = events.filter(event => event.kind === "dispatch" && event.source === "prompt-raw");
  if (sendTextCommands.length !== promptDispatches.length) throw new Error("send-text command and prompt raw observations do not match");
  if (sendTextCommands.length > 0) requiredSource(events, "dispatch", "prompt-raw");
  requiredSource(events, "outcome", "production-return");
  requiredSource(events, "cleanupDecision", "production-return");
  return events;
}

export function assertScenario(events, expected = {}) {
  for (const kind of REQUIRED_EVENTS) assert.ok(events.some(entry => entry.kind === kind), `required observed event ${kind} is missing`);
  requiredSource(events, "split", "herdr-command-log");
  requiredSource(events, "dispatch", "herdr-command-log:pane-run");
  requiredSource(events, "outcome", "production-return");
  requiredSource(events, "cleanupDecision", "production-return");
  const settlements = events.filter(entry => entry.kind === "settlement");
  assert.ok(settlements.length > 0, "settlement must contain an observation");
  if (expected.attempts) for (const [stage, count] of Object.entries(expected.attempts)) assert.equal(settlements.filter(entry => entry.stage === stage).length, count);
  if (expected.handoff) {
    assert.ok(events.some(entry => entry.kind === "dispatch-command" && entry.source === "herdr-command-log:send-text"), "handoff send-text command observation is missing");
    assert.ok(events.some(entry => entry.kind === "dispatch" && entry.source === "prompt-raw" && entry.attempt === 2), "handoff prompt-raw dispatch observation is missing");
  }
  assert.ok(events.some(entry => entry.kind === "launcher" && entry.source === "launcher-file" && entry.launch?.stage), "launcher file observation is missing");
}

export function removeOneObservation(events, index) { return events.filter((_, eventIndex) => eventIndex !== index); }
