import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preflightVerifierSandbox } from "./sandbox.ts";
import { finalizeStage, flowAfterReview, flowAfterVerification } from "./pipeline-flow.ts";
import { cleanupRun, registerCleanupTool, recordCleanupFailure } from "./cleanup.ts";
import { shouldCleanup } from "./cleanup-policy.ts";
import { monitorPane, routeMonitorFailure } from "./pane-monitor.ts";
export { routeMonitorFailure } from "./pane-monitor.ts";
export function abortBeforePaneStart() { return { status: "aborted" as const, evidence: "pipeline aborted before pane startup; no child was started; pane preserved" }; }
export function shouldSplitForAttempt(paneId: string) { return paneId.length === 0; }

const MODELS = { plan: "openai-codex/gpt-5.6-sol", implement: "openai-codex/gpt-5.6-luna", verify: "openai-codex/gpt-5.6-terra", review: "openai-codex/gpt-5.6-sol" } as const;
type Stage = "plan" | "implement" | "verify" | "review";
type StageStatus = "pending" | "running" | "passed" | "failed" | "blocked" | "aborted";
type Input = { task: string; approvedPlan: string; cwd?: string; maxRepairCycles?: number; cleanupMode?: "ask" | "on-success" | "never" };
type CommandResult = { code: number; stdout: string; stderr: string };
type Attempt = { attempt: number; status: StageStatus; startedAt: string; finishedAt?: string; reportFile: string; paneId: string; verdict?: string; error?: string };
type Pane = { paneId: string; name: string; model: string; attempts: Attempt[] };
type LayoutCommand = (program: string, args: string[]) => Promise<CommandResult>;
const ROLE_LABELS = ["Implement · Luna", "Verify · Terra", "Review · Sol"] as const;
function shellQuote(value: string) { return "'" + value.replaceAll("'", "'\\''") + "'"; }

