import * as fs from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { modelIdentity } from "./models.ts";

export type GuardDecision = { allow: true } | { allow: false; reason: string };

/**
 * Pure decision used by the runtime guard and by tests.
 *
 * The guard fails closed: an enabled guard with an unset expected model, or a
 * session whose active model identity cannot be read, blocks tool execution.
 */
export function guardDecision(enabled: boolean, expected: string | undefined, actual: string | undefined): GuardDecision {
  if (!enabled) return { allow: true };
  const wanted = typeof expected === "string" ? expected.trim() : "";
  if (!wanted) return { allow: false, reason: "MODEL_GUARD: expected model is not configured; tool execution blocked" };
  if (!actual) return { allow: false, reason: `MODEL_GUARD: active model identity is unknown; expected=${wanted}; tool execution blocked` };
  if (actual !== wanted) return { allow: false, reason: `MODEL_GUARD: active model=${actual}; expected=${wanted}; tool execution blocked; do not switch models, return to the Planner` };
  return { allow: true };
}

/**
 * Runtime model guard for fixed-model child sessions.
 *
 * This blocks Pi tool execution (edit/write/bash/report and every other tool)
 * through the `tool_call` boundary whenever the active model is not the pinned
 * model. It is not a security sandbox: a deliberately hostile Worker, a
 * compromised Pi runtime, or an arbitrary nested shell program can still act
 * outside Pi's tool layer. It exists to stop accidental model selection,
 * cycling, or restore from performing side effects in a pinned child.
 */
export default function (pi: ExtensionAPI) {
  const enabled = process.env.YORISHIRO_MODEL_GUARD === "1";
  const expected = process.env.YORISHIRO_EXPECTED_MODEL;
  const role = process.env.YORISHIRO_ROLE ?? "child";
  const auditPath = process.env.YORISHIRO_GUARD_LOG;

  const audit = async (event: string, detail: Record<string, unknown>) => {
    if (!auditPath) return;
    try {
      await fs.appendFile(auditPath, `${JSON.stringify({ at: new Date().toISOString(), event, role, expected: expected ?? null, ...detail })}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Audit is evidence, never a reason to unblock a tool call.
    }
  };
  const notify = (ctx: any, message: string) => {
    try {
      ctx?.ui?.notify?.(message, "warning");
    } catch {
      // No UI in RPC or headless sessions.
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    if (!enabled) return;
    const decision = guardDecision(true, expected, modelIdentity((ctx as any)?.model));
    if (!decision.allow) {
      notify(ctx, decision.reason);
      await audit("session_start_mismatch", { actual: modelIdentity((ctx as any)?.model) ?? null, reason: decision.reason });
    }
  });

  pi.on("model_select", async (event, ctx) => {
    if (!enabled) return;
    const actual = modelIdentity((event as any)?.model);
    const decision = guardDecision(true, expected, actual);
    if (!decision.allow) {
      notify(ctx, decision.reason);
      await audit("model_select_mismatch", { actual: actual ?? null, source: (event as any)?.source ?? null, reason: decision.reason });
    }
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!enabled) return;
    const actual = modelIdentity(ctx?.model);
    const decision = guardDecision(true, expected, actual);
    if (decision.allow) return;
    await audit("tool_call_blocked", { actual: actual ?? null, tool: event?.toolName ?? null, reason: decision.reason });
    return { block: true, terminate: true, reason: decision.reason };
  });
}
