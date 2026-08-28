export type PaneMonitorState = "settled" | "exited" | "startup-timeout" | "timeout" | "process-info-failure" | "aborted";
export type PanePoll = { status?: string; processInfo: unknown; processInfoValid: boolean };
export type MonitorStopResult = { stopped: boolean; evidence: string };

export async function stopAfterMonitorFailure(state: PaneMonitorState, stop: () => Promise<boolean>): Promise<MonitorStopResult | undefined> {
  if (!["startup-timeout", "timeout", "process-info-failure", "aborted"].includes(state)) return undefined;
  const stopped = await stop();
  const reason = state === "startup-timeout" ? "startup deadline expired" : state === "timeout" ? "stage deadline expired" : state === "process-info-failure" ? "Herdr process-info remained unavailable or invalid" : "pipeline aborted";
  return { stopped, evidence: stopped ? `${reason}; active child stopped; pane preserved` : `${reason}; Herdr could not confirm active child stopped; pane preserved` };
}

export async function routeMonitorFailure(state: PaneMonitorState, stop: () => Promise<boolean>): Promise<{ status: "failed" | "aborted"; evidence: string } | undefined> {
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

export async function monitorPane(options: {
  reportExists: () => boolean;
  poll: () => Promise<PanePoll>;
  signal?: AbortSignal;
  onUpdate: (message: string) => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs: number;
  startupGraceMs: number;
  pollIntervalMs?: number;
}): Promise<PaneMonitorState> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const deadline = now() + options.timeoutMs;
  const startupDeadline = now() + options.startupGraceMs;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  let state: "startup" | "monitoring" = "startup";
  let invalidProcessInfoPolls = 0;
  while (now() < deadline) {
    if (options.signal?.aborted) return "aborted";
    const observation = await options.poll();
    if (!observation.processInfoValid) {
      invalidProcessInfoPolls++;
      options.onUpdate(`process-info unavailable or invalid (attempt ${invalidProcessInfoPolls})`);
      if (invalidProcessInfoPolls >= 3) return "process-info-failure";
      await sleep(pollIntervalMs);
      continue;
    }
    invalidProcessInfoPolls = 0;
    const hasPi = hasExactPiIdentity(observation.processInfo);
    if (hasPi) state = "monitoring";
    if (state === "monitoring") {
      if (!hasPi) return "exited";
      if ((observation.status === "idle" || observation.status === "unknown") && options.reportExists()) return "settled";
      options.onUpdate(`pane is ${observation.status ?? "running"}`);
    } else if (now() >= startupDeadline) {
      return "startup-timeout";
    } else {
      options.onUpdate(`pane is starting; waiting for exact Pi identity`);
    }
    await sleep(pollIntervalMs);
  }
  return "timeout";
}
