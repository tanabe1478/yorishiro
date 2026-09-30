import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DiffStat, VerifyKind } from "./analyze.ts";

export type CommandResult = { code: number; stdout: string; stderr: string };
export type Runner = (program: string, args: string[], options?: { cwd?: string; input?: string; timeoutMs?: number }) => Promise<CommandResult>;

export const run: Runner = (program, args, options = {}) => new Promise(resolve => {
  const child = spawn(program, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : undefined;
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("error", error => { if (timer) clearTimeout(timer); resolve({ code: 127, stdout, stderr: String(error.message ?? error) }); });
  child.on("close", code => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  if (options.input !== undefined) child.stdin.write(options.input);
  child.stdin.end();
});

const TODO = /\b(?:TODO|FIXME|XXX|HACK)\b/;
/** Files whose TODO mentions are documentation or test fixtures rather than unfinished code. */
export function todoExempt(file: string) { return /\.(?:md|mdx|txt|rst|adoc)$/i.test(file) || /(?:^|\/)(?:tests?|__tests__|spec|fixtures?|docs?)\//.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file); }
export function countTodoAdded(patch: string) {
  let file = "", count = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) { file = line.replace(/^\+\+\+ (?:b\/)?/, ""); continue; }
    if (line.startsWith("+") && !todoExempt(file) && TODO.test(line)) count++;
  }
  return count;
}

/** Working-tree diff statistics for the agent's checkout. Returns undefined outside a git repository. */
export async function gitDiffStat(cwd: string, runner: Runner = run): Promise<DiffStat | undefined> {
  const numstat = await runner("git", ["diff", "--numstat", "HEAD"], { cwd, timeoutMs: 10_000 });
  if (numstat.code !== 0) return undefined;
  let files = 0, added = 0, deleted = 0;
  for (const line of numstat.stdout.split("\n")) {
    const [a, d] = line.split("\t");
    if (a === undefined || d === undefined) continue;
    files++; added += Number(a) || 0; deleted += Number(d) || 0;
  }
  const status = await runner("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, timeoutMs: 10_000 });
  const untracked = status.stdout.split("\n").filter(line => line.startsWith("??")).length;
  const patch = await runner("git", ["diff", "-U0", "HEAD"], { cwd, timeoutMs: 10_000 });
  const todoAdded = countTodoAdded(patch.stdout);
  return { files, added, deleted, untracked, todoAdded };
}

export type PaneSession = { paneId: string; agent?: string; kind?: string; value?: string; cwd?: string };

/** Ask Herdr which agent session is attached to a pane. */
export async function herdrPaneSession(paneId: string | "current", runner: Runner = run): Promise<PaneSession | undefined> {
  const result = await runner("herdr", paneId === "current" ? ["pane", "current"] : ["pane", "get", paneId], { timeoutMs: 5_000 });
  if (result.code !== 0) return undefined;
  let parsed: any;
  try { parsed = JSON.parse(result.stdout); } catch { return undefined; }
  const pane = parsed?.result?.pane ?? parsed?.pane ?? parsed?.result;
  if (!pane || typeof pane.pane_id !== "string") return undefined;
  const session = pane.agent_session ?? {};
  return { paneId: pane.pane_id, agent: pane.agent ?? session.agent, kind: session.kind, value: session.value, cwd: pane.foreground_cwd ?? pane.cwd };
}

/** Split the current Herdr pane and run the observer in the new one. Returns the executed commands. */
export async function openObserverPane(command: string, options: { ratio?: number; direction?: "down" | "right"; dryRun?: boolean; runner?: Runner } = {}): Promise<{ paneId?: string; commands: string[][] }> {
  const runner = options.runner ?? run;
  const split = ["pane", "split", "--current", "--direction", options.direction ?? "down", "--ratio", String(options.ratio ?? 0.3), "--no-focus"];
  const commands: string[][] = [["herdr", ...split]];
  if (options.dryRun) { commands.push(["herdr", "pane", "run", "<new-pane>", command]); return { commands }; }
  const result = await runner("herdr", split, { timeoutMs: 10_000 });
  if (result.code !== 0) throw new Error(`herdr pane split failed: ${result.stderr || result.stdout}`);
  let paneId: string | undefined;
  try { const parsed = JSON.parse(result.stdout); paneId = parsed?.result?.pane?.pane_id ?? parsed?.result?.pane_id ?? parsed?.pane_id; } catch {}
  if (!paneId) throw new Error(`herdr pane split returned no pane id: ${result.stdout.slice(0, 200)}`);
  commands.push(["herdr", "pane", "run", paneId, command]);
  const ran = await runner("herdr", ["pane", "run", paneId, command], { timeoutMs: 10_000 });
  if (ran.code !== 0) throw new Error(`herdr pane run failed: ${ran.stderr || ran.stdout}`);
  return { paneId, commands };
}

/** Claude Code transcripts omit the `[1m]` suffix, so read the configured model from settings.json to recover the context limit. */
export async function claudeSettingsModel(home = os.homedir()): Promise<string | undefined> {
  try { const settings = JSON.parse(await fs.readFile(path.join(home, ".claude", "settings.json"), "utf8")); return typeof settings?.model === "string" ? settings.model : undefined; } catch { return undefined; }
}

/** Which verification kinds the project provides, from package.json scripts, Makefile targets and Python tooling. */
export async function projectChecks(cwd: string): Promise<VerifyKind[]> {
  const kinds = new Set<VerifyKind>();
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8"));
    const scripts = Object.keys(pkg?.scripts ?? {});
    const devDeps = Object.keys({ ...(pkg?.devDependencies ?? {}), ...(pkg?.dependencies ?? {}) });
    if (scripts.some(name => /^test(?::|$)/.test(name))) kinds.add("test");
    if (scripts.some(name => /lint/.test(name)) || devDeps.some(name => /eslint|biome/.test(name))) kinds.add("lint");
    if (scripts.some(name => /typecheck|tsc/.test(name)) || devDeps.includes("typescript")) kinds.add("typecheck");
    if (scripts.some(name => /^build(?::|$)/.test(name))) kinds.add("build");
  } catch {}
  try {
    const makefile = await fs.readFile(path.join(cwd, "Makefile"), "utf8");
    for (const [kind, pattern] of [["test", /^test:/m], ["lint", /^lint:/m], ["typecheck", /^typecheck:/m], ["build", /^build:/m]] as const) if (pattern.test(makefile)) kinds.add(kind);
  } catch {}
  try {
    const pyproject = await fs.readFile(path.join(cwd, "pyproject.toml"), "utf8");
    if (/pytest/.test(pyproject)) kinds.add("test");
    if (/\bruff\b|\bflake8\b|\bpylint\b/.test(pyproject)) kinds.add("lint");
    if (/\bmypy\b|\bpyright\b/.test(pyproject)) kinds.add("typecheck");
  } catch {}
  return [...kinds];
}

/** Viewport size of the pane this process runs in, via Herdr (stdout.rows is unreliable under `herdr pane run`). */
export async function herdrViewport(runner: Runner = run): Promise<{ rows: number; columns?: number } | undefined> {
  if (!process.env.HERDR_PANE_ID) return undefined;
  const result = await runner("herdr", ["pane", "current"], { timeoutMs: 3_000 });
  if (result.code !== 0) return undefined;
  try { const pane = JSON.parse(result.stdout)?.result?.pane; const rows = Number(pane?.scroll?.viewport_rows); return rows > 0 ? { rows, columns: Number(pane?.scroll?.viewport_columns) || undefined } : undefined; } catch { return undefined; }
}
