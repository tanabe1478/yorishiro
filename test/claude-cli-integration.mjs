import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end through bin/yorishiro-pipeline: a fake Herdr runs each launcher
// as a "pane", and a fake `claude` reads the generated MCP config, talks to the
// real Yorishiro MCP server, and submits its stage report through it.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "yorishiro-pipeline");
const base = await mkdtemp(path.join(os.tmpdir(), "yorishiro-claude-cli-"));
const bin = path.join(base, "bin"), state = path.join(base, "state");
await mkdir(bin, { recursive: true });
await mkdir(state, { recursive: true });

await writeFile(path.join(bin, "herdr"), `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), { spawn } = require("node:child_process");
const a = process.argv.slice(2), dir = process.env.FAKE_STATE, file = path.join(dir, "herdr.json");
const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { splits: [], pids: [] }; } };
const save = value => fs.writeFileSync(file, JSON.stringify(value));
const out = value => process.stdout.write(JSON.stringify(value) + "\\n");
fs.appendFileSync(path.join(dir, "herdr.log"), JSON.stringify(a) + "\\n");
if (a[0] === "status") out({});
else if (a[0] === "pane" && a[1] === "layout") { const s = read(); out({ result: { layout: { panes: ["parent", ...s.splits.map(x => x.id)].map(pane_id => ({ pane_id })), splits: s.splits.map(x => ({ direction: x.direction, ratio: Number(x.ratio) })), zoomed: false } } }); }
else if (a[0] === "pane" && a[1] === "split") { const s = read(), id = "fake:" + (s.splits.length + 1); s.splits.push({ id, direction: a[a.indexOf("--direction") + 1], ratio: a[a.indexOf("--ratio") + 1] }); save(s); out({ result: { pane: { pane_id: id } } }); }
else if (a[0] === "pane" && a[1] === "run") {
  const launcher = a[3].replace(/^'|'$/g, "");
  const log = fs.openSync(path.join(dir, a[2].replace(":", "-") + ".log"), "a");
  const child = spawn("/bin/sh", [launcher], { detached: true, stdio: ["ignore", log, log], env: { ...process.env, FAKE_PANE_ID: a[2] } });
  const s = read(); s.pids.push(child.pid); save(s); child.unref(); out({});
}
else if (a[0] === "pane" && a[1] === "get") out({ result: { pane: { pane_id: a[2], agent_status: fs.existsSync(path.join(dir, a[2].replace(":", "-") + ".done")) ? "idle" : "working" } } });
else if (a[0] === "pane" && a[1] === "process-info") out({ result: { process_info: { foreground_processes: [{ argv: ["claude"], argv0: "claude", name: "2.1.310" }] } } });
else if (a[0] === "pane" && a[1] === "rename") out({ result: { type: "pane_info", pane: { pane_id: a[2] } } });
else if (a[0] === "agent" && a[1] === "read") process.stdout.write("transcript\\n");
else out({});
`);

// The launcher passes the multi-kilobyte prompt as one argv entry. On some
// macOS hosts \`node <script> <long arg>\` is SIGKILLed before any JS runs, so the
// fake hands argv to node through a NUL-separated file instead.
await writeFile(path.join(bin, "claude"), `#!/bin/sh
argv_file=$(mktemp "$FAKE_STATE/argv.XXXXXX")
for arg in "$@"; do printf '%s\\0' "$arg"; done > "$argv_file"
exec node "$FAKE_CLAUDE_IMPL" "$argv_file"
`);
await writeFile(path.join(bin, "fake-claude.cjs"), `const fs = require("node:fs"), path = require("node:path"), { spawn } = require("node:child_process"), readline = require("node:readline");
const argv = fs.readFileSync(process.argv[2], "utf8").split("\\0").slice(0, -1), dir = process.env.FAKE_STATE;
if (argv[0] === "auth" && argv[1] === "status") { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "someone@example.com", subscriptionType: "team" })); process.exit(0); }
const stage = process.env.YORISHIRO_REPORT_STAGE;
fs.writeFileSync(path.join(dir, "claude-" + stage + ".json"), JSON.stringify(argv));
const config = JSON.parse(fs.readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8")).mcpServers.yorishiro;
const server = spawn(config.command, config.args, { env: config.env, stdio: ["pipe", "pipe", "inherit"] });
const waiting = new Map(); let next = 1;
readline.createInterface({ input: server.stdout }).on("line", line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
const request = (method, params) => new Promise(resolve => { const id = next++; waiting.set(id, resolve); server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n"); });
const report = stage === "implement"
  ? { verdict: "COMPLETED", summary: "日本語の実装報告", changedScope: "変更はありません", evidence: "テストを実行しました", completedPlanItems: [{ id: "PLAN-1", evidence: "項目を確認しました" }], changedPaths: [] }
  : { verdict: "APPROVED", summary: "日本語のレビュー報告", blockingFindings: [], nonBlockingNotes: [], plannerQuestions: [] };
(async () => {
  await request("initialize", { protocolVersion: "2025-06-18" });
  const tools = (await request("tools/list")).result.tools.map(tool => tool.name);
  fs.writeFileSync(path.join(dir, "tools-" + stage + ".json"), JSON.stringify(tools));
  const result = await request("tools/call", { name: "submit_stage_report", arguments: report });
  if (result.result.isError) { process.stderr.write(result.result.content[0].text); process.exit(1); }
  server.stdin.end();
  fs.writeFileSync(path.join(dir, process.env.FAKE_PANE_ID.replace(":", "-") + ".done"), "");
  setInterval(() => {}, 1000); // an interactive child stays open after reporting
})();
`);
await chmod(path.join(bin, "herdr"), 0o755);
await chmod(path.join(bin, "claude"), 0o755);
const socket = path.join(base, "herdr.sock");
await writeFile(socket, "");

