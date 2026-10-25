import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { copyFile, cp, lstat, mkdir, mkdtemp, opendir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preflightVerifierSandbox } from "./sandbox.ts";

export const MAX_OUTPUT = 64 * 1024;
export const TRUNCATION_NOTICE = "\n[output truncated at 65536 bytes]";
export const EVIDENCE_DIR_NAME = ".yorishiro-evidence";
export const EVIDENCE_LIMITS = { maxFiles: 100, maxFileBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024, maxDepth: 4, maxEntries: 1000, maxSkippedDiagnostics: 50 } as const;
function killTree(pid: number, signal: NodeJS.Signals) { try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* exited */ } } }
export function trimUtf8(buffer: Buffer, max: number) {
  const limit = Math.min(buffer.length, max); let end = 0;
  while (end < limit) {
    const lead = buffer[end];
    const length = lead < 0x80 ? 1 : lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 1;
    if (end + length > limit) break;
    end += length;
  }
  return buffer.subarray(0, end);
}
export function boundUtf8(text: string, max = MAX_OUTPUT) { return trimUtf8(Buffer.from(text, "utf8"), max).toString("utf8"); }
export function run(program: string, args: string[], cwd: string, timeout: number, signal?: AbortSignal, env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string; truncated: boolean; cancelled: boolean; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd, shell: false, detached: true, env: env ? { ...process.env, ...env } : undefined, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), truncated = false, cancelled = false, timedOut = false, settled = false;
    const append = (current: Buffer, chunk: Buffer) => { const limit = MAX_OUTPUT + 4; if (current.length >= limit) { truncated = true; return current; } const combined = Buffer.concat([current, chunk]); if (combined.length > limit) truncated = true; return combined.subarray(0, limit); };
    const normalized = () => { const combined = Buffer.concat([stdout, stderr]); let decoded: string; try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(combined); } catch { decoded = new TextDecoder("utf-8").decode(combined); truncated = true; } const visible = boundUtf8(decoded, MAX_OUTPUT); if (Buffer.byteLength(visible, "utf8") < Buffer.byteLength(decoded, "utf8")) truncated = true; return visible; };
    const stop = (reason: "cancelled" | "timeout") => { if (reason === "cancelled") cancelled = true; else timedOut = true; killTree(child.pid!, "SIGTERM"); setTimeout(() => { if (!settled) killTree(child.pid!, "SIGKILL"); }, 1000).unref(); };
    const timer = setTimeout(() => { stop("timeout"); }, timeout);
    const onAbort = () => stop("cancelled");
    if (signal) { if (signal.aborted) stop("cancelled"); else signal.addEventListener("abort", onAbort, { once: true }); }
    child.stdout.on("data", d => { stdout = append(stdout, Buffer.from(d)); }); child.stderr.on("data", d => { stderr = append(stderr, Buffer.from(d)); });
    child.once("error", e => { settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve({ code: 1, stdout: normalized(), stderr: e.message, truncated, cancelled, timedOut }); });
    child.once("close", code => { settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve({ code: code ?? 1, stdout: normalized(), stderr: "", truncated, cancelled, timedOut }); });
  });
}

function sandboxLiteral(value: string) { return JSON.stringify(value); }
export function sandboxCommand(program: string, args: string[], cwd: string): string[] {
  if (process.platform === "darwin") {
    const profile = `(version 1) (allow default) (deny file-write*) (allow file-write* (subpath ${sandboxLiteral(cwd)})) (allow file-write* (literal "/dev/null"))`;
    return ["/usr/bin/sandbox-exec", "-p", profile, "--", program, ...args];
  }
  if (process.platform === "linux") return ["/usr/bin/bwrap", "--ro-bind", "/", "/", "--bind", cwd, cwd, "--dev", "/dev", "--proc", "/proc", "--chdir", cwd, "--", program, ...args];
  throw new Error(`Verifier sandbox is unsupported on ${process.platform}`);
}

