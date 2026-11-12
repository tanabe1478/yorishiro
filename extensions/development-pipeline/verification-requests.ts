import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { MAX_CHECK_TIMEOUT_MS } from "./quality-contract.ts";
import { isRepositoryRelativePath, isWithinRepositories } from "./repositories.ts";

/**
 * run_verification_command of a Worker or a Reviewer does not run anything itself. It writes a request into a
 * directory the orchestrator watches, and the orchestrator runs it with runSandboxedVerification, in its own process
 * and environment, exactly like the quality gate. Files in the request directory (`<artifactDir>/verification-requests/<stage>/`):
 *
 *   broker.json         present while the orchestrator accepts requests for this stage
 *   <id>.request.json   { program, args, timeoutMs?, cwd? }
 *   <id>.cancel         the caller gave up; the orchestrator stops the running command
 *   <id>.result.json    the outcome, written atomically
 *
 * No environment variable is ever written to these files; the orchestrator uses its own process.env.
 */
export const REQUEST_SUFFIX = ".request.json";
export const RESULT_SUFFIX = ".result.json";
export const CANCEL_SUFFIX = ".cancel";
export const BROKER_MARKER = "broker.json";
export const REQUEST_DIR_ENV = "YORISHIRO_VERIFICATION_REQUEST_DIR";
export const DEFAULT_TIMEOUT_MS = 120000;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_REQUEST_BYTES = 1024 * 1024;
const ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,95}$/;

export type VerificationStage = "implement" | "review";
export type VerificationRequest = { program: string; args: string[]; timeoutMs?: number; cwd?: string };
export type VerificationEvidence = { status: "collected" | "empty"; files: Array<{ path: string; bytes: number }>; skipped: Array<{ path: string; reason: string }>; bytes: number; truncated: boolean; visited: number; skippedCount: number };
export type VerificationOutcome = { code: number; stdout: string; stderr: string; truncated: boolean; cancelled: boolean; timedOut: boolean; evidenceDir?: string; evidence?: VerificationEvidence; evidenceError?: string };
export type VerificationResultFile = ({ id: string; status: "completed"; owner: string } & VerificationOutcome) | { id: string; status: "rejected" | "failed"; error: string };

export function verificationRequestDir(artifactDir: string, stage: VerificationStage) { return path.join(artifactDir, "verification-requests", stage); }
export function isRequestId(value: unknown): value is string { return typeof value === "string" && ID_PATTERN.test(value); }
export function requestFile(dir: string, id: string) { return path.join(dir, `${id}${REQUEST_SUFFIX}`); }
export function resultFile(dir: string, id: string) { return path.join(dir, `${id}${RESULT_SUFFIX}`); }
export function cancelFile(dir: string, id: string) { return path.join(dir, `${id}${CANCEL_SUFFIX}`); }

