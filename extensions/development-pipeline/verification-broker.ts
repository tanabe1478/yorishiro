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
 * in this process, so a command sees the orchestrator's environment and not the child pane's shell. Requests run one at
 * a time, in the order they were found: each makes a snapshot of the target, and copies of a large repository side by side
 * would load the machine for every one of them. A request that waits is still answered when it is cancelled (the caller's
 * abort, or the caller's own time limit) and when the stage ends; it is not started after that.
 * `stop()` aborts what is running, answers what was not started, and withdraws broker.json.
 */
export async function startVerificationBroker(options: VerificationBrokerOptions): Promise<VerificationBroker> {
  const { requestDir, evidenceRoot, stage, cwd, repositories } = options;
  const pollMs = Math.max(5, options.pollMs ?? requestTimingFromEnv().pollMs);
  const run: RunVerification = options.run ?? (runSandboxedVerification as RunVerification);
  const owner = evidenceOwnerForStage(stage);
  await mkdir(requestDir, { recursive: true, mode: 0o700 });
  const seen = new Set<string>();
  /** Requests found and not yet answered: waiting in `queue` or the one running. */
  const pending = new Map<string, { controller: AbortController; state: "queued" | "running" }>();
  const queue: string[] = [];
  let current: { id: string; done: Promise<void> } | undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const hasResult = (id: string) => lstat(resultFile(requestDir, id)).then(() => true, () => false);
  const writeResult = (id: string, value: VerificationResultFile) => atomicWriteFile(resultFile(requestDir, id), JSON.stringify(value));
  const idsOf = async () => (await readdir(requestDir).catch(() => [] as string[])).filter(name => name.endsWith(REQUEST_SUFFIX)).map(name => name.slice(0, -REQUEST_SUFFIX.length)).filter(isRequestId);

  /** Answer every request that has no result with an error. Used for requests left by an earlier stage and at stop. */
  const sweep = async (reason: string) => {
    for (const id of await idsOf()) if (!(await hasResult(id))) await writeResult(id, { id, status: "failed", error: reason }).catch(() => {});
  };

  const isCancelled = (id: string) => lstat(cancelFile(requestDir, id)).then(() => true, () => false);
  /** Answer a request that was cancelled while it waited, without running it. */
  const answerCancelled = (id: string) => writeResult(id, { id, status: "completed", owner, code: 1, stdout: "", stderr: "The verification was cancelled before it started.", truncated: false, cancelled: true, timedOut: false }).catch(() => {});

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

  /** Start the next waiting request when none is running. Never throws. */
  const pump = () => {
    if (current || stopped) return;
    const id = queue.shift();
    if (id === undefined) return;
    const entry = pending.get(id);
    if (!entry) return pump();
    const done = (async () => {
      try {
        // Cancelled between the last look and now: nothing is copied or run for it.
        if (await isCancelled(id)) await answerCancelled(id);
        else if (!stopped) { entry.state = "running"; await handle(id, entry.controller); }
      } catch { /* handle answers its own failures */ }
    })().finally(() => { pending.delete(id); current = undefined; pump(); });
    current = { id, done };
  };

  const tick = async () => {
    try {
      const found = (await idsOf()).filter(id => !seen.has(id)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
      for (const id of found) {
        if (stopped) break;
        seen.add(id);
        if (await hasResult(id) || stopped) continue;
        pending.set(id, { controller: new AbortController(), state: "queued" });
        queue.push(id);
      }
      for (const [id, entry] of [...pending]) {
        if (entry.controller.signal.aborted || !(await isCancelled(id))) continue;
        if (entry.state === "running") { entry.controller.abort(); continue; }
        // Waiting: answer now, so the caller is not left to its own grace period behind a long command.
        const at = queue.indexOf(id);
        if (at < 0) continue;
        queue.splice(at, 1);
        pending.delete(id);
        entry.controller.abort();
        await answerCancelled(id);
      }
      pump();
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
      queue.length = 0;
      for (const entry of pending.values()) entry.controller.abort();
      let giveUp: NodeJS.Timeout | undefined;
      await Promise.race([current ? current.done : Promise.resolve(), new Promise<void>(resolve => { giveUp = setTimeout(resolve, options.stopGraceMs ?? 30_000); })]);
      clearTimeout(giveUp);
      await sweep("The stage ended before the request was run.");
      await rm(path.join(requestDir, BROKER_MARKER), { force: true });
    },
  };
}
