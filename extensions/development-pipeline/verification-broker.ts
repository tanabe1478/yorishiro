import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import * as path from "node:path";
import { runSandboxedVerification } from "./verifier-tools.ts";
import { BROKER_MARKER, MAX_REQUEST_BYTES, REQUEST_SUFFIX, atomicWriteFile, cancelFile, isRequestId, requestFile, requestTimingFromEnv, resultFile, validateVerificationRequest, type VerificationOutcome, type VerificationResultFile, type VerificationStage } from "./verification-requests.ts";

/** Where the evidence of a request goes under `<artifactDir>/evidence/`, decided by the stage the orchestrator is waiting for. */
export function evidenceOwnerForStage(stage: VerificationStage) { return stage === "implement" ? "worker-verification" : "reviewer"; }

export type RunVerification = (program: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal, options?: { evidenceDir?: string; repositories?: readonly string[]; workdir?: string }) => Promise<VerificationOutcome>;
export type VerificationBrokerOptions = {
  /** `<artifactDir>/verification-requests/<stage>/` */
  requestDir: string;
  /** `<artifactDir>/evidence` */
  evidenceRoot: string;
  stage: VerificationStage;
  /** The run's target (the workspace root with `repositories`). */
  cwd: string;
  repositories?: readonly string[];
  pollMs?: number;
  /** How long stop() waits for aborted commands to finish (default 30 s); it then goes on without them. */
  stopGraceMs?: number;
  /** For tests; the default is runSandboxedVerification, the function the quality gate calls. */
  run?: RunVerification;
};
export type VerificationBroker = { requestDir: string; stop(): Promise<void> };

/**
 * Accept verification requests of one stage and run each with the same runSandboxedVerification as the quality gate,
 * in this process, so a command sees the orchestrator's environment and not the child pane's shell. Requests run
 * concurrently (each in its own snapshot). `stop()` aborts what is running, answers what was not started, and withdraws broker.json.
 */
export async function startVerificationBroker(options: VerificationBrokerOptions): Promise<VerificationBroker> {
  const { requestDir, evidenceRoot, stage, cwd, repositories } = options;
  const pollMs = Math.max(5, options.pollMs ?? requestTimingFromEnv().pollMs);
  const run: RunVerification = options.run ?? (runSandboxedVerification as RunVerification);
  const owner = evidenceOwnerForStage(stage);
  await mkdir(requestDir, { recursive: true, mode: 0o700 });
  const seen = new Set<string>();
  const inflight = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const hasResult = (id: string) => lstat(resultFile(requestDir, id)).then(() => true, () => false);
  const writeResult = (id: string, value: VerificationResultFile) => atomicWriteFile(resultFile(requestDir, id), JSON.stringify(value));
  const idsOf = async () => (await readdir(requestDir).catch(() => [] as string[])).filter(name => name.endsWith(REQUEST_SUFFIX)).map(name => name.slice(0, -REQUEST_SUFFIX.length)).filter(isRequestId);

  /** Answer every request that has no result with an error. Used for requests left by an earlier stage and at stop. */
  const sweep = async (reason: string) => {
    for (const id of await idsOf()) if (!(await hasResult(id))) await writeResult(id, { id, status: "failed", error: reason }).catch(() => {});
  };

  const handle = async (id: string, controller: AbortController) => {
    const file = requestFile(requestDir, id);
    let raw: string;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size > MAX_REQUEST_BYTES) return await writeResult(id, { id, status: "rejected", error: "verification request must be a regular file of at most 1 MiB" });
      raw = await readFile(file, "utf8");
    } catch (error) { return await writeResult(id, { id, status: "failed", error: `could not read the verification request: ${error instanceof Error ? error.message : String(error)}` }); }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return await writeResult(id, { id, status: "rejected", error: "verification request is not valid JSON" }); }
    const checked = validateVerificationRequest(parsed, repositories);
    if (!checked.valid) return await writeResult(id, { id, status: "rejected", error: checked.error });
    const { program, args, timeoutMs, cwd: workdir } = checked.request;
    const evidenceDir = path.join(evidenceRoot, owner, id);
    try {
      const outcome = await run(program, args, cwd, timeoutMs, controller.signal, { evidenceDir, ...(repositories ? { repositories } : {}), ...(workdir !== undefined ? { workdir } : {}) });
      const { code, stdout, stderr, truncated, cancelled, timedOut, evidence, evidenceError } = outcome;
      await writeResult(id, { id, status: "completed", owner, code, stdout, stderr, truncated, cancelled, timedOut, evidenceDir, ...(evidence ? { evidence } : {}), ...(evidenceError ? { evidenceError } : {}) });
    } catch (error) { await writeResult(id, { id, status: "failed", error: error instanceof Error ? error.message : String(error) }); }
  };

  const tick = async () => {
    try {
      for (const id of await idsOf()) {
        if (seen.has(id) || stopped) continue;
        seen.add(id);
        if (await hasResult(id) || stopped) continue;
        const controller = new AbortController();
        const done = handle(id, controller).catch(() => {}).finally(() => { inflight.delete(id); });
        inflight.set(id, { controller, done });
      }
      for (const [id, entry] of inflight) if (!entry.controller.signal.aborted && await lstat(cancelFile(requestDir, id)).then(() => true, () => false)) entry.controller.abort();
    } catch { /* the next tick tries again */ }
    if (!stopped) timer = setTimeout(() => { void tick(); }, pollMs);
  };

  await sweep("The request is from an earlier stage and was not run.");
  await atomicWriteFile(path.join(requestDir, BROKER_MARKER), JSON.stringify({ stage, startedAt: new Date().toISOString() }));
  void tick();
  return {
    requestDir,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const entry of inflight.values()) entry.controller.abort();
      let giveUp: NodeJS.Timeout | undefined;
      await Promise.race([Promise.allSettled([...inflight.values()].map(entry => entry.done)), new Promise<void>(resolve => { giveUp = setTimeout(resolve, options.stopGraceMs ?? 30_000); })]);
      clearTimeout(giveUp);
      await sweep("The stage ended before the request was run.");
      await rm(path.join(requestDir, BROKER_MARKER), { force: true });
    },
  };
}
