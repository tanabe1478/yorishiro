export type PaneMonitorState = "settled" | "exited" | "report-missing" | "startup-timeout" | "timeout" | "process-info-failure" | "aborted";
export type PanePoll = { status?: string; processInfo: unknown; processInfoValid: boolean };
export type MonitorStopResult = { stopped: boolean; evidence: string };

export async function stopAfterMonitorFailure(state: PaneMonitorState, stop: () => Promise<boolean>): Promise<MonitorStopResult | undefined> {
  if (!["startup-timeout", "timeout", "process-info-failure", "aborted"].includes(state)) return undefined;
  const stopped = await stop();
  const reason = state === "startup-timeout" ? "startup deadline expired" : state === "timeout" ? "stage deadline expired" : state === "process-info-failure" ? "Herdr process-info remained unavailable or invalid" : "pipeline aborted";
  return { stopped, evidence: stopped ? `${reason}; active child stopped; pane preserved` : `${reason}; Herdr could not confirm active child stopped; pane preserved` };
}

export async function routeMonitorFailure(state: PaneMonitorState, stop: () => Promise<boolean>): Promise<{ status: "failed" | "aborted"; evidence: string } | undefined> {
  if (state === "report-missing") return { status: "failed", evidence: "durable report missing after finite quiescent grace; pane preserved" };
  const result = await stopAfterMonitorFailure(state, stop);
  return result ? { status: state === "aborted" ? "aborted" : "failed", evidence: result.evidence } : undefined;
}

/** Herdr process-info may be nested, but the executable identity must be exact. */
export function hasExactPiIdentity(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.argv0 === "pi") return true;
  return Object.values(record).some(hasExactPiIdentity);
}

const QUIESCENT_STATUSES = new Set(["idle", "done", "completed"]);
const ACTIVE_STATUSES = new Set(["active", "starting", "running", "working", "busy", "thinking", "tool_call", "tool-call", "streaming", "executing", "waiting"]);

export function isQuiescentAgentStatus(status?: string): boolean {
  return typeof status === "string" && QUIESCENT_STATUSES.has(status.toLowerCase());
}

/** Unknown or future Herdr statuses are deliberately not treated as active. */
export function isActiveAgentStatus(status?: string): boolean {
  return typeof status === "string" && ACTIVE_STATUSES.has(status.toLowerCase());
}

export async function monitorPane(options: {
  reportExists: () => boolean;
  poll: () => Promise<PanePoll>;
  signal?: AbortSignal;
  onUpdate: (message: string) => void | Promise<void>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs: number;
  startupGraceMs: number;
  pollIntervalMs?: number;
  reportSettlementGraceMs?: number;
  reportMissingGraceMs?: number;
}): Promise<PaneMonitorState> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const deadline = now() + options.timeoutMs;
  const startupDeadline = now() + options.startupGraceMs;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const reportSettlementGraceMs = options.reportSettlementGraceMs ?? 5000;
  const reportMissingGraceMs = options.reportMissingGraceMs ?? reportSettlementGraceMs;
  let state: "startup" | "monitoring" = "startup";
  let invalidProcessInfoPolls = 0;
  let reportObservedAt: number | undefined;
  let activeObserved = false;
  let reportMissingSince: number | undefined;
  while (now() < deadline) {
    if (options.signal?.aborted) return "aborted";
    const observation = await options.poll();
    if (!observation.processInfoValid) {
      invalidProcessInfoPolls++;
      await options.onUpdate(`process-info unavailable or invalid (attempt ${invalidProcessInfoPolls})`);
      if (invalidProcessInfoPolls >= 3) return "process-info-failure";
      await sleep(pollIntervalMs);
      continue;
    }
    invalidProcessInfoPolls = 0;
    const hasPi = hasExactPiIdentity(observation.processInfo);
    if (hasPi) state = "monitoring";
    if (state === "monitoring") {
      if (!hasPi) return "exited";
      const hasReport = options.reportExists();
      const quiescent = isQuiescentAgentStatus(observation.status);
      if (hasReport && reportObservedAt === undefined) {
        reportObservedAt = now();
        await options.onUpdate("durable reportを検出し、Piの完了状態を確認しています");
      }
      if (hasReport && (quiescent || now() - reportObservedAt! >= reportSettlementGraceMs)) return "settled";
      if (!hasReport) {
        if (isActiveAgentStatus(observation.status)) {
          activeObserved = true;
          reportMissingSince = undefined;
        } else if (quiescent && (activeObserved || now() >= startupDeadline)) {
          if (reportMissingSince === undefined) {
            reportMissingSince = now();
            await options.onUpdate("durable reportがなく、quiescent状態のreport-missing猶予を開始しました");
          }
          if (now() - reportMissingSince >= reportMissingGraceMs) return "report-missing";
        } else {
          // An unknown status is not evidence of quiescence. Start a new grace interval when idle returns.
          reportMissingSince = undefined;
        }
      }
      await options.onUpdate(`pane is ${observation.status ?? "unknown"}`);
    } else if (now() >= startupDeadline) {
      return "startup-timeout";
    } else {
      await options.onUpdate(`pane is starting; waiting for exact Pi identity`);
    }
    await sleep(pollIntervalMs);
  }
  return "timeout";
}
