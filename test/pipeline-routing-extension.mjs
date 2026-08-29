import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
const starts = fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).map(line => JSON.parse(line)).filter(args => args[0] === "agent" && args[1] === "start").map(args => "fake:" + args[2].toLowerCase());
if (a[0] === "status") process.stdout.write("{}\\n");
else if (a[0] === "agent" && a[1] === "start") process.stdout.write(JSON.stringify({pane_id:"fake:" + a[2].toLowerCase()}) + "\\n");
else if (a[0] === "pane" && a[1] === "split") { const id = "fake:split" + (fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).map(line => JSON.parse(line)).filter(args => args[0] === "pane" && args[1] === "split").length); process.stdout.write(JSON.stringify({id:"cli:pane:split",result:{pane:{pane_id:id}}}) + "\\n"); }
else if (a[0] === "pane" && a[1] === "run") process.stdout.write("");
else if (a[0] === "pane" && a[1] === "rename") process.stdout.write(JSON.stringify({id:"cli:pane:rename",result:{type:"pane_info",pane:{pane_id:a[2]}}}) + "\\n");
else if (a[0] === "pane" && a[1] === "layout" && scenario === "layout-occupied") process.stdout.write(JSON.stringify({result:{layout:{panes:[{pane_id:"parent"},{pane_id:"existing-pane"}],splits:[{direction:"right",ratio:0.5}],zoomed:false}}}) + "\\n");
else if (a[0] === "pane" && a[1] === "layout" && scenario === "layout-failure" && fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).map(line => JSON.parse(line)).filter(args => args[0] === "pane" && args[1] === "split").length > 0) process.exit(8);
else if (a[0] === "pane" && a[1] === "layout") { const n = fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).map(line => JSON.parse(line)).filter(args => args[0] === "pane" && args[1] === "split").length; const panes = ["parent",...Array.from({length:n}, (_, i) => "fake:split" + (i + 1))]; const splits = [{direction:"right",ratio:0.55},{direction:"down",ratio:0.33333334},{direction:"down",ratio:0.5}].slice(0,n); process.stdout.write(JSON.stringify({id:"cli:pane:layout",result:{layout:{panes:panes.map(pane_id => ({pane_id})),splits,zoomed:false}}}) + "\\n"); }
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
  process.env.FAKE_HERDR_STARTS = "";
  const controller = new AbortController();
  if (aborted) controller.abort();
  const result = await pipeline.execute("test", { task: "routing test", approvedPlan: "approved", cwd: root, cleanupMode: "never" }, controller.signal, update => {
    if (scenario === "abort" && update?.content?.[0]?.text.includes("pane is running")) controller.abort();
  }, { cwd: root, hasUI: false });
  const artifact = result.details.artifactDir;
  const metadata = JSON.parse(await readFile(path.join(artifact, "run.json"), "utf8"));
  const calls = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const artifactFiles = await readdir(artifact);
  await rm(artifact, { recursive: true, force: true });
  return { result, metadata, calls, artifactFiles };
}

for (const [scenario, expectedError] of [["startup", /startup deadline expired/], ["normal", /stage deadline expired/], ["failure", /process-info remained unavailable or invalid/], ["layout-failure", /Herdr pane layout failed/]]) {
  const { metadata, calls } = await executeScenario(scenario);
  const attempt = metadata.stages.implement.attempts[0];
  assert.equal(metadata.stages.implement.status, "failed");
  assert.equal(attempt.status, "failed");
  assert.equal(metadata.outcome, "IMPLEMENTATION_FAILED");
  if (scenario === "layout-failure") assert.match(metadata.layout.error, /Herdr pane layout failed/);
  else assert.equal(metadata.layout.error, undefined);
  if (scenario === "layout-failure") assert.equal(metadata.panes[0].paneId, "");
  else assert.equal(metadata.panes[0].paneId, "fake:split1");
  assert.match(attempt.error, expectedError);
  assert.equal(calls.filter(a => a[0] === "agent" && a[1] === "start").length, 0);
  assert.deepEqual(calls.filter(a => a[0] === "pane" && a[1] === "split").map(a => a.slice(2)), [["parent", "--direction", "right", "--ratio", "0.55", "--cwd", root, "--no-focus"]]);
  assert.equal(calls.filter(a => a[0] === "pane" && a[1] === "run").length, scenario === "layout-failure" ? 0 : 1);
  assert.equal(calls.filter(a => a[0] === "pane" && a[1] === "layout").length, 2);
  const interrupts = calls.filter(a => a[0] === "pane" && a[1] === "send-keys").map(a => a.slice(2));
  assert.deepEqual(interrupts, scenario === "layout-failure" ? [] : [["fake:split1", "ctrl+c"], ["fake:split1", "escape"]]);
  assert.equal(calls.filter(a => a[0] === "pane" && a[1] === "close").length, scenario === "layout-failure" ? 1 : 0);
}

const occupied = await executeScenario("layout-occupied");
assert.equal(occupied.metadata.outcome, "IMPLEMENTATION_FAILED");
assert.deepEqual(occupied.metadata.occupiedPaneIds, ["existing-pane"]);
assert.deepEqual(occupied.metadata.layout.occupiedPaneIds, ["existing-pane"]);
assert.equal(occupied.calls.filter(a => a[0] === "pane" && a[1] === "split").length, 0);
assert.equal(occupied.calls.filter(a => a[0] === "pane" && a[1] === "run").length, 0);
assert.equal(occupied.calls.filter(a => a[0] === "agent" && a[1] === "start").length, 0);
assert.equal(occupied.artifactFiles.filter(file => file.endsWith("-launcher.sh")).length, 0);
assert.equal(occupied.artifactFiles.filter(file => /^(implement|review)-(pending|\d+)\.json$/.test(file)).length, 0);

const inFlight = await executeScenario("abort");
assert.equal(inFlight.metadata.stages.implement.status, "aborted");
assert.equal(inFlight.metadata.stages.implement.attempts[0].status, "aborted");
assert.match(inFlight.metadata.stages.implement.attempts[0].error, /pipeline aborted; active child stopped; pane preserved/);
assert.equal(inFlight.calls.filter(a => a[0] === "agent" && a[1] === "start").length, 0);
assert.deepEqual(inFlight.calls.filter(a => a[0] === "pane" && a[1] === "send-keys").map(a => a.slice(2)), [["fake:split1", "ctrl+c"], ["fake:split1", "escape"]]);
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
