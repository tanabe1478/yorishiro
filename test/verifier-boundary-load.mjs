import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const tools = [];
const { default: load, MAX_OUTPUT, TRUNCATION_NOTICE } = await import("../extensions/development-pipeline/verifier-tools.ts");
load({ registerTool(tool) { tools.push(tool); } });
assert.deepEqual(tools.map(tool => tool.name), ["run_verification_command"]);
assert.match(tools[0].description, /kernel-enforced read-only sandbox/);
assert.ok(!tools[0].description.includes("bash"));
// The tool only asks the orchestrator, which runs the command; this test is the orchestrator for a review stage.
const { startVerificationBroker } = await import("../extensions/development-pipeline/verification-broker.ts");
const base = await mkdtemp(path.join(os.tmpdir(), "yorishiro-verifier-boundary-"));
const broker = await startVerificationBroker({ requestDir: path.join(base, "verification-requests", "review"), evidenceRoot: path.join(base, "evidence"), stage: "review", cwd: process.cwd() });
process.env.YORISHIRO_VERIFICATION_REQUEST_DIR = broker.requestDir;
async function invoke(program, args, signal = new AbortController().signal, timeoutMs) { return tools[0].execute("test", { program, args, ...(timeoutMs ? { timeoutMs } : {}) }, signal); }
try {
  const silentSuccess = await invoke("/usr/bin/true", []);
  assert.match(silentSuccess.content[0].text, /verification EXIT exit=0/);
  const silentFailure = await invoke("/usr/bin/false", []);
  assert.match(silentFailure.content[0].text, /verification EXIT exit=1/);
  const timed = await invoke("/bin/sh", ["-c", "sleep 30"], new AbortController().signal, 1000);
  assert.match(timed.content[0].text, /verification TIMEOUT exit=/);
  assert.equal(timed.details.timedOut, true);
  const cancelController = new AbortController();
  const cancelPending = invoke("/bin/sh", ["-c", "sleep 30"], cancelController.signal, 30000);
  setTimeout(() => cancelController.abort(), 50);
  const cancelled = await cancelPending;
  assert.match(cancelled.content[0].text, /verification CANCELLED exit=/);
  assert.equal(cancelled.details.cancelled, true);
  assert.equal(cancelled.details.timedOut, false);
  const result = await invoke("/usr/bin/printf", ["%s", `${"a".repeat(65535)}🙂`]);
  const visible = result.content[0].text;
  assert.ok(Buffer.byteLength(visible, "utf8") <= MAX_OUTPUT);
  assert.ok(visible.includes(TRUNCATION_NOTICE));
  assert.match(visible, /verification EXIT exit=0\]$/);
  assert.equal(visible.includes("�"), false);
  const invalid = await tools[0].execute("test", { program: "/usr/bin/python3", args: ["-c", "import os; os.write(1, b'\\x80' * 65536)"] }, new AbortController().signal);
  const invalidVisible = invalid.content[0].text;
  assert.equal(invalid.details.truncated, true);
  assert.ok(Buffer.byteLength(invalidVisible, "utf8") <= MAX_OUTPUT);
  assert.ok(invalidVisible.includes(TRUNCATION_NOTICE));
  assert.match(invalidVisible, /verification EXIT exit=0\]$/);
  assert.ok(invalidVisible.includes("�"));
} finally { delete process.env.YORISHIRO_VERIFICATION_REQUEST_DIR; await broker.stop(); await rm(base, { recursive: true, force: true }); }
console.log("verifier boundary load test passed");