let writeCounter = 0;
/** Write via a temporary name the readers never look for, then rename: a reader sees the whole file or none. */
export async function atomicWriteFile(file: string, content: string) {
  const temporary = `${file}.tmp-${process.pid}-${++writeCounter}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

/**
 * The rules of the tool, applied before anything runs (by the caller and again by the orchestrator): program and args are
 * strings, timeoutMs an integer in [1000, MAX_CHECK_TIMEOUT_MS], and cwd only for runs with repositories, naming one of them or a directory inside one.
 */
export function validateVerificationRequest(value: unknown, repositories?: readonly string[], options: { shapeOnly?: boolean } = {}): { valid: true; request: VerificationRequest & { timeoutMs: number } } | { valid: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, error: "verification request must be a JSON object" };
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!["program", "args", "timeoutMs", "cwd"].includes(key)) return { valid: false, error: `verification request has an unknown field: ${key}` };
  if (typeof record.program !== "string" || record.program === "" || record.program.includes("\0")) return { valid: false, error: "program must be a non-empty string" };
  if (!Array.isArray(record.args) || record.args.some(arg => typeof arg !== "string" || arg.includes("\0"))) return { valid: false, error: "args must be an array of strings" };
  const timeoutMs = record.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : record.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_CHECK_TIMEOUT_MS) return { valid: false, error: `timeoutMs must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_CHECK_TIMEOUT_MS}` };
  if (record.cwd !== undefined) {
    if (typeof record.cwd !== "string") return { valid: false, error: "cwd must be a string" };
    // shapeOnly: the caller does not know the run's repositories; the orchestrator applies the full rule.
    if (options.shapeOnly) { if (!isRepositoryRelativePath(record.cwd)) return { valid: false, error: `cwd must be a workspace-relative path: ${record.cwd}` }; }
    else if (!repositories) return { valid: false, error: "cwd is only allowed when the run has repositories" };
    else if (!isWithinRepositories(record.cwd, repositories)) return { valid: false, error: `cwd must be a workspace-relative path that is one of repositories or inside one: ${record.cwd}` };
  }
  return { valid: true, request: { program: record.program, args: record.args as string[], timeoutMs, ...(record.cwd !== undefined ? { cwd: record.cwd as string } : {}) } };
}

export type RequestTiming = { pollMs?: number; responseMarginMs?: number; cancelGraceMs?: number };
function numberFromEnv(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env) {
  const value = Number(env[name]);
  return env[name] !== undefined && env[name] !== "" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
/** Poll interval, the time allowed beyond timeoutMs (snapshot copy and teardown), and the time allowed after a cancel. The environment overrides are for tests. */
export function requestTimingFromEnv(env: NodeJS.ProcessEnv = process.env): Required<RequestTiming> {
  return {
    pollMs: Math.max(5, numberFromEnv("YORISHIRO_VERIFICATION_POLL_MS", 200, env)),
    responseMarginMs: numberFromEnv("YORISHIRO_VERIFICATION_RESPONSE_MARGIN_MS", 10 * 60_000, env),
    cancelGraceMs: numberFromEnv("YORISHIRO_VERIFICATION_CANCEL_GRACE_MS", 15_000, env),
  };
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let requestCounter = 0;
async function readResult(file: string): Promise<VerificationResultFile | undefined> {
  let text: string;
  try { text = await readFile(file, "utf8"); } catch { return undefined; }
  try { return JSON.parse(text) as VerificationResultFile; } catch { return { id: "", status: "failed", error: "verification result is not valid JSON" }; }
}
async function markerExists(dir: string) { return lstat(path.join(dir, BROKER_MARKER)).then(() => true, () => false); }

/**
 * Write a request and wait for its result. Throws when the request is invalid or the orchestrator is not accepting requests
 * (the directory has no broker.json: the stage is over or the tool is not run by a pipeline). Without an answer within
 * timeoutMs plus a margin the call returns a timed-out result; on `signal` it writes the cancel marker and returns the
 * orchestrator's cancelled result, or a cancelled one of its own when none arrives.
 */
export async function requestVerification(dir: string, input: VerificationRequest, signal: AbortSignal | undefined, timing: RequestTiming = requestTimingFromEnv()): Promise<VerificationOutcome> {
  const { pollMs = 200, responseMarginMs = 10 * 60_000, cancelGraceMs = 15_000 } = timing;
  const checked = validateVerificationRequest(input, undefined, { shapeOnly: true });
  if (!checked.valid) throw new Error(checked.error);
  const timeoutMs = checked.request.timeoutMs;
  if (!path.isAbsolute(dir)) throw new Error(`${REQUEST_DIR_ENV} must be an absolute path`);
  if (!(await markerExists(dir))) throw new Error("The orchestrator is not accepting verification requests (the stage may be over). Nothing was run.");
  const id = `${Date.now()}-${process.pid}-${++requestCounter}`;
  await atomicWriteFile(requestFile(dir, id), JSON.stringify(input));
  const started = Date.now();
  const deadline = started + timeoutMs + responseMarginMs;
  let cancelledAt: number | undefined;
  const cancel = async () => { if (cancelledAt === undefined) { cancelledAt = Date.now(); await writeFile(cancelFile(dir, id), "", { mode: 0o600 }).catch(() => {}); } };
  const onAbort = () => { void cancel(); };
  if (signal) { if (signal.aborted) await cancel(); else signal.addEventListener("abort", onAbort, { once: true }); }
  try {
    for (;;) {
      const result = await readResult(resultFile(dir, id));
      if (result) {
        if (result.status !== "completed") throw new Error(result.error);
        const { id: _id, status: _status, owner: _owner, ...outcome } = result;
        return outcome;
      }
      const now = Date.now();
      if (cancelledAt !== undefined && now - cancelledAt >= cancelGraceMs) return { code: 1, stdout: "", stderr: "The verification was cancelled; the orchestrator did not confirm that it stopped.", truncated: false, cancelled: true, timedOut: false };
      if (cancelledAt === undefined && now >= deadline) {
        await cancel();
        return { code: 1, stdout: "", stderr: `The orchestrator did not answer within ${timeoutMs + responseMarginMs} ms (timeoutMs plus ${responseMarginMs} ms for the snapshot). The request was cancelled.`, truncated: false, cancelled: false, timedOut: true };
      }
      if (!(await markerExists(dir))) {
        // The stage ended: its final sweep writes every pending result before broker.json goes. One more look, then give up.
        const last = await readResult(resultFile(dir, id));
        if (!last) throw new Error("The orchestrator stopped accepting verification requests before it answered (the stage ended). The command was not run to completion.");
        continue;
      }
      await sleep(pollMs);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
