import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const temp = await mkdtemp(path.join(os.tmpdir(), "yorishiro-cleanup-v3-"));
const bin = path.join(temp, "bin");
const log = path.join(temp, "close.log");
await mkdir(bin);
await writeFile(log, "");
const herdr = path.join(bin, "herdr");
await writeFile(herdr, String.raw`#!/usr/bin/env node
const fs=require("node:fs"), a=process.argv.slice(2), id=a[2]||"";
if(a[0]==="pane"&&a[1]==="get") { const key="PANE_"+id.replace(/[^A-Za-z0-9]/g,"_"); const state=process.env.FAKE_STATE||"idle"; const workspace=process.env.FAKE_IDENTITY||"ws"; process.stdout.write(JSON.stringify({workspace_id:workspace,tab_id:"tab",name:process.env[key],agent_status:state})); }
else if(a[0]==="pane"&&a[1]==="close") fs.appendFileSync(process.env.CLOSE_LOG,id+"\n");
`);
await chmod(herdr, 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.CLOSE_LOG = log;
process.env.HERDR_PANE_ID = "parent";

const tools = [];
const { default: load } = await import("../extensions/development-pipeline/index.ts");
load({ registerTool(tool) { tools.push(tool); } });
const cleanup = tools.find(tool => tool.name === "development_pipeline_cleanup");
assert.ok(cleanup, "登録済み本番cleanup toolが登録されること");
const artifacts = path.join(root, "artifacts");
const failures = [];

async function runCase(name, panes, expectedClose, expectedResults, expectedStatus, options = {}) {
  const run = path.join(artifacts, `v3-cleanup-${process.pid}-${name}`);
  await mkdir(run, { recursive: true });
  await writeFile(log, "");
  process.env.FAKE_STATE = options.state || "idle";
  process.env.FAKE_IDENTITY = options.identity || "ws";
  for (const pane of panes) process.env[`PANE_${pane.paneId.replace(/[^A-Za-z0-9]/g, "_")}`] = pane.name;
  await writeFile(path.join(run, "run.json"), JSON.stringify({ outcome: "SUCCESS", parentPaneId: "parent", workspaceId: "ws", tabId: "tab", panes }));
  try {
    const result = await cleanup.execute("cleanup", { runDir: run }, new AbortController().signal, () => {}, {});
    const closed = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean);
    if (JSON.stringify(closed) !== JSON.stringify(expectedClose)) failures.push(`${name}: close順が${JSON.stringify(closed)}（期待値${JSON.stringify(expectedClose)}）`);
    const results = result.details.results;
    if (results.length !== expectedResults.length) failures.push(`${name}: result件数が${results.length}（期待値${expectedResults.length}）`);
    for (const [index, expected] of expectedResults.entries()) {
      const actual = results[index];
      if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${name}: result[${index}]が${JSON.stringify(actual)}（期待値${JSON.stringify(expected)}）`);
    }
    const durable = JSON.parse(await readFile(path.join(run, "run.json"), "utf8"));
    const durableCleanup = { results: durable.cleanup?.results, status: durable.cleanup?.status };
    const returnedCleanup = { results: result.details.results, status: result.details.status };
    try { assert.deepEqual(durableCleanup, returnedCleanup); assert.equal(result.details.status, expectedStatus); }
    catch { failures.push(`${name}: durable cleanup.results/statusとtool returnが一致しないかstatusが不正`); }
    if (result.details.outcome !== "SUCCESS") failures.push(`${name}: outcomeがSUCCESSではない`);
  } finally { await rm(run, { recursive: true, force: true }); }
}

await runCase("new", [
  { paneId: "fake:reviewer", name: "Reviewer · Sol" },
  { paneId: "fake:worker", name: "Worker · Luna" },
], ["fake:reviewer", "fake:worker"], [
  { paneId: "fake:reviewer", name: "Reviewer · Sol", status: "closed" },
  { paneId: "fake:worker", name: "Worker · Luna", status: "closed" },
], "completed");
await runCase("legacy", [
  { paneId: "fake:review", name: "Review · Sol" },
  { paneId: "fake:verify", name: "Verify · Terra" },
  { paneId: "fake:implement", name: "Implement · Luna" },
], ["fake:review", "fake:verify", "fake:implement"], [
  { paneId: "fake:review", name: "Review · Sol", status: "closed" },
  { paneId: "fake:verify", name: "Verify · Terra", status: "closed" },
  { paneId: "fake:implement", name: "Implement · Luna", status: "closed" },
], "completed");
await runCase("mixed", [
  { paneId: "fake:worker-m", name: "Worker · Luna" },
  { paneId: "fake:unknown-m", name: "Unknown · X" },
  { paneId: "fake:reviewer-m", name: "Reviewer · Sol" },
  // 同一role／同一paneの重複recordでもcloseは一回だけであることを固定する。
  { paneId: "fake:reviewer-m", name: "Reviewer · Sol" },
], ["fake:reviewer-m", "fake:worker-m"], [
  { paneId: "fake:reviewer-m", name: "Reviewer · Sol", status: "closed" },
  { paneId: "fake:worker-m", name: "Worker · Luna", status: "closed" },
  { paneId: "fake:unknown-m", name: "Unknown · X", status: "skipped", reason: "unknown role" },
], "partial");
await runCase("ambiguous-duplicate", [
  { paneId: "fake:reviewer-a", name: "Reviewer · Sol" },
  { paneId: "fake:reviewer-b", name: "Reviewer · Sol" },
], [], [
  { paneId: "fake:reviewer-a", name: "Reviewer · Sol", status: "skipped", reason: "ambiguous duplicate pane records" },
  { paneId: "fake:reviewer-b", name: "Reviewer · Sol", status: "skipped", reason: "ambiguous duplicate pane records" },
], "partial");
await runCase("mixed-modes-fail-safe", [
  { paneId: "fake:reviewer-both", name: "Reviewer · Sol" },
  { paneId: "fake:review-both", name: "Review · Sol" },
  { paneId: "fake:unknown-both", name: "Unknown · X" },
], [], [
  { paneId: "fake:reviewer-both", name: "Reviewer · Sol", status: "skipped", reason: "mode ambiguity" },
  { paneId: "fake:review-both", name: "Review · Sol", status: "skipped", reason: "mode ambiguity" },
  { paneId: "fake:unknown-both", name: "Unknown · X", status: "skipped", reason: "unknown role" },
], "partial");
await runCase("unknown", [{ paneId: "fake:unknown", name: "Unknown · X" }], [], [{ paneId: "fake:unknown", name: "Unknown · X", status: "skipped", reason: "unknown role" }], "partial");
await runCase("parent", [{ paneId: "parent", name: "Reviewer · Sol" }], [], [{ paneId: "parent", name: "Reviewer · Sol", status: "skipped", reason: "parent/current pane protected" }], "partial");
await runCase("busy", [{ paneId: "fake:busy", name: "Reviewer · Sol" }], [], [{ paneId: "fake:busy", name: "Reviewer · Sol", status: "skipped", reason: "pane is running" }], "partial", { state: "running" });
await runCase("identity", [{ paneId: "fake:identity", name: "Reviewer · Sol" }], [], [{ paneId: "fake:identity", name: "Reviewer · Sol", status: "skipped", reason: "pane identity changed" }], "partial", { identity: "other-ws" });

try { assert.deepEqual(failures, [], `cleanup互換性RED:\n${failures.join("\n")}`); } finally { await rm(temp, { recursive: true, force: true }); }
console.log("cleanup compatibility RED acceptance passed");