type VerificationWorkspace = { root: string; cwd: string; temp: string; cache: string; evidence: string };
async function createVerificationWorkspace(cwd: string, signal?: AbortSignal): Promise<VerificationWorkspace> {
  const root = await mkdtemp(path.join(tmpdir(), "yorishiro-verification-"));
  const workspace = path.join(root, "workspace");
  try {
    await mkdir(workspace);
    const source = `${cwd}${path.sep}.`;
    const copyArgs = process.platform === "darwin" ? ["-cR", source, workspace] : ["-a", "--reflink=auto", source, workspace];
    const copied = await run("/bin/cp", copyArgs, cwd, 300_000, signal);
    if (copied.code !== 0 || copied.cancelled || copied.timedOut) {
      await rm(workspace, { recursive: true, force: true });
      await mkdir(workspace);
      if (signal?.aborted) throw new Error("Verifier snapshot copy was cancelled");
      await cp(cwd, workspace, { recursive: true, force: true, errorOnExist: false });
    }
    const canonical = await realpath(workspace);
    const temp = path.join(canonical, ".yorishiro-tmp"), cache = path.join(canonical, ".yorishiro-cache"), evidence = path.join(canonical, EVIDENCE_DIR_NAME);
    // The target checkout may already contain a stale `.yorishiro-evidence`.
    // Never preserve that as fresh proof for this check.
    await rm(evidence, { recursive: true, force: true });
    await Promise.all([mkdir(temp, { recursive: true }), mkdir(cache, { recursive: true }), mkdir(evidence, { recursive: true })]);
    return { root, cwd: canonical, temp, cache, evidence };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export type EvidenceFile = { path: string; bytes: number };
export type EvidenceSkip = { path: string; reason: string };
export type EvidenceCollection = { status: "collected" | "empty"; destination: string; files: EvidenceFile[]; skipped: EvidenceSkip[]; bytes: number; truncated: boolean; visited: number; skippedCount: number };
export type EvidenceLimits = { maxFiles: number; maxFileBytes: number; maxTotalBytes: number; maxDepth: number; maxEntries: number; maxSkippedDiagnostics: number };

function within(base: string, candidate: string) {
  const relative = path.relative(base, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Copy a bounded, symlink-free set of files from the disposable snapshot's
 * evidence directory into an orchestrator-owned destination before teardown.
 * Regular files only. The evidence root must be a real directory; a command can
 * otherwise replace it with a symlink. Symlinks, special files, path escapes,
 * oversized output, and excess diagnostics are skipped and reported. No
 * arbitrary snapshot contents are copied.
 */
export async function collectEvidence(sourceDir: string, destination: string, options: Partial<EvidenceLimits> = {}): Promise<EvidenceCollection> {
  const limits: EvidenceLimits = { ...EVIDENCE_LIMITS, ...options };
  const result: EvidenceCollection = { status: "empty", destination, files: [], skipped: [], bytes: 0, truncated: false, visited: 0, skippedCount: 0 };
  const skip = (relative: string, reason: string) => {
    result.skippedCount++;
    if (result.skipped.length < limits.maxSkippedDiagnostics) result.skipped.push({ path: relative, reason });
    result.truncated = true;
  };

  // Reject a root that is a symlink or non-directory BEFORE resolving it. A
  // command can remove the snapshot evidence directory and replace it with a
  // link to a sensitive directory; realpath alone would follow that link.
  let rootInfo: Awaited<ReturnType<typeof lstat>>;
  try { rootInfo = await lstat(sourceDir); } catch { skip(".", "evidence root missing"); return result; }
  result.visited = 1;
  if (rootInfo.isSymbolicLink()) { skip(".", "evidence root symlink rejected"); return result; }
  if (!rootInfo.isDirectory()) { skip(".", "evidence root is not a directory"); return result; }
  const sourceCanonical = await realpath(sourceDir).catch(() => undefined);
  if (!sourceCanonical) { skip(".", "evidence root is unavailable"); return result; }
  const canonicalInfo = await lstat(sourceCanonical).catch(() => undefined);
  if (!canonicalInfo || canonicalInfo.isSymbolicLink() || !canonicalInfo.isDirectory()) { skip(".", "evidence root changed during collection"); return result; }

  let destinationInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  try { destinationInfo = await lstat(destination); } catch { /* created below */ }
  if (destinationInfo && (destinationInfo.isSymbolicLink() || !destinationInfo.isDirectory())) throw new Error("Evidence destination must be a real directory");
  if (!destinationInfo) await mkdir(destination, { recursive: true });
  const createdInfo = await lstat(destination).catch(() => undefined);
  if (!createdInfo || createdInfo.isSymbolicLink() || !createdInfo.isDirectory()) throw new Error("Evidence destination must be a real directory");
  const destinationCanonical = await realpath(destination).catch(() => undefined);
  if (!destinationCanonical) throw new Error("Evidence destination is unavailable");
  if (destinationCanonical === sourceCanonical || within(sourceCanonical, destinationCanonical)) throw new Error("Evidence destination must be outside the snapshot evidence directory");

  const walk = async (directory: string, relativeDir: string, depth: number) => {
    let handle: Awaited<ReturnType<typeof opendir>>;
    try { handle = await opendir(directory); } catch { skip(relativeDir || ".", "unreadable directory"); return; }
    try {
      for await (const entry of handle) {
        if (result.visited >= limits.maxEntries) { skip(relativeDir || ".", "entry limit"); return; }
        result.visited++;
        const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        const absolute = path.join(directory, entry.name);
        let info: Awaited<ReturnType<typeof lstat>>;
        try { info = await lstat(absolute); } catch { skip(relative, "unreadable entry"); continue; }
        if (info.isSymbolicLink()) { skip(relative, "symlink rejected"); continue; }
        if (info.isDirectory()) {
          if (depth >= limits.maxDepth) { skip(relative, "depth limit"); continue; }
          await walk(absolute, relative, depth + 1);
          continue;
        }
        if (!info.isFile()) { skip(relative, "non-regular file rejected"); continue; }
        if (result.files.length >= limits.maxFiles) { skip(relative, "file count limit"); continue; }
        if (info.size > limits.maxFileBytes) { skip(relative, "file size limit"); continue; }
        if (result.bytes + info.size > limits.maxTotalBytes) { skip(relative, "total size limit"); continue; }
        const canonical = await realpath(absolute).catch(() => undefined);
        if (!canonical || !within(sourceCanonical, canonical)) { skip(relative, "path escape rejected"); continue; }
        const target = path.resolve(destinationCanonical, relative);
        if (!within(destinationCanonical, target)) { skip(relative, "destination escape rejected"); continue; }
        const parent = path.dirname(target);
        try { await mkdir(parent, { recursive: true }); } catch { skip(relative, "destination parent creation failed"); continue; }
        const parentInfo = await lstat(parent).catch(() => undefined);
        if (!parentInfo || parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) { skip(relative, "destination parent is not a real directory"); continue; }
        const parentCanonical = await realpath(parent).catch(() => undefined);
        if (!parentCanonical || (parentCanonical !== destinationCanonical && !within(destinationCanonical, parentCanonical))) { skip(relative, "destination escape rejected"); continue; }
        const existingTarget = await lstat(target).catch(() => undefined);
        if (existingTarget) { skip(relative, "destination target exists"); continue; }
        try {
          await copyFile(canonical, target, fsConstants.COPYFILE_EXCL);
          result.files.push({ path: relative, bytes: info.size });
          result.bytes += info.size;
        } catch {
          skip(relative, "copy failed or destination exists");
        }
      }
    } finally {
      await handle.close().catch(() => {});
    }
  };
  await walk(sourceCanonical, "", 0);
  result.status = result.files.length > 0 ? "collected" : "empty";
  return result;
}

export async function runSandboxedVerification(program: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal, options: { evidenceDir?: string } = {}) {
  await preflightVerifierSandbox(cwd);
  let workspace: VerificationWorkspace;
  try { workspace = await createVerificationWorkspace(await realpath(cwd), signal); }
  catch (error) {
    if (signal?.aborted) return { code: 1, stdout: "", stderr: "", truncated: false, cancelled: true, timedOut: false };
    throw error;
  }
  try {
    const command = sandboxCommand(program, args, workspace.cwd);
    const result = await run(command[0], command.slice(1), workspace.cwd, timeoutMs, signal, {
      TMPDIR: workspace.temp,
      TMP: workspace.temp,
      TEMP: workspace.temp,
      npm_config_cache: path.join(workspace.cache, "npm"),
      XDG_CACHE_HOME: path.join(workspace.cache, "xdg"),
      YORISHIRO_EVIDENCE_DIR: workspace.evidence,
    });
    if (!options.evidenceDir) return result;
    try {
      const evidence = await collectEvidence(workspace.evidence, options.evidenceDir);
      return { ...result, evidence };
    } catch (error) {
      return { ...result, evidenceError: error instanceof Error ? error.message : String(error) };
    }
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
}

export default function (pi: ExtensionAPI) {
  let evidenceCounter = 0;
  pi.registerTool({
    name: "run_verification_command",
    label: "Run Read-only Verification Command",
    description: "Run one executable in a kernel-enforced read-only sandbox. Output is capped at 64 KiB and cancellation terminates its process group. Files written to $YORISHIRO_EVIDENCE_DIR are copied to orchestrator-owned evidence before the snapshot is removed.",
    parameters: Type.Object({ program: Type.String(), args: Type.Array(Type.String()), timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300000 })) }),
    async execute(_id, input: { program: string; args: string[]; timeoutMs?: number }, signal: AbortSignal) {
      const cwd = process.env.YORISHIRO_TARGET_CWD;
      if (!cwd) throw new Error("Verifier sandbox is not configured");
      const evidenceRoot = process.env.YORISHIRO_EVIDENCE_ROOT;
      if (evidenceRoot && !path.isAbsolute(evidenceRoot)) throw new Error("Verifier evidence root must be an absolute orchestrator path");
      const evidenceDir = evidenceRoot ? path.join(evidenceRoot, "reviewer", `${Date.now()}-${process.pid}-${++evidenceCounter}`) : undefined;
      const timeout = input.timeoutMs ?? 120000;
      const result = await runSandboxedVerification(input.program, input.args, cwd, timeout, signal, evidenceDir ? { evidenceDir } : {});
      const status = result.timedOut ? "TIMEOUT" : result.cancelled ? "CANCELLED" : "EXIT";
      const statusLine = `\n[verification ${status} exit=${result.code}]`;
      const resultEvidence = (result as any).evidence;
      const evidenceError = (result as any).evidenceError;
      const evidence = resultEvidence ? { status: resultEvidence.status, dir: evidenceDir, files: resultEvidence.files.length, bytes: resultEvidence.bytes, skipped: resultEvidence.skipped.length, skippedCount: resultEvidence.skippedCount, visited: resultEvidence.visited, truncated: resultEvidence.truncated } : undefined;
      const evidenceLine = evidenceDir ? resultEvidence ? boundUtf8(`\n[evidence ${resultEvidence.files.length} files; skipped=${resultEvidence.skippedCount}; truncated=${resultEvidence.truncated ? "yes" : "no"}; dir=${evidenceDir}]`, 1024) : evidenceError ? boundUtf8(`\n[evidence collection failed: ${evidenceError}; dir=${evidenceDir}]`, 1024) : "" : "";
      const trailer = evidenceLine + statusLine;
      const raw = `${result.stdout}${result.stderr}`;
      const trailerBytes = Buffer.byteLength(trailer, "utf8"), noticeBytes = Buffer.byteLength(TRUNCATION_NOTICE, "utf8");
      let dropped = result.truncated, budget = Math.max(0, MAX_OUTPUT - trailerBytes - (dropped ? noticeBytes : 0));
      let output = boundUtf8(raw, budget); if (Buffer.byteLength(output, "utf8") < Buffer.byteLength(raw, "utf8")) dropped = true;
      if (dropped) { budget = Math.max(0, MAX_OUTPUT - trailerBytes - noticeBytes); output = boundUtf8(raw, budget); }
      const visible = output + (dropped ? TRUNCATION_NOTICE : "") + trailer;
      return { content: [{ type: "text", text: visible }], details: { exitCode: result.code, sandboxed: true, truncated: dropped, cancelled: result.cancelled, timedOut: result.timedOut, evidenceIncomplete: !!evidenceError || !!resultEvidence?.truncated || (resultEvidence?.skippedCount ?? 0) > 0, ...(evidence ? { evidence } : {}), ...(evidenceError ? { evidenceError } : {}) } };
    },
  });
}
