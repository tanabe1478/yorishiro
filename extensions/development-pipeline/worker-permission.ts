import { RUNTIME, type Runtime } from "./models.ts";

/**
 * How the Claude runtime's Worker is started. `default` keeps `--permission-mode dontAsk`; `bypass` starts it with
 * `--dangerously-skip-permissions`, the only setting that lets the Worker's file tools write protected places such as
 * `.claude/skills/` (claude 2.1.322: dontAsk with Write/Edit rules and acceptEdits are all refused there).
 * The Reviewer never reads this: it is always `--restricted` with dontAsk.
 */
export const WORKER_PERMISSION_MODES = ["default", "bypass"] as const;
export type WorkerPermissionMode = (typeof WORKER_PERMISSION_MODES)[number];

export const WORKER_PERMISSION_FLAGS: Record<WorkerPermissionMode, string> = {
  default: "--permission-mode dontAsk",
  bypass: "--dangerously-skip-permissions",
};

export type WorkerPermission = { mode: WorkerPermissionMode; flag: string };

/** The mode of a run. Throws before the run starts for an unknown value, or for `bypass` outside the Claude runtime. */
export function resolveWorkerPermissionMode(input: unknown, runtime: Runtime = RUNTIME): WorkerPermissionMode {
  if (input === undefined) return "default";
  if (typeof input !== "string" || !(WORKER_PERMISSION_MODES as readonly string[]).includes(input)) throw new Error(`workerPermissionMode must be one of ${WORKER_PERMISSION_MODES.join(", ")}`);
  if (input === "bypass" && runtime !== "claude") throw new Error("workerPermissionMode bypass is only available in the Claude runtime (yorishiro-pipeline)");
  return input as WorkerPermissionMode;
}

/** What run.json records: the adopted mode and the launcher flag it maps to. */
export function describeWorkerPermission(mode: WorkerPermissionMode): WorkerPermission {
  return { mode, flag: WORKER_PERMISSION_FLAGS[mode] };
}
