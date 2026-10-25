import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { default: load, guardDecision } = await import("../extensions/development-pipeline/model-guard.ts");

assert.deepEqual(guardDecision(false, undefined, undefined), { allow: true });
assert.equal(guardDecision(true, undefined, "a/b").allow, false, "enabled guard with no expected model must fail closed");
assert.equal(guardDecision(true, "a/b", undefined).allow, false, "unknown active model must fail closed");
assert.equal(guardDecision(true, "a/b", "a/c").allow, false, "mismatched model must fail closed");
assert.deepEqual(guardDecision(true, "a/b", "a/b"), { allow: true });

const dir = await mkdtemp(path.join(os.tmpdir(), "yorishiro-model-guard-"));
process.env.YORISHIRO_MODEL_GUARD = "1";
process.env.YORISHIRO_EXPECTED_MODEL = "opencode-go/deepseek-v4.1-flash";
process.env.YORISHIRO_ROLE = "Worker · DeepSeek";
process.env.YORISHIRO_GUARD_LOG = path.join(dir, "guard.log");
const handlers = {};
load({ on(name, handler) { handlers[name] = handler; }, registerTool() {} });
assert.equal(typeof handlers.tool_call, "function");
assert.equal(typeof handlers.model_select, "function");
assert.equal(typeof handlers.session_start, "function");
assert.equal(handlers.before_provider_request, undefined, "provider request payload is not a blocking identity boundary");

const notifications = [];
const context = model => ({ model, ui: { notify: (message, level) => notifications.push({ message, level }) } });
assert.equal(await handlers.tool_call({ toolName: "bash" }, { model: { provider: "opencode-go", id: "deepseek-v4.1-flash" } }), undefined);
const mismatch = await handlers.tool_call({ toolName: "edit" }, context({ provider: "openai", id: "gpt-5.6-sol" }));
assert.equal(mismatch.block, true);
assert.equal(mismatch.terminate, true);
assert.match(mismatch.reason, /MODEL_GUARD/);
assert.match(mismatch.reason, /opencode-go\/deepseek-v4\.1-flash/);
const unknown = await handlers.tool_call({ toolName: "bash" }, context(undefined));
assert.equal(unknown.block, true);
assert.match(unknown.reason, /unknown/);
const incomplete = await handlers.tool_call({ toolName: "bash" }, context({ provider: "opencode-go" }));
assert.equal(incomplete.block, true, "partial model identity must fail closed");

await handlers.model_select({ model: { provider: "openai-codex", id: "gpt-5.6-sol" }, source: "cycle" }, context({ provider: "opencode-go", id: "deepseek-v4.1-flash" }));
assert.ok(notifications.some(item => item.level === "warning" && /MODEL_GUARD/.test(item.message)));
const auditLines = (await readFile(process.env.YORISHIRO_GUARD_LOG, "utf8")).trim().split("\n").map(line => JSON.parse(line));
assert.ok(auditLines.some(entry => entry.event === "model_select_mismatch" && entry.source === "cycle"));
assert.ok(auditLines.some(entry => entry.event === "tool_call_blocked" && entry.tool === "edit"));

delete process.env.YORISHIRO_EXPECTED_MODEL;
const missingEnvHandlers = {};
load({ on(name, handler) { missingEnvHandlers[name] = handler; }, registerTool() {} });
const noExpected = await missingEnvHandlers.tool_call({ toolName: "bash" }, context({ provider: "opencode-go", id: "deepseek-v4.1-flash" }));
assert.equal(noExpected.block, true, "missing expected model env must fail closed");

process.env.YORISHIRO_MODEL_GUARD = "0";
const disabledHandlers = {};
load({ on(name, handler) { disabledHandlers[name] = handler; }, registerTool() {} });
assert.equal(await disabledHandlers.tool_call({ toolName: "bash" }, context({ provider: "any", id: "thing" })), undefined, "disabled guard is inert");

await rm(dir, { recursive: true, force: true });
delete process.env.YORISHIRO_MODEL_GUARD;
delete process.env.YORISHIRO_EXPECTED_MODEL;
delete process.env.YORISHIRO_ROLE;
delete process.env.YORISHIRO_GUARD_LOG;
console.log("model guard mismatch/correct/unknown tests passed");
