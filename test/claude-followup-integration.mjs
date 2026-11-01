import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Claude runtime, repair loop end to end through bin/yorishiro-pipeline.
// A fake Herdr runs each launcher as a "pane" and a fake `claude` keeps one
// process per pane, so a second instruction sent with `pane send-text` and
// `pane send-keys enter` reaches the same child, as with a real reused pane.
// FAKE_DROP_ENTERS says how many Enter presses after each send-text the fake
// Herdr loses, which is the failure seen in a real run (instruction pasted,
// never submitted, child idle).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "yorishiro-pipeline");

async function setup() {
  const base = await mkdtemp(path.join(os.tmpdir(), "yorishiro-claude-followup-"));
  const bin = path.join(base, "bin"), state = path.join(base, "state");
  await mkdir(bin, { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(path.join(bin, "herdr"), `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), { spawn } = require("node:child_process");
const a = process.argv.slice(2), dir = process.env.FAKE_STATE, file = path.join(dir, "herdr.json");
const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { splits: [], pids: [] }; } };
const save = value => fs.writeFileSync(file, JSON.stringify(value));
const out = value => process.stdout.write(JSON.stringify(value) + "\\n");
const key = id => path.join(dir, id.replace(":", "-"));
fs.appendFileSync(path.join(dir, "herdr.log"), JSON.stringify(a) + "\\n");
if (a[0] === "status") out({});
else if (a[0] === "pane" && a[1] === "layout") { const s = read(); out({ result: { layout: { panes: ["parent", ...s.splits.map(x => x.id)].map(pane_id => ({ pane_id })), splits: s.splits.map(x => ({ direction: x.direction, ratio: Number(x.ratio) })), zoomed: false } } }); }
else if (a[0] === "pane" && a[1] === "split") { const s = read(), id = "fake:" + (s.splits.length + 1); s.splits.push({ id, direction: a[a.indexOf("--direction") + 1], ratio: a[a.indexOf("--ratio") + 1] }); save(s); out({ result: { pane: { pane_id: id, terminal_id: "term-" + id.replace(":", "-") } } }); }
else if (a[0] === "pane" && a[1] === "run") {
  const launcher = a[3].replace(/^'|'$/g, "");
  const log = fs.openSync(key(a[2]) + ".log", "a");
  const child = spawn("/bin/sh", [launcher], { detached: true, stdio: ["ignore", log, log], env: { ...process.env, FAKE_PANE_ID: a[2] } });
  const s = read(); s.pids.push(child.pid); save(s); child.unref(); out({});
}
else if (a[0] === "pane" && a[1] === "send-text") { fs.writeFileSync(key(a[2]) + ".input", a[3]); fs.writeFileSync(key(a[2]) + ".drops", String(process.env.FAKE_DROP_ENTERS || 0)); out({}); }
else if (a[0] === "pane" && a[1] === "send-keys" && a[3] === "enter") {
  const drops = Number(fs.existsSync(key(a[2]) + ".drops") ? fs.readFileSync(key(a[2]) + ".drops", "utf8") : 0);
  if (drops > 0) fs.writeFileSync(key(a[2]) + ".drops", String(drops - 1));
  else if (fs.existsSync(key(a[2]) + ".input")) fs.writeFileSync(key(a[2]) + ".go", "");
  out({});
}
else if (a[0] === "pane" && a[1] === "get") out({ result: { pane: { pane_id: a[2], agent_status: fs.existsSync(key(a[2]) + ".done") ? "idle" : "working" } } });
else if (a[0] === "pane" && a[1] === "process-info") out({ result: { process_info: { foreground_processes: [{ argv: ["claude"], argv0: "claude", name: "2.1.310" }] } } });
else if (a[0] === "pane" && a[1] === "rename") out({ result: { type: "pane_info", pane: { pane_id: a[2] } } });
else if (a[0] === "agent" && a[1] === "read") process.stdout.write("transcript\\n");
else out({});
`);
  await writeFile(path.join(bin, "claude"), `#!/bin/sh
argv_file=$(mktemp "$FAKE_STATE/argv.XXXXXX")
for arg in "$@"; do printf '%s\\0' "$arg"; done > "$argv_file"
exec node "$FAKE_CLAUDE_IMPL" "$argv_file"
`);
  await writeFile(path.join(bin, "fake-claude.cjs"), `const fs = require("node:fs"), path = require("node:path"), { spawn } = require("node:child_process"), readline = require("node:readline");
const argv = fs.readFileSync(process.argv[2], "utf8").split("\\0").slice(0, -1), dir = process.env.FAKE_STATE;
if (argv[0] === "auth" && argv[1] === "status") { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" })); process.exit(0); }
const stage = process.env.YORISHIRO_REPORT_STAGE, pane = process.env.FAKE_PANE_ID.replace(":", "-"), at = name => path.join(dir, pane + "." + name);
const config = JSON.parse(fs.readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8")).mcpServers.yorishiro;
if (stage === "implement") fs.writeFileSync(at("evidence-dir"), process.env.YORISHIRO_EVIDENCE_DIR || "");
const server = spawn(config.command, config.args, { env: config.env, stdio: ["pipe", "pipe", "inherit"] });
const waiting = new Map(); let next = 1;
readline.createInterface({ input: server.stdout }).on("line", line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
const request = (method, params) => new Promise(resolve => { const id = next++; waiting.set(id, resolve); server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n"); });
const finding = { id: "FIND-1", severity: "high", target: "src", reproduction: "手順を実行します", userImpact: "利用者に影響します", expectedOutcome: "修正されること", route: "worker", discovery: "initial" };
const reports = {
  implement: [1, 2].map(n => ({ verdict: "COMPLETED", summary: "日本語の実装報告" + n, changedScope: "変更はありません", evidence: "テストを実行しました", completedPlanItems: [{ id: "PLAN-1", evidence: "項目を確認しました" }], changedPaths: [] })),
  review: [{ verdict: "CHANGES_REQUESTED", summary: "日本語のレビュー報告", blockingFindings: [finding], nonBlockingNotes: [], plannerQuestions: [] }, { verdict: "APPROVED", summary: "日本語のレビュー報告", blockingFindings: [], nonBlockingNotes: [], plannerQuestions: [] }],
}[stage];
(async () => {
  await request("initialize", { protocolVersion: "2025-06-18" });
  fs.writeFileSync(at("tools"), JSON.stringify((await request("tools/list")).result.tools.map(tool => tool.name)));
  for (let round = 0; round < reports.length; round++) {
    if (round > 0) {
      // Wait for the second instruction: text in the input box and an Enter that reached the child.
      while (!fs.existsSync(at("go"))) await new Promise(resolve => setTimeout(resolve, 100));
      fs.rmSync(at("go")); fs.rmSync(at("done"), { force: true });
      const text = fs.readFileSync(at("input"), "utf8"), file = text.slice(text.indexOf(": ") + 2);
      fs.writeFileSync(at("received-" + round), JSON.stringify({ text, readable: fs.existsSync(file), head: fs.readFileSync(file, "utf8").slice(0, 80) }));
    }
    const result = await request("tools/call", { name: "submit_stage_report", arguments: reports[round] });
    if (result.result.isError) { process.stderr.write(result.result.content[0].text); process.exit(1); }
    fs.writeFileSync(at("done"), "");
  }
  setInterval(() => {}, 1000); // an interactive child stays open after reporting
})();
`);
  await chmod(path.join(bin, "herdr"), 0o755);
  await chmod(path.join(bin, "claude"), 0o755);
  const socket = path.join(base, "herdr.sock");
  await writeFile(socket, "");
  const input = { task: "日本語の変更要求", approvedPlan: "日本語の承認済み計画", qualityContract: { planItems: [{ id: "PLAN-1", description: "実装を行う" }], requiredChecks: [{ id: "TEST-1", program: "/usr/bin/true", args: [], timeoutMs: 5000 }] }, cwd: root, cleanupMode: "never", planReviewMode: "skip", diffReviewMode: "skip", maxReviewCycles: 2 };
  const inputFile = path.join(base, "input.json");
  await writeFile(inputFile, JSON.stringify(input));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: state, FAKE_CLAUDE_IMPL: path.join(bin, "fake-claude.cjs"), HERDR_PANE_ID: "parent", HERDR_TAB_ID: "tab", HERDR_WORKSPACE_ID: "ws", HERDR_SOCKET_PATH: socket, YORISHIRO_POLL_INTERVAL_MS: "200", YORISHIRO_STARTUP_GRACE_MS: "2000", YORISHIRO_REPORT_SETTLEMENT_GRACE_MS: "1500" };
  delete env.YORISHIRO_RUNTIME;
  delete env.YORISHIRO_CLAUDE_BIN;
  return { base, state, inputFile, env };
}

async function runPipeline(scenario, dropEnters) {
  const { base, state, inputFile, env } = scenario;
  const result = await new Promise(resolve => {
    const child = spawn(cli, ["run", "--input", inputFile], { cwd: root, env: { ...env, FAKE_DROP_ENTERS: String(dropEnters) }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 150_000);
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  const summary = JSON.parse(result.stdout || "{}");
  const paneLogs = async () => (await Promise.all((await readdir(state)).filter(name => name.endsWith(".log") && name !== "herdr.log").map(async name => `--- ${name}\n${await readFile(path.join(state, name), "utf8")}`))).join("\n");
  const herdrCalls = (await readFile(path.join(state, "herdr.log"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  return { ...result, summary, base, state, herdrCalls, diagnostics: async () => `code=${result.code}\nstdout=${result.stdout}\nstderr=${result.stderr.slice(-2000)}\n${await paneLogs()}` };
}

async function cleanup(scenario, artifactDirs) {
  try {
    const herdrState = JSON.parse(await readFile(path.join(scenario.state, "herdr.json"), "utf8"));
    for (const pid of herdrState.pids) { try { process.kill(-pid, "SIGTERM"); } catch { /* exited */ } }
  } catch { /* no panes started */ }
  if (process.env.YORISHIRO_KEEP_TEST_STATE) { console.error(`kept ${scenario.base} and ${artifactDirs.join(", ")}`); return; }
  for (const dir of artifactDirs) if (dir && dir.startsWith(path.join(root, "artifacts"))) await rm(dir, { recursive: true, force: true });
  await rm(scenario.base, { recursive: true, force: true });
}

const sendTextCalls = run => run.herdrCalls.filter(call => call[0] === "pane" && call[1] === "send-text");
const enterCalls = (run, paneId) => run.herdrCalls.filter(call => call[0] === "pane" && call[1] === "send-keys" && call[2] === paneId && call[3] === "enter");

// 1. The first Enter after each instruction is lost; the retry gets it through.
{
  const scenario = await setup();
  let artifactDir;
  try {
    const run = await runPipeline(scenario, 1);
    artifactDir = run.summary.artifactDir;
    assert.equal(run.code, 0, await run.diagnostics());
    assert.equal(run.summary.outcome, "SUCCESS");

    const metadata = JSON.parse(await readFile(path.join(artifactDir, "run.json"), "utf8"));
    assert.deepEqual(metadata.panes.map(pane => pane.name), ["Worker · Claude", "Reviewer · Claude"]);
    const [workerPane, reviewerPane] = metadata.panes.map(pane => pane.paneId);

    // Only the first prompt is passed to the launcher; the second goes through a file and a one-line pointer.
    const texts = sendTextCalls(run);
    assert.equal(texts.length, 2, "one follow-up instruction each for the Worker and the Reviewer");
    assert.deepEqual(texts.map(call => call[2]), [workerPane, reviewerPane]);
    for (const [index, stage] of ["implement", "review"].entries()) {
      const file = path.join(artifactDir, `${stage}-prompt-2.md`);
      assert.equal(texts[index][3], `次のファイルを最後まで読み、その指示に従ってください: ${file}`);
      assert.equal(texts[index][3].includes("\n"), false, "the pane receives a single line");
      const body = await readFile(file, "utf8");
      assert.ok(body.includes("今回のattempt：2"), `${stage} prompt file holds the full instruction for attempt 2`);
      assert.ok(body.includes(path.join(artifactDir, `${stage}-2.json`)), "the report path of attempt 2 is in the file");
      const received = JSON.parse(await readFile(path.join(scenario.state, `${[workerPane, reviewerPane][index].replace(":", "-")}.received-1`), "utf8"));
      assert.equal(received.readable, true, "the child can read the prompt file");
      assert.match(received.head, /あなたは/);
    }
    assert.ok((await readFile(path.join(artifactDir, "implement-prompt-2.md"), "utf8")).includes("FIND-1"), "the Reviewer finding reaches the Worker through the file");
    assert.ok(await readFile(path.join(artifactDir, "implement-prompt-2.md"), "utf8").then(text => text.includes("run_verification_command") && text.includes("YORISHIRO_EVIDENCE_DIR")), "the Worker prompt names the verifier and the evidence directory");

    // The lost Enter was pressed again.
    assert.equal(enterCalls(run, workerPane).length, 2);
    assert.equal(enterCalls(run, reviewerPane).length, 2);
    assert.deepEqual(metadata.promptDeliveries.map(item => [item.stage, item.attempt, item.paneId, item.submitted, item.enterPresses]), [["implement", 2, workerPane, true, 2], ["review", 2, reviewerPane, true, 2]]);
    assert.equal(metadata.promptFailures, undefined);
    assert.ok(metadata.launchers.includes("implement-prompt-2.md") && metadata.launchers.includes("review-prompt-2.md"), "the prompt files are tracked for cleanup");

    // Worker: verifier tool, evidence directory, and an inventory of it.
    assert.deepEqual(JSON.parse(await readFile(path.join(scenario.state, `${workerPane.replace(":", "-")}.tools`), "utf8")), ["submit_stage_report", "run_verification_command"]);
    assert.equal(await readFile(path.join(scenario.state, `${workerPane.replace(":", "-")}.evidence-dir`), "utf8"), path.join(artifactDir, "evidence", "worker"));
    assert.equal(existsSync(path.join(artifactDir, "evidence", "worker")), true);
    assert.deepEqual(metadata.workerEvidence.map(item => [item.attempt, item.dir, item.files.length]), [[1, "evidence/worker", 0], [2, "evidence/worker", 0]]);
    assert.equal(JSON.parse(await readFile(path.join(artifactDir, "review-2.json"), "utf8")).verdict, "APPROVED");
  } finally {
    await cleanup(scenario, [artifactDir]);
  }
}

// 2. Enter never gets through: stop with PROMPT_NOT_SUBMITTED instead of waiting for a report.
{
  const scenario = await setup();
  let artifactDir;
  try {
    const run = await runPipeline(scenario, 99);
    artifactDir = run.summary.artifactDir;
    assert.equal(run.code, 3, await run.diagnostics());
    assert.equal(run.summary.outcome, "PROMPT_NOT_SUBMITTED", await run.diagnostics());
    const metadata = JSON.parse(await readFile(path.join(artifactDir, "run.json"), "utf8"));
    const reviewerPane = metadata.panes.find(pane => pane.name === "Reviewer · Claude");
    const workerPane = metadata.panes.find(pane => pane.name === "Worker · Claude");
    // The Reviewer asked for changes; the Worker's second instruction is the one that never got through.
    assert.equal(metadata.outcome, "PROMPT_NOT_SUBMITTED");
    assert.equal(metadata.promptFailures.length, 1);
    const failure = metadata.promptFailures[0];
    assert.deepEqual([failure.code, failure.stage, failure.attempt, failure.paneId, failure.enterPresses], ["PROMPT_NOT_SUBMITTED", "implement", 2, workerPane.paneId, 3]);
    assert.ok(failure.diagnostic.includes(workerPane.paneId), "the diagnostic names the pane");
    assert.ok(run.summary.message.includes(workerPane.paneId) && run.summary.message.includes("PROMPT_NOT_SUBMITTED"), "the CLI message carries the reason and the pane id");
    assert.equal(enterCalls(run, workerPane.paneId).length, 3, "one Enter and two retries, no more");
    assert.equal(metadata.stages.implement.attempts.at(-1).status, "failed");
    assert.match(metadata.stages.implement.attempts.at(-1).error, /PROMPT_NOT_SUBMITTED/);
    assert.equal(metadata.reportFailures, undefined, "not reported as REPORT_MISSING");
    assert.equal(reviewerPane.attempts.length, 1, "the Reviewer was not asked again");
  } finally {
    await cleanup(scenario, [artifactDir]);
  }
}

console.log("claude follow-up prompt delivery pipeline tests passed");
