import { spawn } from "node:child_process";
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
export function run(program: string, args: string[], cwd: string, timeout: number, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string; truncated: boolean; cancelled: boolean; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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

export function sandboxCommand(program: string, args: string[], cwd: string): string[] {
  if (process.platform === "darwin") return ["/usr/bin/sandbox-exec", "-p", `(version 1) (deny default) (allow process*) (allow file-read*) (allow network*) (allow file-write* (subpath "/tmp"))`, "--", program, ...args];
  if (process.platform === "linux") return ["/usr/bin/bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--chdir", cwd, "--", program, ...args];
  throw new Error(`Verifier sandbox is unsupported on ${process.platform}`);
}
export async function runSandboxedVerification(program: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal) {
  await preflightVerifierSandbox(cwd);
  const command = sandboxCommand(program, args, cwd);
  return run(command[0], command.slice(1), cwd, timeoutMs, signal);
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
