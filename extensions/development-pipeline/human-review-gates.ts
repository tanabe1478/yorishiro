import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

export type ReviewMode = "ask" | "required" | "skip";
export type HumanDecision = "approved" | "rejected" | "skipped" | "unavailable" | "error" | "aborted" | "timeout" | "invalid";
type Clock = () => Date;
type Sleep = (ms: number) => Promise<void>;

const VALID_MODES: readonly ReviewMode[] = ["ask", "required", "skip"];
export function resolveReviewMode(mode?: string): ReviewMode { const value = mode ?? "ask"; if (!VALID_MODES.includes(value as ReviewMode)) throw new Error(`レビュー方式が不正です: ${value}`); return value as ReviewMode; }
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
    const onAbort = () => finish(reject, Object.assign(new Error("人間レビューが中断されました"), { code: "ABORTED" }));
    const timer = setTimeout(() => finish(reject, Object.assign(new Error("人間レビューの応答がタイムアウトしました"), { code: "TIMEOUT" })), timeoutMs);
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
    if (!reviewId) return { ...base, decision: "error", error: "計画レビューがreviewIdを返しませんでした" };
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

/** diffai専用executor。shellを使わず独立process groupを終了させ、close確認後にresolveする。 */
export function executeDiffProcess(command: string, args: string[], cwd: string, signal?: AbortSignal, graceMs = 2000): Promise<{ code: number; stdout: string; stderr?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined, finalTimer: ReturnType<typeof setTimeout> | undefined;
    child.stdout.on("data", data => { stdout += data.toString(); });
    child.stderr.on("data", data => { stderr += data.toString(); });
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (finalTimer) clearTimeout(finalTimer);
      signal?.removeEventListener("abort", stop);
      resolve({ code, stdout, stderr });
    };
    const signalGroup = (name: NodeJS.Signals) => {
      if (!child.pid) { stderr += "diffai process IDを取得できませんでした"; finish(1); return false; }
      try { process.kill(-child.pid, name); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
        stderr += `diffai process groupへ${name}を送信できませんでした: ${error instanceof Error ? error.message : String(error)}`;
        child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(1); return false;
      }
    };
    const stop = () => {
      if (settled || !signalGroup("SIGTERM")) return;
      forceTimer = setTimeout(() => {
        if (settled || !signalGroup("SIGKILL")) return;
        finalTimer = setTimeout(() => {
          if (settled) return;
          stderr += "diffai process groupの停止を確認できませんでした";
          child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(1);
        }, graceMs);
      }, graceMs);
    };
    child.on("error", error => { stderr += error.message; finish(1); });
    child.on("close", code => finish(code ?? 1));
    if (signal) { if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true }); }
  });
}
export type DiffGateOptions = { mode?: string; cwd: string; exec: DiffExec; confirm?: () => boolean | Promise<boolean>; signal?: AbortSignal; timeoutMs?: number; stopTimeoutMs?: number };
export type DiffGateResult = { decision: HumanDecision; feedback?: string; replyFile?: string; raw?: unknown; error?: string };
export async function reviewDiff(options: DiffGateOptions): Promise<DiffGateResult> {
  const modeDecision = await gate(options.mode, options.confirm);
  if (modeDecision) return { decision: modeDecision };
  if (aborted(options.signal)) return { decision: "aborted" };
  const args = ["--yes", "github:tanabe1478/diffai", "--cwd", options.cwd];
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timeout = options.timeoutMs ?? 30000;
  const timeoutMarker = Symbol("diff-review-timeout"), abortMarker = Symbol("diff-review-abort");
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  try {
    const execution = options.exec("npx", args, controller.signal);
    const externalAbort = options.signal ? new Promise<typeof abortMarker>(resolve => options.signal!.addEventListener("abort", () => resolve(abortMarker), { once: true })) : new Promise<never>(() => {});
    const result = await Promise.race([execution, externalAbort, new Promise<typeof timeoutMarker>(resolve => setTimeout(() => resolve(timeoutMarker), timeout))]);
    const waitForStop = async () => await Promise.race([
      execution.then(() => true, () => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), options.stopTimeoutMs ?? 6000)),
    ]);
    if (result === timeoutMarker || timedOut) {
      if (!await waitForStop()) return { decision: "error", error: "差分レビューprocessの停止を確認できませんでした" };
      return { decision: "timeout", error: "差分レビューの応答がタイムアウトしました" };
    }
    if (result === abortMarker) {
      if (!await waitForStop()) return { decision: "error", error: "中断した差分レビューprocessの停止を確認できませんでした" };
      return { decision: "aborted" };
    }
    if (aborted(options.signal)) return { decision: "aborted" };
    if (result.code !== 0) return { decision: "unavailable", error: result.stderr || `diffai exited with ${result.code}` };
    const marker = result.stdout.match(/(?:^|\n)DIFFAI_REVIEW_RESULT=(\{[\s\S]*\})\s*$/);
    if (!marker) return { decision: "invalid", error: "diffaiのレビュー結果マーカーがありません" };
    let raw: any; try { raw = JSON.parse(marker[1]); } catch { return { decision: "invalid", error: "diffaiのレビュー結果が有効なJSONではありません" }; }
    if (raw.decision !== "approved" && raw.decision !== "changes_requested") return { decision: "invalid", raw, error: "diffaiの判定が不明です" };
    return { decision: raw.decision, feedback: raw.feedback ?? raw.summary, replyFile: raw.replyFile, raw };
  } catch (error) {
    if (timedOut) return { decision: "timeout", error: "差分レビューの応答がタイムアウトしました" };
    if (aborted(options.signal) || (error as any)?.code === "ABORTED") return { decision: "aborted" };
    return { decision: "unavailable", error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
export const runDiffReview = reviewDiff;
