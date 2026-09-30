import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionReader } from "./parse.ts";
import { analyze, type Snapshot } from "./analyze.ts";
import { gitDiffStat, type Runner } from "./probe.ts";

export type HookInput = { hook_event_name?: string; session_id?: string; transcript_path?: string; cwd?: string; message?: string; title?: string; notification_type?: string; source?: string; stop_hook_active?: boolean; agent_id?: string };
export type HookDeps = { stateDir?: string; env?: NodeJS.ProcessEnv; notify?: (title: string, body: string) => void; runner?: Runner; now?: () => number };
const STOP_IGNORED = new Set(["context", "subagents", "stalled"]);
export type HookOutcome = { event: string; recorded?: string; notified?: boolean; snapshot?: Snapshot };

export function defaultStateDir(env = process.env, home = os.homedir()) { return path.join(env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "yorishiro", "observer"); }

export function notifyMac(title: string, body: string) {
  if (process.platform !== "darwin") return;
  const escape = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
  spawn("osascript", ["-e", `display notification "${escape(body.slice(0, 200))}" with title "${escape(title)}"`], { stdio: "ignore", detached: true }).unref();
}

/** Handle one Claude Code hook invocation. Never throws to the caller; hooks must not block the agent. */
export async function handleHook(input: HookInput, deps: HookDeps = {}): Promise<HookOutcome> {
  const env = deps.env ?? process.env;
  const stateDir = deps.stateDir ?? defaultStateDir(env);
  const notify = deps.notify ?? notifyMac;
  const event = input.hook_event_name ?? "unknown";
  if (input.agent_id) return { event };
  const id = input.session_id ?? "unknown";
  const record = async (dir: string, name: string, data: unknown) => { const target = path.join(stateDir, dir); await fs.mkdir(target, { recursive: true }); const file = path.join(target, name); await fs.writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 }); return file; };
  if (event === "SessionStart") {
    const recorded = await record("sessions", `${id}.json`, { sessionId: id, transcriptPath: input.transcript_path, cwd: input.cwd, pane: env.HERDR_PANE_ID, source: input.source, at: new Date(deps.now?.() ?? Date.now()).toISOString() });
    return { event, recorded };
  }
  if (event === "Notification") {
    const body = input.message ?? input.notification_type ?? "";
    notify(input.title ?? "Claude Code", body);
    const recorded = await record("notifications", `${id}.json`, { sessionId: id, message: input.message, type: input.notification_type, at: new Date(deps.now?.() ?? Date.now()).toISOString() });
    return { event, recorded, notified: true };
  }
  if (event === "Stop" || event === "SubagentStop") {
    if (event === "SubagentStop" || !input.transcript_path) return { event };
    const reader = new SessionReader(input.transcript_path, "claude");
    await reader.poll();
    const diff = input.cwd ? await gitDiffStat(input.cwd, deps.runner) : undefined;
    // At Stop the agent has just halted, so staleness and context pressure are not completion problems; keep only findings about the delivered work.
    const full = analyze(reader.events, { diff, now: deps.now?.(), stalledMs: Number.POSITIVE_INFINITY });
    const findings = full.findings.filter(item => !STOP_IGNORED.has(item.id));
    const level = findings.reduce<Snapshot["level"]>((acc, item) => item.level === "red" || (item.level === "yellow" && acc === "green") ? item.level : acc, "green");
    const snapshot: Snapshot = { ...full, findings, level };
    const recorded = await record("audits", `${id}.json`, { sessionId: id, at: new Date(deps.now?.() ?? Date.now()).toISOString(), level, phase: snapshot.phase, audit: snapshot.audit, findings, editedFiles: snapshot.editedFiles, diff });
    let notified = false;
    if (level !== "green") { notify(`yorishiro observer: 終了時監査 ${level}`, findings.filter(item => item.level !== "green").map(item => item.message).join(" / ")); notified = true; }
    return { event, recorded, notified, snapshot };
  }
  return { event };
}

export async function readHookInput(stream: NodeJS.ReadableStream = process.stdin): Promise<HookInput> {
  let raw = "";
  for await (const chunk of stream) raw += chunk;
  try { return raw.trim() ? JSON.parse(raw) : {}; } catch { return {}; }
}

/** Merge observer hooks into a Claude Code settings.json. Idempotent; writes a backup beside the file. */
export async function installHooks(settingsFile: string, command: string, now = new Date()): Promise<{ changed: boolean; backup?: string }> {
  let settings: any = {};
  let existed = false;
  try { settings = JSON.parse(await fs.readFile(settingsFile, "utf8")); existed = true; } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  settings.hooks ??= {};
  let changed = false;
  for (const [event, matcher] of [["SessionStart", "*"], ["Stop", ""], ["Notification", ""]] as const) {
    const entries: any[] = settings.hooks[event] ??= [];
    const present = entries.some(entry => Array.isArray(entry?.hooks) && entry.hooks.some((hook: any) => typeof hook?.command === "string" && hook.command.includes(command)));
    if (present) continue;
    entries.push({ matcher, hooks: [{ type: "command", command: `${command} hook`, timeout: 30 }] });
    changed = true;
  }
  if (!changed) return { changed: false };
  let backup: string | undefined;
  if (existed) { backup = `${settingsFile}.bak-${now.toISOString().replaceAll(/[:.]/g, "-")}`; await fs.copyFile(settingsFile, backup); }
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2) + "\n");
  return { changed: true, backup };
}
