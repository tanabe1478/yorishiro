import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preflightVerifierSandbox } from "./sandbox.ts";

export const MAX_OUTPUT = 64 * 1024;
export const TRUNCATION_NOTICE = "\n[output truncated at 65536 bytes]";
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

type VerificationWorkspace = { root: string; cwd: string; temp: string; cache: string };
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
    const temp = path.join(canonical, ".yorishiro-tmp"), cache = path.join(canonical, ".yorishiro-cache");
    await Promise.all([mkdir(temp, { recursive: true }), mkdir(cache, { recursive: true })]);
    return { root, cwd: canonical, temp, cache };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
export async function runSandboxedVerification(program: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal) {
  await preflightVerifierSandbox(cwd);
  let workspace: VerificationWorkspace;
  try { workspace = await createVerificationWorkspace(await realpath(cwd), signal); }
  catch (error) {
    if (signal?.aborted) return { code: 1, stdout: "", stderr: "", truncated: false, cancelled: true, timedOut: false };
    throw error;
  }
  try {
    const command = sandboxCommand(program, args, workspace.cwd);
    return await run(command[0], command.slice(1), workspace.cwd, timeoutMs, signal, {
      TMPDIR: workspace.temp,
      TMP: workspace.temp,
      TEMP: workspace.temp,
      npm_config_cache: path.join(workspace.cache, "npm"),
      XDG_CACHE_HOME: path.join(workspace.cache, "xdg"),
    });
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "run_verification_command",
    label: "Run Read-only Verification Command",
    description: "Run one executable in a kernel-enforced read-only sandbox. Output is capped at 64 KiB and cancellation terminates its process group.",
    parameters: Type.Object({ program: Type.String(), args: Type.Array(Type.String()), timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300000 })) }),
    async execute(_id, input: { program: string; args: string[]; timeoutMs?: number }, signal: AbortSignal) {
      const cwd = process.env.YORISHIRO_TARGET_CWD;
      if (!cwd) throw new Error("Verifier sandbox is not configured");
      const timeout = input.timeoutMs ?? 120000;
      const result = await runSandboxedVerification(input.program, input.args, cwd, timeout, signal);
      const status = result.timedOut ? "TIMEOUT" : result.cancelled ? "CANCELLED" : "EXIT";
      const statusLine = `\n[verification ${status} exit=${result.code}]`;
      const raw = `${result.stdout}${result.stderr}`;
      const statusBytes = Buffer.byteLength(statusLine, "utf8"), noticeBytes = Buffer.byteLength(TRUNCATION_NOTICE, "utf8");
      let dropped = result.truncated, budget = Math.max(0, MAX_OUTPUT - statusBytes - (dropped ? noticeBytes : 0));
      let output = boundUtf8(raw, budget); if (Buffer.byteLength(output, "utf8") < Buffer.byteLength(raw, "utf8")) dropped = true;
      if (dropped) { budget = Math.max(0, MAX_OUTPUT - statusBytes - noticeBytes); output = boundUtf8(raw, budget); }
      const visible = output + (dropped ? TRUNCATION_NOTICE : "") + statusLine;
      return { content: [{ type: "text", text: visible }], details: { exitCode: result.code, sandboxed: true, truncated: dropped, cancelled: result.cancelled, timedOut: result.timedOut } };
    },
  });
}
