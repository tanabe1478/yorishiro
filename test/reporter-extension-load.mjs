import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { default: load } = await import("../extensions/development-pipeline/stage-reporter.ts");
const tools = [];
load({ registerTool(tool) { tools.push(tool); } });
assert.equal(tools.length, 1, "reporter extension must register exactly one tool");
assert.equal(tools[0].name, "submit_stage_report");
assert.ok(!Object.prototype.hasOwnProperty.call(tools[0].parameters, "path"));
const dir = await mkdtemp(path.join(os.tmpdir(), "yorishiro-reporter-"));
const report = path.join(dir, "fixed-report.md");
process.env.YORISHIRO_REPORT_PATH = report;
process.env.YORISHIRO_REPORT_STAGE = "verify";
try {
  await tools[0].execute("test", { verdict: "PASS", summary: "loaded", evidence: "focused test" });
  assert.match(await readFile(report, "utf8"), /VERDICT: PASS\n$/);
  await assert.rejects(() => tools[0].execute("test", { verdict: "READY", summary: "bad", evidence: "bad" }));
} finally {
  await rm(dir, { recursive: true, force: true });
  delete process.env.YORISHIRO_REPORT_PATH;
  delete process.env.YORISHIRO_REPORT_STAGE;
}
console.log("reporter extension load test passed");