const STAGE_TIMEOUT_MS = Number(process.env.YORISHIRO_STAGE_TIMEOUT_MS ?? 30 * 60 * 1000);
const STARTUP_GRACE_MS = Number(process.env.YORISHIRO_STARTUP_GRACE_MS ?? 15 * 1000);
const INFO: Record<Stage, { label: string; tools: string }> = {
  plan: { label: "Plan · Sol", tools: "read,grep,find,ls,submit_stage_report" },
  implement: { label: "Implement · Luna", tools: "read,grep,find,ls,bash,edit,write,submit_stage_report" },
  verify: { label: "Verify · Terra", tools: "read,grep,find,ls,run_verification_command,submit_stage_report" },
  review: { label: "Review · Sol", tools: "read,grep,find,ls,submit_stage_report" },
};
const stages: Stage[] = ["plan", "implement", "verify", "review"];
function rootDir() { return process.env.YORISHIRO_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."); }
function now() { return new Date().toISOString(); }
function json(value: unknown) { return JSON.stringify(value, null, 2); }
async function atomicWrite(file: string, content: string) { const tmp = `${file}.tmp-${process.pid}`; await fs.writeFile(tmp, content, { encoding: "utf8", mode: 0o600 }); await fs.rename(tmp, file); }
export async function clearLaunchersAfterCleanup(artifactDir: string) {
  const runFile = path.join(artifactDir, "run.json");
  const audited = JSON.parse(await fs.readFile(runFile, "utf8"));
  for (const file of audited.launchers ?? []) await fs.rm(path.join(artifactDir, file), { force: true });
  audited.launchers = [];
  await atomicWrite(runFile, json(audited));
  return audited;
}
function command(program: string, args: string[], cwd?: string, signal?: AbortSignal, env?: Record<string, string>): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd, shell: false, env: env ? { ...process.env, ...env } : undefined, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d.toString(); }); child.stderr.on("data", d => { stderr += d.toString(); });
    const abort = () => { try { child.kill("SIGTERM"); } catch { /* exited */ } };
    if (signal) { if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); }
    child.on("error", e => resolve({ code: 1, stdout, stderr: stderr + e.message }));
    child.on("close", code => { if (signal) signal.removeEventListener("abort", abort); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}
function parse(value: CommandResult): any { try { return JSON.parse(value.stdout); } catch { return undefined; } }
function field(value: unknown, name: string): string | undefined { if (!value || typeof value !== "object") return undefined; const r = value as Record<string, unknown>; if (typeof r[name] === "string") return r[name]; for (const v of Object.values(r)) { const x = field(v, name); if (x) return x; } return undefined; }
function exactVerdict(text: string, choices: string[]): string | undefined { const lines = text.trim().split(/\r?\n/).map(x => x.trim()); if (!lines.length || lines.filter(x => /^VERDICT: /.test(x)).length !== 1) return undefined; const last = lines.at(-1)!; return choices.includes(last.slice("VERDICT: ".length)) ? last : undefined; }
async function snapshot(cwd: string, dir: string, name: string) { const s = await command("git", ["status", "--short"], cwd), u = await command("git", ["diff", "--no-ext-diff"], cwd), st = await command("git", ["diff", "--cached", "--no-ext-diff"], cwd); if (s.code || u.code || st.code) throw new Error(`git snapshot failed: ${s.stderr || u.stderr || st.stderr}`); await atomicWrite(path.join(dir, `${name}-status.txt`), s.stdout); await atomicWrite(path.join(dir, `${name}-diff.patch`), `${u.stdout}\n\n# --- staged diff ---\n${st.stdout}`); }
async function paneGet(id: string) { return parse(await command("herdr", ["pane", "get", id])); }
function herdrEnvelope(result: CommandResult, operation: string): any {
  if (result.code) throw new Error(`Herdr ${operation} failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  const value = parse(result), payload = value?.result;
  if (!payload || typeof payload !== "object") throw new Error(`Herdr ${operation} returned an invalid response envelope`);
  return payload;
}
export async function splitPane(target: string, direction: "right" | "down", ratio: string, cwd: string, run: LayoutCommand = (program, args) => command(program, args)) {
  const payload = herdrEnvelope(await run("herdr", ["pane", "split", target, "--direction", direction, "--ratio", ratio, "--cwd", cwd, "--no-focus"]), `pane split ${target}`);
  const paneId = payload.pane?.pane_id;
  if (typeof paneId !== "string" || !paneId) throw new Error(`Herdr pane split ${target} did not return a pane ID`);
  return { paneId, payload };
}
export async function inspectLayout(parent: string, run: LayoutCommand = (program, args) => command(program, args)) {
  const payload = herdrEnvelope(await run("herdr", ["pane", "layout", "--pane", parent]), "pane layout");
  if (!Array.isArray(payload.layout?.panes) || !Array.isArray(payload.layout?.splits)) throw new Error("Herdr pane layout returned no layout geometry");
  return payload.layout;
}
export function validateGeometry(layout: any, parent: string, workers: string[], expectedDirections: string[], expectedRatios: number[]) {
  const panes = layout.panes.map((p: any) => p?.pane_id);
  if (panes.length !== workers.length + 1 || ![parent, ...workers].every(id => panes.includes(id))) throw new Error("Herdr layout geometry has unexpected panes");
  const splits = layout.splits;
  if (splits.length < expectedDirections.length) throw new Error("Herdr layout geometry has too few splits");
  expectedDirections.forEach((direction, i) => { const split = splits[i]; if (split.direction !== direction || Math.abs(split.ratio - expectedRatios[i]) > 0.01) throw new Error(`Herdr layout split ${i} was not ${direction} at the requested ratio`); });
  if (layout.zoomed !== false) throw new Error("Herdr layout unexpectedly changed zoom state");
}
async function renameDetectedPane(id: string, label: string) {
  const payload = herdrEnvelope(await command("herdr", ["pane", "rename", id, label]), `pane rename ${id}`);
  if (payload.type !== "ok") throw new Error(`Herdr pane rename ${id} was not confirmed`);
}
async function writeLauncher(dir: string, stage: Stage, name: string, prompt: string, cwd: string, reportPath: string) {
  const promptFile = path.join(dir, `${stage}-prompt.md`), launcher = path.join(dir, `${stage}-launcher.sh`);
  await fs.writeFile(promptFile, prompt, { encoding: "utf8", mode: 0o700 });
  const reporter = path.join(rootDir(), "extensions", "development-pipeline", "stage-reporter.ts");
  const verifier = path.join(rootDir(), "extensions", "development-pipeline", "verifier-tools.ts");
  const target = stage === "verify" ? `export YORISHIRO_TARGET_CWD=${shellQuote(cwd)}\n` : "";
  const script = `#!/bin/sh\nset -eu\nexport YORISHIRO_REPORT_PATH=${shellQuote(reportPath)}\nexport YORISHIRO_REPORT_STAGE=${shellQuote(stage)}\n${target}prompt=$(cat -- ${shellQuote(promptFile)})\nexec pi --name ${shellQuote(name)} --model ${shellQuote(MODELS[stage])} --tools ${shellQuote(INFO[stage].tools)} --no-extensions --no-skills -e ${shellQuote(reporter)}${stage === "verify" ? ` -e ${shellQuote(verifier)}` : ""} "$prompt"\n`;
  await fs.writeFile(launcher, script, { encoding: "utf8", mode: 0o700 });
  return { promptFile, launcher };
}
export async function interrupt(id: string, run: (program: string, args: string[]) => Promise<CommandResult> = (program, args) => command(program, args), getPane: (paneId: string) => Promise<unknown> = paneGet): Promise<boolean> { for (let attempt = 0; attempt < 2; attempt++) { const ctrl = await run("herdr", ["pane", "send-keys", id, "ctrl+c"]); const esc = await run("herdr", ["pane", "send-keys", id, "escape"]); const waited = await run("herdr", ["agent", "wait", id, "--status", "idle", "--timeout", "2000"]); const pane = await getPane(id); const status = field(pane, "agent_status"); if (!ctrl.code && !esc.code && !waited.code && (status === "idle" || status === "unknown")) return true; await new Promise(r => setTimeout(r, 250)); } return false; }
async function startPane(stage: Stage, name: string, cwd: string, parent: string, tab: string, prompt: string, reportPath: string, workers: string[], artifactDir: string, onPaneCreated: (paneId: string, files: { promptFile: string; launcher: string }) => Promise<void>) {
  const layoutIndex = workers.length;
  const target = layoutIndex === 0 ? parent : workers.at(-1)!;
  const direction = layoutIndex === 0 ? "right" as const : "down" as const;
  const ratio = layoutIndex === 0 ? "0.55" : layoutIndex === 1 ? "0.3333333333" : "0.5";
  const files = await writeLauncher(artifactDir, stage, name, prompt, cwd, reportPath);
  const split = await splitPane(target, direction, ratio, cwd);
  await onPaneCreated(split.paneId, files);
  const launched = await command("herdr", ["pane", "run", split.paneId, shellQuote(files.launcher)]);
  if (launched.code) throw new Error(`Herdr pane run ${split.paneId} failed: ${launched.stderr || launched.stdout || `exit ${launched.code}`}`);
  const layout = await inspectLayout(parent);
  validateGeometry(layout, parent, [...workers, split.paneId], ["right", ...(layoutIndex > 0 ? ["down"] : []), ...(layoutIndex > 1 ? ["down"] : [])], [0.55, ...(layoutIndex > 0 ? [0.3333333333] : []), ...(layoutIndex > 1 ? [0.5] : [])]);
  return { paneId: split.paneId, layout, files };
}
async function sendPrompt(id: string, prompt: string) { const sent = await command("herdr", ["pane", "send-text", id, prompt]); if (sent.code) throw new Error(`Could not send prompt: ${sent.stderr || sent.stdout}`); const enter = await command("herdr", ["pane", "send-keys", id, "enter"]); if (enter.code) throw new Error(`Could not submit prompt: ${enter.stderr || enter.stdout}`); }
async function captureTranscript(id: string, file: string) { const result = await command("herdr", ["agent", "read", id, "--source", "recent-unwrapped", "--lines", "200", "--format", "text"]); if (result.code) throw new Error(`Herdr transcript capture failed: ${result.stderr || result.stdout}`); await atomicWrite(file, result.stdout); }
async function waitPane(id: string, report: string, signal: AbortSignal | undefined, update: (s: string) => void) {
  return monitorPane({
    reportExists: () => existsSync(report),
    signal,
    onUpdate: message => update(`pane ${id} ${message}`),
    timeoutMs: STAGE_TIMEOUT_MS,
    startupGraceMs: STARTUP_GRACE_MS,
    pollIntervalMs: Number(process.env.YORISHIRO_POLL_INTERVAL_MS ?? 1000),
    poll: async () => {
      await command("herdr", ["agent", "wait", id, "--status", "idle", "--timeout", "1000"], undefined, signal);
      const infoResult = await command("herdr", ["pane", "process-info", "--pane", id], undefined, signal);
      const pane = await paneGet(id);
      const processInfo = parse(infoResult);
      return { status: field(pane, "agent_status"), processInfo, processInfoValid: !infoResult.code && processInfo !== undefined };
    },
  });
}
function promptFor(stage: Stage, task: string, dir: string, plan: string, verification: string, review: string, attempt: number) {
  const label = INFO[stage].label, report = path.join(dir, `${stage}-${attempt}.md`);
  const common = `You are ${label} in a visible sequential pipeline. Work in the current repository. Task:\n${task}\n\nArtifacts: ${dir}. This is attempt ${attempt}.`;
  const reportInstruction = `Your final action must be calling submit_stage_report; the orchestrator selected a private pending target and will materialize it as ${report} for attempt ${attempt}. Do not claim completion without using that tool.`;
  if (stage === "plan") return `${common}\nInspect only; do not modify source. Produce requirements, acceptance criteria, risks, and ordered tasks. Submit verdict READY or BLOCKED. ${reportInstruction}`;
  if (stage === "implement") return `${common}\nApproved plan:\n${plan}\n${verification || review ? `\nReported issues to repair specifically (do not broaden scope):\n${verification ? `Verifier report:\n${verification}\n` : ""}${review ? `Reviewer report:\n${review}\n` : ""}` : ""}Implement only the approved plan. You may edit source, but do not run or claim final verification. Submit verdict COMPLETED or BLOCKED and describe changed files and checks not performed. ${reportInstruction}`;
  if (stage === "verify") return `${common}\nApproved plan:\n${plan}\nRead the implementation handoff(s) in the artifact directory. Inspect the live tree and run relevant checks through run_verification_command, which is the only command facility and is kernel-sandboxed read-only. Do not use shell escapes or attempt to write source or reports. Only submit_stage_report may write the report artifact. Submit PASS or FAIL with evidence. ${reportInstruction}`;
  return `${common}\nApproved plan:\n${plan}\nVerifier report:\n${verification}\n${review ? `Prior review report:\n${review}\n` : ""}Review the live tree, current diff, task, plan, implementation handoff, and verifier report. Also inspect baseline artifacts ${path.join(dir, "diffs/baseline-status.txt")} and ${path.join(dir, "diffs/baseline-diff.patch")} to distinguish pre-existing dirty changes where possible, and state limitations. Never edit source. Submit APPROVED or CHANGES_REQUESTED with prioritized findings. ${reportInstruction}`;
}

export default function (pi: ExtensionAPI) {
  registerCleanupTool(pi, rootDir());
  pi.registerTool({ name: "development_pipeline", label: "Development Pipeline", description: "Run an auditable development pipeline in visible Herdr panes.", parameters: Type.Object({ task: Type.String({ description: "User-approved development task" }), approvedPlan: Type.String({ description: "Plan approved in the parent Sol conversation" }), cwd: Type.Optional(Type.String()), maxRepairCycles: Type.Optional(Type.Integer({ minimum: 0, maximum: 1, default: 1 })), cleanupMode: Type.Optional(Type.String({ description: "ask, on-success, or never; defaults to ask" })) }), async execute(_id, input: Input, signal, onUpdate, ctx) {
    const task = input.task?.trim(), approvedPlan = input.approvedPlan?.trim(), cwd = path.resolve(input.cwd?.trim() || ctx.cwd);
    if (!task) throw new Error("task must not be empty");
    if (!approvedPlan) throw new Error("approvedPlan must not be empty; planning is expected in the parent Sol conversation");
    const cleanupMode = input.cleanupMode ?? "ask"; if (!["ask", "on-success", "never"].includes(cleanupMode)) throw new Error("cleanupMode must be ask, on-success, or never");
    for (const key of ["HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_SOCKET_PATH"]) if (!process.env[key]) throw new Error(`Herdr context is required (${key} is missing)`);
    if (!existsSync(process.env.HERDR_SOCKET_PATH!)) throw new Error(`Herdr socket is unavailable: ${process.env.HERDR_SOCKET_PATH}`);
    const herdr = await command("herdr", ["status"]); if (herdr.code) throw new Error(`Herdr is unavailable: ${herdr.stderr || herdr.stdout}`);
    try { if (!(await fs.stat(cwd)).isDirectory()) throw new Error(); } catch { throw new Error(`cwd does not exist: ${cwd}`); }
    await preflightVerifierSandbox(cwd);
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`, artifactDir = path.join(rootDir(), "artifacts", path.basename(cwd) || "repository", id), diffs = path.join(artifactDir, "diffs"); await fs.mkdir(diffs, { recursive: true });
    await atomicWrite(path.join(artifactDir, "request.md"), `# Request\n\n${task}\n\nTarget: ${cwd}\n`); await atomicWrite(path.join(artifactDir, "approved-plan.md"), `# Approved plan\n\n${approvedPlan}\n`); await snapshot(cwd, diffs, "baseline");
    const metadata: any = { targetRepository: path.basename(cwd), targetPath: cwd, startedAt: now(), parentPaneId: process.env.HERDR_PANE_ID, tabId: process.env.HERDR_TAB_ID, workspaceId: process.env.HERDR_WORKSPACE_ID, limitation: "Baseline captures pre-existing dirty changes; attribution is not perfect.", planning: { status: "passed", source: "parent Sol conversation", artifact: "approved-plan.md" }, stages: Object.fromEntries(stages.filter(s => s !== "plan").map(s => [s, { status: "pending", attempts: [] }])), panes: [], repairCycles: 0 };
    await atomicWrite(path.join(artifactDir, "run.json"), json(metadata));
    const parentPaneId = metadata.parentPaneId as string;
    const emit = (stage: string, text: string) => onUpdate?.({ content: [{ type: "text", text: `${stage}: ${text}` }], details: { stage, artifactDir, panes: metadata.panes } });
    let activePane: string | undefined, abortWork: Promise<boolean> | undefined, plan = approvedPlan, verification = "", review = "";
    const runStage = async (stage: Stage, text: string, attempt: number): Promise<{ valid: boolean; positive: boolean; verdict?: string; text: string }> => {
      const reportFile = path.join(artifactDir, `${stage}-${attempt}.md`), pendingReport = path.join(artifactDir, `${stage}-pending.md`), terminalFile = path.join(artifactDir, `${stage}-${attempt}.terminal.txt`), record: Attempt = { attempt, status: "running", startedAt: now(), reportFile: path.basename(reportFile), paneId: "" }; let terminalCaptured = false, snapshotSucceeded = true; let stageResult: { valid: boolean; positive: boolean; verdict?: string; text: string } = { valid: false, positive: false, text: "" };
      const stageData = metadata.stages[stage]; stageData.status = "running"; stageData.attempts.push(record); let pane = metadata.panes.find((p: Pane) => p.name === INFO[stage].label) as Pane | undefined;
      if (!pane) { pane = { paneId: "", name: INFO[stage].label, model: MODELS[stage], attempts: [] }; metadata.panes.push(pane); }
      pane.attempts.push(record); await atomicWrite(path.join(artifactDir, "run.json"), json(metadata));
      const abortHandler = () => { if (pane?.paneId && !abortWork) abortWork = interrupt(pane.paneId); };
      signal?.addEventListener("abort", abortHandler, { once: true });
      try {
        if (signal?.aborted) { const result = abortBeforePaneStart(); record.status = result.status; stageData.status = result.status; record.error = result.evidence; return { valid: false, positive: false, text: "" }; }
        await fs.rm(pendingReport, { force: true });
        if (shouldSplitForAttempt(pane.paneId)) {
          const workerIds = metadata.panes.filter((p: Pane) => p.paneId).map((p: Pane) => p.paneId);
          try {
            const started = await startPane(stage, pane.name, cwd, parentPaneId, process.env.HERDR_TAB_ID!, text, pendingReport, workerIds, artifactDir, async (paneId, files) => {
              pane.paneId = paneId;
              record.paneId = paneId;
              metadata.launchers = [...(metadata.launchers ?? []), ...[files.launcher, files.promptFile].map(file => path.basename(file))];
              await atomicWrite(path.join(artifactDir, "run.json"), json(metadata));
            });
            metadata.layout = { ...(metadata.layout ?? {}), intended: { parentPaneId, roleOrder: ROLE_LABELS }, actual: started.layout, error: undefined };
          } catch (error) {
            metadata.layout = { ...(metadata.layout ?? {}), intended: { parentPaneId, roleOrder: ROLE_LABELS }, error: error instanceof Error ? error.message : String(error) };
            throw error;
          }
          await atomicWrite(path.join(artifactDir, "run.json"), json(metadata));
        } else { record.paneId = pane.paneId; await atomicWrite(path.join(artifactDir, "run.json"), json(metadata)); await sendPrompt(pane.paneId, text); }
        if (signal?.aborted) { const result = await routeMonitorFailure("aborted", abortWork ? () => abortWork! : () => interrupt(pane.paneId)); record.status = result!.status; stageData.status = result!.status; record.error = result!.evidence; return { valid: false, positive: false, text: "" }; }
        activePane = pane.paneId; emit(stage, `${pane.paneId} (${pane.name}), attempt ${attempt}`);
        const state = await waitPane(pane.paneId, pendingReport, signal, m => emit(stage, m)); if (state === "aborted" || signal?.aborted) { const result = await routeMonitorFailure("aborted", abortWork ? () => abortWork! : () => interrupt(pane.paneId)); record.status = result!.status; stageData.status = result!.status; record.error = result!.evidence; return { valid: false, positive: false, text: "" }; }
        if (state === "startup-timeout" || state === "timeout" || state === "process-info-failure") { const result = await routeMonitorFailure(state, () => interrupt(pane.paneId)); record.status = result!.status; stageData.status = result!.status; record.error = result!.evidence; return { valid: false, positive: false, text: "" }; }
        if (state !== "settled") { record.status = "failed"; stageData.status = "failed"; record.error = `pane ${state}; pane preserved`; return { valid: false, positive: false, text: "" }; }
        await renameDetectedPane(pane.paneId, pane.name);
        await captureTranscript(pane.paneId, terminalFile); terminalCaptured = true;
        const submitted = await fs.readFile(pendingReport, "utf8"); await atomicWrite(reportFile, `# ${stage} report (attempt ${attempt})\n\n${submitted.replace(/^# .*?\n\n/, "")}`); await fs.rm(pendingReport, { force: true });
        let report = ""; try { report = await fs.readFile(reportFile, "utf8"); } catch { record.error = "missing durable report"; }
        const choices = stage === "plan" ? ["READY", "BLOCKED"] : stage === "implement" ? ["COMPLETED", "BLOCKED"] : stage === "verify" ? ["PASS", "FAIL"] : ["APPROVED", "CHANGES_REQUESTED"]; const v = exactVerdict(report, choices), valid = !!v, positive = stage === "plan" ? v === "VERDICT: READY" : stage === "implement" ? v === "VERDICT: COMPLETED" : stage === "verify" ? v === "VERDICT: PASS" : v === "VERDICT: APPROVED"; record.verdict = v;
        record.status = valid ? (positive ? "passed" : stage === "plan" && v === "VERDICT: BLOCKED" ? "blocked" : "failed") : "failed"; stageData.status = record.status; if (!valid) record.error = record.error || "missing or malformed final verdict"; stageResult.valid = valid; stageResult.positive = positive; stageResult.verdict = v; stageResult.text = report; return stageResult;
      } catch (e) { record.status = signal?.aborted ? "aborted" : "failed"; stageData.status = record.status; record.error = e instanceof Error ? e.message : String(e); return { valid: false, positive: false, text: "" }; }
      finally { if (pane?.paneId && !terminalCaptured) { try { await captureTranscript(pane.paneId, terminalFile); } catch (e) { record.error = record.error || `terminal capture failed: ${e instanceof Error ? e.message : String(e)}`; } } record.finishedAt = now(); stageData.finishedAt = record.finishedAt; try { await snapshot(cwd, diffs, `${stage}-${attempt}`); } catch (e) { if (record.status !== "aborted") { record.status = "failed"; stageData.status = "failed"; snapshotSucceeded = false; record.error = `stage snapshot failed: ${e instanceof Error ? e.message : String(e)}`; stageResult.valid = false; stageResult.positive = false; stageResult.text = ""; } } if (signal?.aborted && pane?.paneId) { abortWork ??= interrupt(pane.paneId); const stopped = await abortWork; if (!stopped) record.error = record.error || "abort could not be confirmed"; } const finalized = finalizeStage(stageResult, snapshotSucceeded); stageResult.valid = finalized.valid; stageResult.positive = finalized.positive; stageResult.text = finalized.text; signal?.removeEventListener("abort", abortHandler); await atomicWrite(path.join(artifactDir, "run.json"), json(metadata)); }
    };
    const finish = async (outcome: string) => { if (signal?.aborted) { if (activePane) { const stopped = abortWork ? await abortWork : await interrupt(activePane); if (!stopped) metadata.abortError = "Herdr could not confirm the active pane became idle"; } outcome = "ABORTED"; } metadata.finishedAt = now(); metadata.outcome = outcome; await atomicWrite(path.join(artifactDir, "run.json"), json(metadata)); return { content: [{ type: "text", text: `${outcome}\nArtifacts: ${artifactDir}\n${outcome === "SUCCESS" ? "Cleanup decision pending." : "Worker panes remain open."}` }], details: { outcome, artifactDir, panes: metadata.panes } }; };
    const implemented = await runStage("implement", promptFor("implement", task, artifactDir, plan, "", "", 1), 1); if (!implemented.positive) return finish(signal?.aborted ? "ABORTED" : "IMPLEMENTATION_FAILED");
    let cycle = 0;
    let verified = await runStage("verify", promptFor("verify", task, artifactDir, plan, "", "", 1), 1); verification = verified.text;
    if (!verified.valid) return finish(signal?.aborted ? "ABORTED" : "VERIFICATION_FAILED");
    if (!verified.positive) { if (flowAfterVerification(verified, cycle, input.maxRepairCycles ?? 1)[0] !== "implement") return finish(verified.valid ? "CHANGES_REQUIRED" : "VERIFICATION_FAILED"); cycle = 1; metadata.repairCycles = cycle; const repair = await runStage("implement", promptFor("implement", task, artifactDir, plan, verification, "", 2), 2); if (!repair.positive) return finish(signal?.aborted ? "ABORTED" : "REPAIR_FAILED"); verified = await runStage("verify", promptFor("verify", task, artifactDir, plan, "", "", 2), 2); verification = verified.text; if (!verified.positive) return finish(signal?.aborted ? "ABORTED" : verified.valid ? "CHANGES_REQUIRED" : "VERIFICATION_FAILED"); }
    let reviewed = await runStage("review", promptFor("review", task, artifactDir, plan, verification, "", 1), 1); review = reviewed.text; if (!reviewed.valid) return finish(signal?.aborted ? "ABORTED" : "REVIEW_FAILED");
    if (!reviewed.positive) { if (flowAfterReview(reviewed, cycle, input.maxRepairCycles ?? 1)[0] !== "implement") return finish(reviewed.valid ? "CHANGES_REQUIRED" : "REVIEW_FAILED"); cycle = 1; metadata.repairCycles = cycle; const repair = await runStage("implement", promptFor("implement", task, artifactDir, plan, verification, review, 3), 3); if (!repair.positive) return finish(signal?.aborted ? "ABORTED" : "REPAIR_FAILED"); verified = await runStage("verify", promptFor("verify", task, artifactDir, plan, "", "", 3), 3); verification = verified.text; if (!verified.positive) return finish(signal?.aborted ? "ABORTED" : verified.valid ? "CHANGES_REQUIRED" : "VERIFICATION_FAILED"); reviewed = await runStage("review", promptFor("review", task, artifactDir, plan, verification, review, 2), 2); review = reviewed.text; if (!reviewed.positive) return finish(signal?.aborted ? "ABORTED" : reviewed.valid ? "CHANGES_REQUIRED" : "REVIEW_FAILED"); }
    if (signal?.aborted) return finish("ABORTED");
    const finalResult: any = await finish("SUCCESS"); let cleanupMessage = cleanupMode === "never" ? "Cleanup disabled; all worker panes remain open." : "Cleanup declined; all worker panes remain open.";
    let confirmed = false;
    try { confirmed = cleanupMode === "ask" && ctx.hasUI ? await ctx.ui.confirm("Close pipeline panes?", "Close only this run's idle worker panes?") : false;
      if (shouldCleanup("SUCCESS", cleanupMode, ctx.hasUI, confirmed)) {
        try { const cleanup = await cleanupRun(artifactDir, path.join(rootDir(), "artifacts"), parentPaneId); const allClosed = cleanup.results.length > 0 && cleanup.results.every((r: any) => r.status === "closed"); cleanupMessage = allClosed ? "Cleanup complete; all worker panes were closed." : `Cleanup partial; worker panes remain where not closed. ${cleanup.summary}`; finalResult.details.cleanup = cleanup; if (allClosed) { const audited = await clearLaunchersAfterCleanup(artifactDir); metadata.cleanup = audited.cleanup; metadata.launchers = []; } }
        catch (error) { const message = error instanceof Error ? error.message : String(error); await recordCleanupFailure(artifactDir, path.join(rootDir(), "artifacts"), message); cleanupMessage = `Cleanup failed; all worker panes remain open where not already closed. ${message}`; finalResult.details.cleanupError = message; }
      } else if (cleanupMode === "ask" && !ctx.hasUI) cleanupMessage = "Cleanup unavailable without a usable UI; all worker panes remain open. Use development_pipeline_cleanup later.";
    } catch (error) { const message = error instanceof Error ? error.message : String(error); await recordCleanupFailure(artifactDir, path.join(rootDir(), "artifacts"), message); cleanupMessage = `Cleanup confirmation failed; all worker panes remain open. ${message}`; finalResult.details.cleanupError = message; }
    finalResult.content[0].text = finalResult.content[0].text.replace("Cleanup decision pending.", cleanupMessage); return finalResult;
    }
  });
}
