/** Bounds and default of one stage's deadline (Worker or Reviewer pane), in milliseconds. */
export const MIN_STAGE_TIMEOUT_MS = 60_000;
export const MAX_STAGE_TIMEOUT_MS = 14_400_000;
/** 90 minutes: longer than one verification command (MAX_CHECK_TIMEOUT_MS, 30 minutes) plus the Worker's own work. */
export const DEFAULT_STAGE_TIMEOUT_MS = 5_400_000;
export type StageTimeoutSource = "input" | "env" | "default";
export type StageTimeout = { ms: number; source: StageTimeoutSource };

/**
 * The stage deadline of a run. Precedence: the `stageTimeoutMs` input, then YORISHIRO_STAGE_TIMEOUT_MS, then the default.
 * The input must be an integer in [MIN_STAGE_TIMEOUT_MS, MAX_STAGE_TIMEOUT_MS]. The environment variable is kept for
 * backward compatibility and is not range-limited (tests set it to a few hundred ms); it must be a positive number.
 * Throws before the run starts when a value is invalid.
 */
export function resolveStageTimeout(input: unknown, env: Record<string, string | undefined> = process.env): StageTimeout {
  if (input !== undefined) {
    if (typeof input !== "number" || !Number.isInteger(input) || input < MIN_STAGE_TIMEOUT_MS || input > MAX_STAGE_TIMEOUT_MS) throw new Error(`stageTimeoutMs must be an integer from ${MIN_STAGE_TIMEOUT_MS} to ${MAX_STAGE_TIMEOUT_MS}`);
    return { ms: input, source: "input" };
  }
  const raw = env.YORISHIRO_STAGE_TIMEOUT_MS;
  if (raw !== undefined && raw.trim() !== "") {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`YORISHIRO_STAGE_TIMEOUT_MS must be a positive number of milliseconds (got ${JSON.stringify(raw)})`);
    return { ms: value, source: "env" };
  }
  return { ms: DEFAULT_STAGE_TIMEOUT_MS, source: "default" };
}
