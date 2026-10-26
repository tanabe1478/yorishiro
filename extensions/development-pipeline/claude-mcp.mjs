// Stage-scoped stdio MCP server for Claude Code children. It exposes the same
// `submit_stage_report` and `run_verification_command` tools as the Pi
// extensions, running their validator and sandbox code unchanged.
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { collectTools } from "./standalone.mjs";

const SERVER_INFO = { name: "yorishiro", version: "1.0.0" };
const DEFAULT_PROTOCOL = "2025-06-18";

const str = description => ({ type: "string", ...(description ? { description } : {}) });
const object = (properties, optional = []) => ({ type: "object", properties, required: Object.keys(properties).filter(key => !optional.includes(key)), additionalProperties: false });
const WORKER_SCHEMA = object({
  verdict: { type: "string", enum: ["COMPLETED", "BLOCKED"] },
  summary: str("日本語の要約"),
  changedScope: str("日本語の変更範囲"),
  evidence: str("日本語の検証証跡と未達成の前提"),
  completedPlanItems: { type: "array", items: object({ id: str("quality contractのplanItems ID"), evidence: str("日本語の観測結果") }) },
  changedPaths: { type: "array", items: str("baseline以後に変化したrepository-relative path") },
});
const REVIEWER_SCHEMA = object({
  verdict: { type: "string", enum: ["APPROVED", "APPROVED_WITH_NOTES", "CHANGES_REQUESTED", "NEEDS_PLANNER"] },
  summary: str("日本語の要約"),
  blockingFindings: { type: "array", items: object({ id: str(), severity: { type: "string", enum: ["critical", "high"] }, target: str(), reproduction: str(), userImpact: str(), expectedOutcome: str(), route: { type: "string", enum: ["worker", "planner"] }, discovery: { type: "string", enum: ["initial", "repair_regression", "previously_missed"] }, missedReason: str() }, ["missedReason"]) },
  nonBlockingNotes: { type: "array", items: object({ id: str(), severity: { type: "string", enum: ["medium", "low"] }, target: str(), note: str() }) },
  plannerQuestions: { type: "array", items: str() },
});
const VERIFY_SCHEMA = object({ program: str("実行するprogram"), args: { type: "array", items: str() }, timeoutMs: { type: "integer", minimum: 1000, maximum: 300000 } }, ["timeoutMs"]);

export function inputSchema(name, env = process.env) {
  if (name === "run_verification_command") return VERIFY_SCHEMA;
  return env.YORISHIRO_REPORT_SCHEMA === "reviewer" ? REVIEWER_SCHEMA : WORKER_SCHEMA;
}

export async function loadTools(env = process.env) {
  const wanted = (env.YORISHIRO_MCP_TOOLS ?? "submit_stage_report").split(",").map(name => name.trim()).filter(Boolean);
  const extensions = [];
  if (wanted.includes("submit_stage_report")) extensions.push((await import("./stage-reporter.ts")).default);
  if (wanted.includes("run_verification_command")) extensions.push((await import("./verifier-tools.ts")).default);
  const tools = collectTools(...extensions);
  for (const name of [...tools.keys()]) if (!wanted.includes(name)) tools.delete(name);
  return tools;
}

function textOf(result) {
  const parts = Array.isArray(result?.content) ? result.content.filter(item => item?.type === "text" && typeof item.text === "string") : [];
  return parts.length ? parts : [{ type: "text", text: "ok" }];
}

export function createServer(tools, write) {
  const running = new Map();
  const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });
  return {
    abortAll() { for (const controller of running.values()) controller.abort(); },
    async handle(message) {
      if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return;
      const { id, method, params } = message;
      if (method === "notifications/cancelled") { running.get(params?.requestId)?.abort(); return; }
      if (id === undefined) return;
      if (method === "initialize") return reply(id, { protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
      if (method === "ping") return reply(id, {});
      if (method === "tools/list") return reply(id, { tools: [...tools.values()].map(tool => ({ name: tool.name, description: tool.description, inputSchema: inputSchema(tool.name) })) });
      if (method === "tools/call") {
        const tool = tools.get(params?.name);
        if (!tool) return reply(id, { content: [{ type: "text", text: `Unknown tool: ${params?.name}` }], isError: true });
        const controller = new AbortController();
        running.set(id, controller);
        try {
          const result = await tool.execute(String(id), params?.arguments ?? {}, controller.signal, () => {}, {});
          return reply(id, { content: textOf(result) });
        } catch (error) {
          return reply(id, { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
        } finally {
          running.delete(id);
        }
      }
      return fail(id, -32601, `Method not found: ${method}`);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const tools = await loadTools();
  const server = createServer(tools, message => process.stdout.write(`${JSON.stringify(message)}\n`));
  const lines = createInterface({ input: process.stdin });
  const pending = new Set();
  lines.on("line", line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`); return; }
    const task = server.handle(message).catch(error => process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`));
    pending.add(task);
    task.finally(() => pending.delete(task));
  });
  lines.on("close", async () => { server.abortAll(); await Promise.allSettled(pending); process.exit(0); });
}
