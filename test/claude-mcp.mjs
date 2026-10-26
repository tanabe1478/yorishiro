import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = path.join(root, "extensions", "development-pipeline", "claude-mcp.mjs");

/** Drive the real stdio server the way Claude Code does: newline-delimited JSON-RPC. */
function startServer(env) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", server], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  let next = 1;
  return {
    request(method, params) {
      const id = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr=${stderr}`)), 20_000);
        waiting.set(id, message => { clearTimeout(timer); resolve(message); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
      });
    },
    notify(method, params) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`); },
    async close() { child.stdin.end(); await new Promise(resolve => child.once("close", resolve)); },
  };
}

const base = await mkdtemp(path.join(os.tmpdir(), "yorishiro-claude-mcp-"));
try {
  const workerReport = path.join(base, "implement-pending.json");
  const worker = startServer({ YORISHIRO_MCP_TOOLS: "submit_stage_report", YORISHIRO_REPORT_SCHEMA: "worker", YORISHIRO_REPORT_STAGE: "implement", YORISHIRO_REPORT_PATH: workerReport });
  const init = await worker.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.result.capabilities, { tools: {} });
  worker.notify("notifications/initialized");
  assert.deepEqual((await worker.request("ping")).result, {});
  const listed = await worker.request("tools/list");
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ["submit_stage_report"], "the Worker must not see the sandbox verifier");
  const schema = listed.result.tools[0].inputSchema;
  assert.deepEqual(schema.required, ["verdict", "summary", "changedScope", "evidence", "completedPlanItems", "changedPaths"]);
  assert.deepEqual(schema.properties.verdict.enum, ["COMPLETED", "BLOCKED"]);

  const rejected = await worker.request("tools/call", { name: "submit_stage_report", arguments: { verdict: "COMPLETED", summary: "done" } });
  assert.equal(rejected.result.isError, true);
  assert.match(rejected.result.content[0].text, /missing=\[changedScope, evidence, completedPlanItems, changedPaths\]/);
  assert.equal(existsSync(workerReport), false, "an invalid report must not be written");

  const report = { verdict: "COMPLETED", summary: "日本語の実装報告", changedScope: "ソースを変更しました", evidence: "テストを実行しました", completedPlanItems: [{ id: "PLAN-1", evidence: "項目を確認しました" }], changedPaths: [] };
  const accepted = await worker.request("tools/call", { name: "submit_stage_report", arguments: report });
  assert.equal(accepted.result.isError, undefined);
  assert.equal(accepted.result.content[0].text, "Submitted worker report.");
  assert.deepEqual(JSON.parse(await readFile(workerReport, "utf8")), report);
  const unknown = await worker.request("tools/call", { name: "run_verification_command", arguments: { program: "/usr/bin/true", args: [] } });
  assert.equal(unknown.result.isError, true);
  assert.equal((await worker.request("resources/list")).error.code, -32601);
  await worker.close();

  const reviewer = startServer({ YORISHIRO_MCP_TOOLS: "submit_stage_report,run_verification_command", YORISHIRO_REPORT_SCHEMA: "reviewer", YORISHIRO_REPORT_STAGE: "review", YORISHIRO_REPORT_PATH: path.join(base, "review-pending.json"), YORISHIRO_TARGET_CWD: root });
  await reviewer.request("initialize", { protocolVersion: "2025-06-18" });
  const reviewerTools = (await reviewer.request("tools/list")).result.tools;
  assert.deepEqual(reviewerTools.map(tool => tool.name), ["submit_stage_report", "run_verification_command"]);
  assert.deepEqual(reviewerTools[0].inputSchema.properties.verdict.enum, ["APPROVED", "APPROVED_WITH_NOTES", "CHANGES_REQUESTED", "NEEDS_PLANNER"]);
  assert.deepEqual(reviewerTools[1].inputSchema.required, ["program", "args"]);
  await reviewer.close();
} finally {
  await rm(base, { recursive: true, force: true });
}

console.log("claude MCP server protocol and report validation tests passed");