const input = { task: "日本語の変更要求", approvedPlan: "日本語の承認済み計画", qualityContract: { planItems: [{ id: "PLAN-1", description: "実装を行う" }], requiredChecks: [{ id: "TEST-1", program: "/usr/bin/true", args: [], timeoutMs: 5000 }] }, cwd: root, cleanupMode: "never", planReviewMode: "skip", diffReviewMode: "skip" };
const inputFile = path.join(base, "input.json");
await writeFile(inputFile, JSON.stringify(input));
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: state, FAKE_CLAUDE_IMPL: path.join(bin, "fake-claude.cjs"), HERDR_PANE_ID: "parent", HERDR_TAB_ID: "tab", HERDR_WORKSPACE_ID: "ws", HERDR_SOCKET_PATH: socket, YORISHIRO_POLL_INTERVAL_MS: "100", YORISHIRO_REPORT_SETTLEMENT_GRACE_MS: "300", YORISHIRO_STARTUP_GRACE_MS: "15000", YORISHIRO_STAGE_TIMEOUT_MS: "60000" };
delete env.YORISHIRO_RUNTIME;
delete env.YORISHIRO_CLAUDE_BIN;

let artifactDir;
try {
  const result = await new Promise(resolve => {
    const child = spawn(cli, ["run", "--input", inputFile, "--worker-model", "claude-haiku-5-5"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 90_000);
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  const summary = JSON.parse(result.stdout || "{}");
  artifactDir = summary.artifactDir;
  const paneLogs = async () => (await Promise.all((await readdir(state)).filter(name => name.endsWith(".log") && name !== "herdr.log").map(async name => `--- ${name}\n${await readFile(path.join(state, name), "utf8")}`))).join("\n");
  assert.equal(result.code, 0, `CLI failed (${result.code})\nstdout=${result.stdout}\nstderr=${result.stderr.slice(-1500)}\n${await paneLogs()}`);
  assert.equal(summary.outcome, "SUCCESS");
  assert.match(result.stderr, /\[yorishiro\] /, "progress goes to stderr");

  const run = JSON.parse(await readFile(path.join(artifactDir, "run.json"), "utf8"));
  assert.equal(run.runtime, "claude");
  assert.deepEqual(run.models, { implement: "claude-haiku-5-5", review: "claude-opus-5-5" });
  assert.deepEqual(run.panes.map(pane => pane.name), ["Worker · Claude", "Reviewer · Claude"]);
  assert.equal(run.modelGuard.enabled, false);
  assert.equal(run.modelPreflight.auth.loggedIn, true);
  assert.equal(JSON.stringify(run).includes("someone@example.com"), false, "account identity must not be recorded");
  assert.equal(run.qualityGates.at(-1).status, "passed");
  assert.ok(run.launchers.includes("implement-mcp.json") && run.launchers.includes("review-mcp.json"), "MCP configs are tracked for cleanup");
  assert.equal(JSON.parse(await readFile(path.join(artifactDir, "implement-1.json"), "utf8")).verdict, "COMPLETED");
  assert.equal(JSON.parse(await readFile(path.join(artifactDir, "review-1.json"), "utf8")).verdict, "APPROVED");

  const workerArgv = JSON.parse(await readFile(path.join(state, "claude-implement.json"), "utf8"));
  const reviewerArgv = JSON.parse(await readFile(path.join(state, "claude-review.json"), "utf8"));
  assert.equal(workerArgv[workerArgv.indexOf("--model") + 1], "claude-haiku-5-5");
  assert.equal(reviewerArgv[reviewerArgv.indexOf("--model") + 1], "claude-opus-5-5");
  assert.ok(reviewerArgv.includes("--restricted"));
  assert.match(workerArgv.at(-1), /あなたはWorker · Claudeです/);
  assert.deepEqual(JSON.parse(await readFile(path.join(state, "tools-implement.json"), "utf8")), ["submit_stage_report"]);
  assert.deepEqual(JSON.parse(await readFile(path.join(state, "tools-review.json"), "utf8")), ["submit_stage_report", "run_verification_command"]);

  const usage = spawnSync(cli, ["run", "--input", "-"], { input: JSON.stringify({ ...input, diffReviewMode: "required" }), encoding: "utf8", env });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /diffReviewMode: required は Claude Code CLI では使えません/);
  assert.equal(spawnSync(cli, ["bogus"], { encoding: "utf8", env }).status, 2);
  assert.equal(spawnSync(cli, ["--help"], { encoding: "utf8", env }).status, 0);
} finally {
  try {
    const herdrState = JSON.parse(await readFile(path.join(state, "herdr.json"), "utf8"));
    for (const pid of herdrState.pids) { try { process.kill(-pid, "SIGTERM"); } catch { /* exited */ } }
  } catch { /* no panes started */ }
  if (process.env.YORISHIRO_KEEP_TEST_STATE) console.error(`kept ${base} and ${artifactDir}`);
  else {
    if (artifactDir && artifactDir.startsWith(path.join(root, "artifacts"))) await rm(artifactDir, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
}

console.log("claude CLI end-to-end pipeline test passed");
