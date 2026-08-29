import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { default: load, setAtomicWriteBeforeRenameHook } = await import("../extensions/development-pipeline/stage-reporter.ts");
const tools = [];
load({ registerTool(tool) { tools.push(tool); } });
assert.equal(tools.length, 1, "reporter extension must register exactly one tool");
assert.equal(tools[0].name, "submit_stage_report");
assert.ok(!Object.prototype.hasOwnProperty.call(tools[0].parameters, "path"));
const dir = await mkdtemp(path.join(os.tmpdir(), "yorishiro-reporter-"));
const report = path.join(dir, "fixed-report.md");
process.env.YORISHIRO_REPORT_PATH = report;
process.env.YORISHIRO_REPORT_ROOT = dir;
process.env.YORISHIRO_REPORT_STAGE = "verify";
try {
  await tools[0].execute("test", { verdict: "PASS", summary: "loaded", evidence: "focused test" });
  assert.match(await readFile(report, "utf8"), /VERDICT: PASS\n$/);
  await assert.rejects(() => tools[0].execute("test", { verdict: "READY", summary: "bad", evidence: "bad" }));
  process.env.YORISHIRO_REPORT_SCHEMA = "worker";
  await tools[0].execute("test", { verdict: "BLOCKED", summary: "blocked", changedScope: "none", evidence: "not run" });
  assert.match(await readFile(report, "utf8"), /Changed scope[\s\S]*none/);
  process.env.YORISHIRO_REPORT_SCHEMA = "reviewer";
  await tools[0].execute("test", { verdict: "APPROVED", summary: "approved", findings: [], plannerQuestions: [] });
  assert.match(await readFile(report, "utf8"), /VERDICT: APPROVED\n$/);
  await assert.rejects(() => tools[0].execute("test", { verdict: "APPROVED", summary: "bad", findings: [{ id: "x", priority: "p", target: "t", problem: "p", expectedOutcome: "e", route: "worker" }], plannerQuestions: [] }));
  await assert.rejects(() => tools[0].execute("test", { verdict: "PASS", summary: "x", evidence: "x" }));
  const safe = path.join(dir, "safe..pending.md"); process.env.YORISHIRO_REPORT_SCHEMA = "legacy"; process.env.YORISHIRO_REPORT_STAGE = "verify"; process.env.YORISHIRO_REPORT_PATH = safe;
  await tools[0].execute("test", { verdict: "PASS", summary: "safe", evidence: "safe" }); const preserved = await readFile(safe, "utf8");
  process.env.YORISHIRO_REPORT_PATH = path.join(dir, "..", "escape.md"); await writeFile(path.join(dir, "..", "escape.md"), "OLD-ESCAPE"); await assert.rejects(() => tools[0].execute("test", { verdict: "PASS", summary: "escape", evidence: "escape" })); assert.equal(await readFile(path.join(dir, "..", "escape.md"), "utf8"), "OLD-ESCAPE");
  const outside=path.join(dir,"..","yorishiro-reporter-outside"); await mkdir(outside); await writeFile(path.join(outside,"outside.md"),"OUTSIDE-OLD"); await symlink(outside,path.join(dir,"link")); process.env.YORISHIRO_REPORT_PATH=path.join(dir,"link","outside.md"); await assert.rejects(() => tools[0].execute("test", { verdict:"PASS", summary:"outside", evidence:"outside" })); assert.equal(await readFile(path.join(outside,"outside.md"),"utf8"),"OUTSIDE-OLD"); assert.equal((await readdir(outside)).filter(x=>x.includes(".tmp-")).length,0);
  const targetSymlink=path.join(dir,"target-link"); await symlink(safe,targetSymlink); process.env.YORISHIRO_REPORT_PATH=targetSymlink; await assert.rejects(() => tools[0].execute("test", { verdict:"PASS", summary:"link", evidence:"link" })); const nonregular=path.join(dir,"target-dir"); await mkdir(nonregular); process.env.YORISHIRO_REPORT_PATH=nonregular; await assert.rejects(() => tools[0].execute("test", { verdict:"PASS", summary:"dir", evidence:"dir" }));
  process.env.YORISHIRO_REPORT_PATH=safe; setAtomicWriteBeforeRenameHook(()=>{throw new Error("forced rename failure")}); await assert.rejects(() => tools[0].execute("test", { verdict:"PASS", summary:"NEW", evidence:"NEW" })); setAtomicWriteBeforeRenameHook(undefined); assert.equal(await readFile(safe,"utf8"),preserved); assert.equal((await readdir(dir)).filter(x=>x.includes(".tmp-")).length,0);
  await tools[0].execute("test", { verdict:"PASS", summary:"NEW", evidence:"NEW" }); assert.match(await readFile(safe,"utf8"),/NEW/); assert.equal((await readdir(dir)).filter(x=>x.includes(".tmp-")).length,0);
} finally {
  await rm(path.join(dir, "..", "escape.md"), { force: true });
  await rm(path.join(dir, "..", "yorishiro-reporter-outside"), { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
  delete process.env.YORISHIRO_REPORT_PATH;
  delete process.env.YORISHIRO_REPORT_STAGE;
  delete process.env.YORISHIRO_REPORT_SCHEMA;
  delete process.env.YORISHIRO_REPORT_ROOT;
}
console.log("reporter extension load test passed");
