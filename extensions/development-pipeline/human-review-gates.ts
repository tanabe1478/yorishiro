import { createHash } from "node:crypto";

export type ReviewMode = "ask" | "required" | "skip";
export type HumanDecision = "approved" | "rejected" | "skipped" | "unavailable" | "error" | "aborted" | "timeout" | "invalid";
type Clock = () => Date;
type Sleep = (ms: number) => Promise<void>;

const VALID_MODES: readonly ReviewMode[] = ["ask", "required", "skip"];
export function resolveReviewMode(mode?: string): ReviewMode { const value = mode ?? "ask"; if (!VALID_MODES.includes(value as ReviewMode)) throw new Error(`Invalid review mode: ${value}`); return value as ReviewMode; }
async function gate(mode: string | undefined, confirm?: () => boolean | Promise<boolean>): Promise<HumanDecision | undefined> {
  const resolved = resolveReviewMode(mode);
  if (resolved === "skip") return "skipped";
  if (resolved === "required") return undefined;
  if (!confirm) return "unavailable";
  return (await confirm()) ? undefined : "skipped";
}
function hash(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function aborted(signal?: AbortSignal) { return !!signal?.aborted; }
function wait(ms: number, signal?: AbortSignal, sleep: Sleep = async n => new Promise(resolve => setTimeout(resolve, n))) { return aborted(signal) ? Promise.resolve() : sleep(ms); }

export type PlanGateOptions = {
  mode?: string; planContent: string; planFilePath: string; origin: string; eventBus: { emit(name: string, payload: Record<string, unknown>): Promise<unknown> | unknown };
  requestId?: string; confirm?: () => boolean | Promise<boolean>; signal?: AbortSignal; pollIntervalMs?: number; timeoutMs?: number; now?: Clock; sleep?: Sleep;
};
export type PlanGateResult = { decision: HumanDecision; hash: string; planFilePath: string; origin: string; requestId: string; reviewId?: string; approvedAt?: string; feedback?: string; error?: string };

async function eventRequest(bus: PlanGateOptions["eventBus"], requestId: string, action: string, payload: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 30000): Promise<any> {
  if (aborted(signal)) throw Object.assign(new Error("aborted"), { code: "ABORTED" });
  return await new Promise<any>((resolve, reject) => {
    let settled = false;
    const finish = (fn: (value?: any) => void, value?: any) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); fn(value); };
    const onAbort = () => finish(reject, Object.assign(new Error("aborted"), { code: "ABORTED" }));
    const timer = setTimeout(() => finish(reject, Object.assign(new Error("event response timed out"), { code: "TIMEOUT" })), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(bus.emit("plannotator:request", { requestId, action, payload, respond: (value: unknown) => finish(resolve, value) })).catch(error => finish(reject, error));
  });
}
export async function reviewPlan(options: PlanGateOptions): Promise<PlanGateResult> {
  const requestId = options.requestId ?? `plan-${Date.now()}`;
  const base = { hash: hash(options.planContent), planFilePath: options.planFilePath, origin: options.origin, requestId };
  const skipped = await gate(options.mode, options.confirm);
  if (skipped === "skipped" || skipped === "unavailable") return { ...base, decision: skipped };
  if (aborted(options.signal)) return { ...base, decision: "aborted" };
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep;
  const timeout = options.timeoutMs ?? 30000, started = now().getTime();
  try {
    const startedResponse = await eventRequest(options.eventBus, requestId, "plan-review", { planContent: options.planContent, planFilePath: options.planFilePath, origin: options.origin }, options.signal, timeout);
    const initial = startedResponse?.result ?? startedResponse;
    const reviewId = initial?.reviewId;
    if (!reviewId) return { ...base, decision: "error", error: "plan-review did not return reviewId" };
    let status: any = initial;
    while (status?.status !== "completed") {
      if (aborted(options.signal)) return { ...base, decision: "aborted", reviewId };
      if (now().getTime() - started >= timeout) return { ...base, decision: "timeout", reviewId };
      await wait(options.pollIntervalMs ?? 100, options.signal, sleep);
      const response = await eventRequest(options.eventBus, requestId, "review-status", { reviewId }, options.signal, Math.max(1, timeout - (now().getTime() - started)));
      status = response?.result ?? response;
      if (status?.status === "unavailable") return { ...base, decision: "unavailable", reviewId, error: status.error };
      if (status?.status === "error") return { ...base, decision: "error", reviewId, error: status.error };
    }
    const decision = status.approved ? "approved" : "rejected";
    return { ...base, decision, reviewId, approvedAt: decision === "approved" ? now().toISOString() : undefined, feedback: status.feedback };
  } catch (error) {
    if (aborted(options.signal) || (error as any)?.code === "ABORTED") return { ...base, decision: "aborted" };
    if ((error as any)?.code === "TIMEOUT") return { ...base, decision: "timeout", error: error instanceof Error ? error.message : String(error) };
    return { ...base, decision: "error", error: error instanceof Error ? error.message : String(error) };
  }
}
export const runPlanReview = reviewPlan;

export type DiffExec = (command: string, args: string[], signal?: AbortSignal) => Promise<{ code: number; stdout: string; stderr?: string }>;
export type DiffGateOptions = { mode?: string; cwd: string; exec: DiffExec; confirm?: () => boolean | Promise<boolean>; signal?: AbortSignal };
export type DiffGateResult = { decision: HumanDecision; feedback?: string; replyFile?: string; raw?: unknown; error?: string };
export async function reviewDiff(options: DiffGateOptions): Promise<DiffGateResult> {
  const modeDecision = await gate(options.mode, options.confirm);
  if (modeDecision) return { decision: modeDecision };
  if (aborted(options.signal)) return { decision: "aborted" };
  const args = ["--yes", "github:tanabe1478/diffai", "--cwd", options.cwd];
  try {
    const result = await options.exec("npx", args, options.signal);
    if (aborted(options.signal)) return { decision: "aborted" };
    if (result.code !== 0) return { decision: "unavailable", error: result.stderr || `diffai exited with ${result.code}` };
    const marker = result.stdout.match(/(?:^|\n)DIFFAI_REVIEW_RESULT=(\{[\s\S]*\})\s*$/);
    if (!marker) return { decision: "invalid", error: "DIFFAI_REVIEW_RESULT marker is missing" };
    let raw: any; try { raw = JSON.parse(marker[1]); } catch { return { decision: "invalid", error: "DIFFAI_REVIEW_RESULT is not valid JSON" }; }
    if (raw.decision !== "approved" && raw.decision !== "changes_requested") return { decision: "invalid", raw, error: "unknown diffai decision" };
    return { decision: raw.decision, feedback: raw.feedback ?? raw.summary, replyFile: raw.replyFile, raw };
  } catch (error) {
    if (aborted(options.signal) || (error as any)?.code === "ABORTED") return { decision: "aborted" };
    return { decision: "unavailable", error: error instanceof Error ? error.message : String(error) };
  }
}
export const runDiffReview = reviewDiff;
