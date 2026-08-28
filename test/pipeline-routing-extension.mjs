import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const herdrDir = await mkdtemp(path.join(os.tmpdir(), "yorishiro-fake-herdr-"));
const log = path.join(herdrDir, "herdr.log");
const socket = path.join(herdrDir, "socket");
await writeFile(socket, "");
const herdr = path.join(herdrDir, "herdr");
await writeFile(herdr, `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2), scenario = process.env.FAKE_HERDR_SCENARIO;
const log = process.env.FAKE_HERDR_LOG;
const stopped = fs.existsSync(process.env.FAKE_HERDR_STOP_FILE);
fs.appendFileSync(log, JSON.stringify(a) + "\\n");
if (a[0] === "status") process.stdout.write("{}\\n");
else if (a[0] === "agent" && a[1] === "start") process.stdout.write('{"pane_id":"fake:pane"}\\n');
else if (a[0] === "pane" && a[1] === "get") process.stdout.write(stopped ? '{"agent_status":"idle"}\\n' : '{"agent_status":"running"}\\n');
else if (a[0] === "agent" && a[1] === "read") process.stdout.write("fake transcript\\n");
else if (a[0] === "pane" && a[1] === "send-keys" && a[3] === "ctrl+c") fs.writeFileSync(process.env.FAKE_HERDR_STOP_FILE, "1");
else if (a[0] === "pane" && a[1] === "process-info") {
  if (scenario === "startup") process.stdout.write("{}\\n");
  else if (scenario === "normal") process.stdout.write('{"argv0":"pi"}\\n');
  else if (scenario === "failure") process.exit(7);
  else if (scenario === "abort") process.stdout.write('{"argv0":"pi"}\\n');
}
`);
await chmod(herdr, 0o755);
process.env.PATH = `${herdrDir}:${process.env.PATH}`;
process.env.FAKE_HERDR_LOG = log;
const stopFile = path.join(herdrDir, "stopped");
process.env.FAKE_HERDR_STOP_FILE = stopFile;
process.env.HERDR_PANE_ID = "parent";
process.env.HERDR_TAB_ID = "tab";
process.env.HERDR_WORKSPACE_ID = "ws";
process.env.HERDR_SOCKET_PATH = socket;
process.env.YORISHIRO_STAGE_TIMEOUT_MS = "500";
process.env.YORISHIRO_STARTUP_GRACE_MS = "50";
process.env.YORISHIRO_POLL_INTERVAL_MS = "1";

const tools = [];
const { default: load } = await import("../extensions/development-pipeline/index.ts");
load({ registerTool(tool) { tools.push(tool); } });
const pipeline = tools.find(tool => tool.name === "development_pipeline");
assert.ok(pipeline, "production extension must register development_pipeline");

async function executeScenario(scenario, aborted = false) {
  await writeFile(log, "");
  await rm(stopFile, { force: true });
  process.env.FAKE_HERDR_SCENARIO = scenario;
  const controller = new AbortController();
  if (aborted) controller.abort();
  const result = await pipeline.execute("test", { task: "routing test", approvedPlan: "approved", cwd: root, cleanupMode: "never" }, controller.signal, update => {
    if (scenario === "abort" && update?.content?.[0]?.text.includes("pane is running")) controller.abort();
  }, { cwd: root, hasUI: false });
  const artifact = result.details.artifactDir;
  const metadata = JSON.parse(await readFile(path.join(artifact, "run.json"), "utf8"));
  const calls = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  await rm(artifact, { recursive: true, force: true });
  return { result, metadata, calls };
}

for (const [scenario, expectedError] of [["startup", /startup deadline expired/], ["normal", /stage deadline expired/], ["failure", /process-info remained unavailable or invalid/]]) {
  const { metadata, calls } = await executeScenario(scenario);
  const attempt = metadata.stages.implement.attempts[0];
  assert.equal(metadata.stages.implement.status, "failed");
  assert.equal(attempt.status, "failed");
  assert.match(attempt.error, expectedError);
  assert.equal(calls.filter(a => a[0] === "agent" && a[1] === "start").length, 1);
  assert.deepEqual(calls.filter(a => a[0] === "pane" && a[1] === "send-keys").map(a => a.slice(2)), [["fake:pane", "ctrl+c"], ["fake:pane", "escape"]]);
  assert.equal(calls.filter(a => a[0] === "pane" && a[1] === "close").length, 0);
}

const inFlight = await executeScenario("abort");
assert.equal(inFlight.metadata.stages.implement.status, "aborted");
assert.equal(inFlight.metadata.stages.implement.attempts[0].status, "aborted");
assert.match(inFlight.metadata.stages.implement.attempts[0].error, /pipeline aborted; active child stopped; pane preserved/);
assert.equal(inFlight.calls.filter(a => a[0] === "agent" && a[1] === "start").length, 1);
assert.deepEqual(inFlight.calls.filter(a => a[0] === "pane" && a[1] === "send-keys").map(a => a.slice(2)), [["fake:pane", "ctrl+c"], ["fake:pane", "escape"]]);
assert.equal(inFlight.calls.filter(a => a[0] === "pane" && a[1] === "close").length, 0);

const before = await executeScenario("abort", true);
assert.equal(before.metadata.stages.implement.status, "aborted");
assert.equal(before.metadata.stages.implement.attempts[0].status, "aborted");
assert.match(before.metadata.stages.implement.attempts[0].error, /no child was started; pane preserved/);
assert.equal(before.calls.filter(a => a[0] === "agent" && a[1] === "start").length, 0);
assert.equal(before.calls.filter(a => a[0] === "pane" && a[1] === "send-keys").length, 0);
assert.equal(before.calls.filter(a => a[0] === "pane" && a[1] === "close").length, 0);

await rm(herdrDir, { recursive: true, force: true });
console.log("registered production routing fake-Herdr test passed");
