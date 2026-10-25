import { spawn } from "node:child_process";

export type AuthStatus = { status: "ready" | "not_ready" | "unknown"; provider?: string; authType?: string; reason?: string };
export type AuthRunner = (program: string, args: string[], signal?: AbortSignal) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Parse the exact provider/model rows of `pi --list-models <search>`. */
export function catalogHasExactModel(output: string, provider: string, modelId: string): boolean {
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s{2,}/);
    if (columns.length >= 2 && columns[0] === provider && columns[1] === modelId) return true;
  }
  return false;
}

/**
 * Parse `pi auth check --model <model> --json` without retaining credentials.
 * The command is always invoked with `--json` and never with `--credentials`.
 */
export function parseAuthCheck(output: string): AuthStatus {
  const text = output.trim();
  if (!text) return { status: "unknown", reason: "empty auth check output" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const line = text.split(/\r?\n/).find(candidate => candidate.trim().startsWith("{"));
    if (!line) return { status: "unknown", reason: "auth check output is not JSON" };
    try {
      parsed = JSON.parse(line);
    } catch {
      return { status: "unknown", reason: "auth check output is not JSON" };
    }
  }
  if (!parsed || typeof parsed !== "object") return { status: "unknown", reason: "auth check result is not an object" };
  const value = parsed as Record<string, unknown>;
  const status = value.status === "ready" ? "ready" : value.status === "not_ready" ? "not_ready" : "unknown";
  const result: AuthStatus = { status };
  if (typeof value.provider === "string") result.provider = value.provider;
  if (typeof value.authType === "string") result.authType = value.authType;
  if (typeof value.reason === "string") result.reason = value.reason;
  return result;
}

function runProcess(program: string, args: string[], signal?: AbortSignal, timeoutMs = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(program, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr });
    };
    const onAbort = () => {
      try { child.kill("SIGTERM"); } catch { /* exited */ }
      finish(1);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* exited */ }
      stderr += `auth check timed out after ${timeoutMs}ms`;
      finish(1);
    }, timeoutMs);
    child.stdout.on("data", data => { stdout += data.toString(); });
    child.stderr.on("data", data => { stderr += data.toString(); });
    child.once("error", error => { stderr += error.message; finish(1); });
    child.once("close", code => finish(code ?? 1));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Check every fixed model before any child pane is created. Uses `--no-refresh`
 * so preflight cannot modify stored credentials, and stores only readiness
 * metadata (never the credential itself).
 */
export async function preflightFixedModels(models: readonly string[], options: { run?: AuthRunner; piBin?: string; signal?: AbortSignal } = {}) {
  const piBin = options.piBin ?? process.env.YORISHIRO_PI_BIN ?? "pi";
  const run = options.run ?? ((program, args, signal) => runProcess(program, args, signal));
  const checked: Array<{ model: string; provider: string; authType?: string }> = [];
  for (const model of [...new Set(models)]) {
    const separator = model.indexOf("/");
    if (separator <= 0 || separator === model.length - 1) throw new Error(`MODEL_PREFLIGHT_FAILED: invalid fixed model id ${model}`);
    const expectedProvider = model.slice(0, separator), expectedId = model.slice(separator + 1);

    // Exact catalog availability, not a fuzzy search hit.
    const catalog = await run(piBin, ["--offline", "--list-models", model], options.signal);
    if (catalog.code !== 0 || !catalogHasExactModel(catalog.stdout, expectedProvider, expectedId)) {
      throw new Error(`MODEL_PREFLIGHT_FAILED: ${model} is not present in the installed model catalog for provider ${expectedProvider}`);
    }

    const result = await run(piBin, ["auth", "check", "--model", model, "--json", "--no-refresh"], options.signal);
    const parsed = parseAuthCheck(result.stdout);
    if (result.code !== 0) throw new Error(`MODEL_PREFLIGHT_FAILED: auth check for ${model} exited nonzero`);
    if (parsed.status !== "ready") throw new Error(`MODEL_PREFLIGHT_FAILED: ${model} is not ready (${parsed.status}${parsed.reason ? `: ${parsed.reason}` : ""})`);
    if (parsed.provider !== expectedProvider) throw new Error(`MODEL_PREFLIGHT_FAILED: ${model} resolved to provider ${parsed.provider ?? "unknown"}, expected ${expectedProvider}`);
    checked.push({ model, provider: expectedProvider, ...(parsed.authType ? { authType: parsed.authType } : {}) });
  }
  return { status: "ready" as const, checkedAt: new Date().toISOString(), models: checked };
}
