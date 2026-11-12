import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Starts the verification sandbox for real, so it cannot run inside the quality gate's own sandbox (see test/gate-exclusions.json).
// The question: does a command run through run_verification_command see the environment of the orchestrator, like the
// quality gate's, and not the environment of the process that called the tool (the child pane's shell)?
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = name => path.join(root, "extensions", "development-pipeline", name);
const { startVerificationBroker } = await import(ext("verification-broker.ts"));
const { verificationRequestDir } = await import(ext("verification-requests.ts"));
const { runQualityGate } = await import(ext("index.ts"));
const { renderClaudeMcpConfig } = await import(ext("launcher.ts"));

// The target cannot be under the temporary directory (the sandbox preflight refuses it); artifacts/ is ignored by git.
const container = await realpath(await mkdtemp(path.join(root, "artifacts", ".broker-sandbox-")));
const target = path.join(container, "target");
await mkdir(target);
await writeFile(path.join(target, "data.txt"), "data\n");
const artifactDir = path.join(container, "artifact");
const saved = { ...process.env };
// Variables only the orchestrator has (the first two), a variable both have with different values, and one only the child has.
// Names must not start with YORISHIRO_ or HERDR_: the verification environment drops those on purpose.
Object.assign(process.env, { VERIFICATION_ORCH_ONLY: "orchestrator-only-value", VERIFICATION_BOTH: "orchestrator-value", YORISHIRO_ORCH_SESSION: "dropped-on-purpose" });

/** The MCP server as Claude Code starts it (same config, same entry), with an environment that differs from the orchestrator's. */
function startMcpServer(requestDir) {
  const config = renderClaudeMcpConfig({ stage: "review", name: "x", promptFile: path.join(artifactDir, "p.md"), cwd: target, reportPath: path.join(artifactDir, "r.json"), artifactDir, root, workflowSkillDir: "/s", workflowPlaybook: "/p", workflowBrief: "/b", workflow: "feature", verifySkills: [] }).mcpServers.yorishiro;
  assert.equal(config.env.YORISHIRO_VERIFICATION_REQUEST_DIR, requestDir, "the launcher's config points the tool at the request directory");
  const child = spawn(config.command, config.args, { env: { ...saved, ...config.env, VERIFICATION_BOTH: "child-pane-value", VERIFICATION_CHILD_ONLY: "child-only-value", VERIFICATION_ORCH_ONLY: "" }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map(); let next = 1;
  createInterface({ input: child.stdout }).on("line", line => { const message = JSON.parse(line); waiting.get(message.id)?.(message); });
  const request = (method, params) => new Promise((resolve, reject) => { const id = next++; const timer = setTimeout(() => reject(new Error(`no reply to ${method}`)), 120_000); waiting.set(id, message => { clearTimeout(timer); resolve(message); }); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); });
  return { request, close: async () => { child.stdin.end(); await new Promise(resolve => child.once("close", resolve)); } };
}

try {
  const requestDir = verificationRequestDir(artifactDir, "review");
  const broker = await startVerificationBroker({ requestDir, evidenceRoot: path.join(artifactDir, "evidence"), stage: "review", cwd: target });
  const server = startMcpServer(requestDir);
  try {
    await server.request("initialize", { protocolVersion: "2025-06-18" });
    const verify = async (program, args) => { const reply = await server.request("tools/call", { name: "run_verification_command", arguments: { program, args, timeoutMs: 60_000 } }); assert.equal(reply.result.isError, undefined, JSON.stringify(reply)); return reply.result.content[0].text; };
    const printenv = name => verify("/usr/bin/printenv", [name]);

    // Through the tool the command sees the orchestrator's values, never the tool process's.
    assert.match(await printenv("VERIFICATION_ORCH_ONLY"), /^orchestrator-only-value\n/, "a variable only the orchestrator has is visible");
    assert.match(await printenv("VERIFICATION_BOTH"), /^orchestrator-value\n/, "where both have the variable, the orchestrator's value wins");
    assert.match(await printenv("VERIFICATION_CHILD_ONLY"), /exit=1\]$/, "a variable only the tool's process has is not visible (printenv exits 1)");
    assert.match(await printenv("YORISHIRO_ORCH_SESSION"), /exit=1\]$/, "the orchestrator's own YORISHIRO_* session variables are still dropped");
    assert.match(await printenv("YORISHIRO_VERIFICATION_REQUEST_DIR"), /exit=1\]$/, "and so is the request directory");

    // The quality gate, in this same process, gives the same answers for the same checks.
    const check = (id, name) => ({ id, program: "/usr/bin/printenv", args: [name], timeoutMs: 60_000 });
    const gate = await runQualityGate({ planItems: [{ id: "P", description: "x" }], requiredChecks: [check("orch", "VERIFICATION_ORCH_ONLY"), check("both", "VERIFICATION_BOTH")] }, target, 1, artifactDir);
    assert.equal(gate.status, "passed", JSON.stringify(gate.checks.map(item => item.summary)));
    assert.equal(gate.checks[0].outputExcerpt.trim(), "orchestrator-only-value");
    assert.equal(gate.checks[1].outputExcerpt.trim(), "orchestrator-value");

    // Evidence written by the command lands where the Reviewer's evidence goes, with the request's id.
    const text = await verify(process.execPath, ["-e", "require('node:fs').writeFileSync(require('node:path').join(process.env.YORISHIRO_EVIDENCE_DIR,'proof.txt'),'proof')"]);
    const dir = /dir=(.+?)\]/.exec(text)[1];
    assert.equal(path.dirname(dir), path.join(artifactDir, "evidence", "reviewer"));
    assert.equal(await readFile(path.join(dir, "proof.txt"), "utf8"), "proof");
    // The sandbox still holds: the source is not writable, the snapshot is.
    assert.match(await verify(process.execPath, ["-e", `try{require('node:fs').writeFileSync(${JSON.stringify(path.join(target, "forbidden"))},'x');process.exit(0)}catch{process.exit(5)}`]), /exit=5\]$/);
    assert.equal((await readdir(target)).includes("forbidden"), false);

    // The request and result files carry no environment value.
    for (const file of await readdir(requestDir)) {
      const content = await readFile(path.join(requestDir, file), "utf8");
      for (const value of ["orchestrator-only-value", "orchestrator-value", "child-pane-value", "child-only-value"]) if (file.endsWith(".request.json") || file === "broker.json") assert.equal(content.includes(value), false, `${file} must not hold ${value}`);
    }
  } finally { await server.close(); await broker.stop(); }
} finally {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  await rm(container, { recursive: true, force: true });
}
console.log("verification broker sandbox tests passed");
