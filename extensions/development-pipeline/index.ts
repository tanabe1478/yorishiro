import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { preflightVerifierSandbox } from "./sandbox.ts";
import { finalizeStage, flowAfterReview, flowAfterVerification } from "./pipeline-flow.ts";
import { cleanupRun, markRunAborted, registerCleanupTool, registerResetTool, recordCleanupFailure } from "./cleanup.ts";
import { shouldCleanup } from "./cleanup-policy.ts";
import { validateReviewerReport, validateWorkerReport, workerHandoffFromReviewer } from "./role-contracts.ts";
import { transitionAfterReview } from "./three-role-flow.ts";
import { monitorPane, routeMonitorFailure } from "./pane-monitor.ts";
import { reviewPlan, reviewDiff, resolveReviewMode, executeDiffProcess, type PlanGateResult, type DiffGateResult } from "./human-review-gates.ts";
import { assertSuccessQualityState, captureFingerprintMap, changedPathsBetween, compareWorkerEvidence, hashQualityContract, validateQualityContract, qualityContractArtifact, type QualityContract, type FingerprintMap } from "./quality-contract.ts";
import { runSandboxedVerification } from "./verifier-tools.ts";
import { createHash } from "node:crypto";
export { routeMonitorFailure } from "./pane-monitor.ts";
export function abortBeforePaneStart() { return { status: "aborted" as const, evidence: "pipeline aborted before pane startup; no child was started; pane preserved" }; }
export function shouldSplitForAttempt(paneId: string) { return paneId.length === 0; }
export async function assertSuccessQualityEvidence(metadata: any, artifactDir: string, contract: QualityContract) {
  const artifactNames = await fs.readdir(artifactDir).catch(() => []);
  const gate = assertSuccessQualityState(metadata, contract, artifactNames);
  const expectedIds = contract.requiredChecks.map(item => item.id).sort();
  let artifact: any;
  try { artifact = JSON.parse(await fs.readFile(path.join(artifactDir, gate.artifact), "utf8")); } catch { throw new Error("SUCCESS quality gate artifact is missing or invalid"); }
  if (artifact.status !== "passed" || JSON.stringify(artifact.checks?.map((item: any) => item.id).sort()) !== JSON.stringify(expectedIds)) throw new Error("SUCCESS quality gate artifact does not prove the required checks");
}
export function assertInitialLayout(layout: any, parentPaneId: string) {
  const ids = Array.isArray(layout?.panes) ? layout.panes.map((pane: any) => pane?.pane_id) : [];
  if (ids.length !== 1 || ids[0] !== parentPaneId || !Array.isArray(layout?.splits) || layout.splits.length !== 0) {
    const occupied = ids.filter((id: unknown): id is string => typeof id === "string" && id !== parentPaneId);
    throw new Error(`LAYOUT_OCCUPIED: 現在のタブには既存ペインがあります（対象pane: ${occupied.join(", ") || "不明"}）。他人のペインは削除せず、安全停止しました。`);
  }
}
export async function rollbackPane(paneId: string, run: LayoutCommand = (program, args) => command(program, args)) {
  const result = await run("herdr", ["pane", "close", paneId]);
  if (result.code) throw new Error(`Herdr pane rollback ${paneId} failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
}

const MODELS = { implement: "openai-codex/gpt-5.6-luna", review: "openai-codex/gpt-5.6-sol" } as const;
type Stage = "implement" | "review";
type StageStatus = "pending" | "running" | "passed" | "failed" | "blocked" | "aborted";
type Input = { task: string; approvedPlan: string; qualityContract: QualityContract; cwd?: string; maxRepairCycles?: number; maxReviewCycles?: number; cleanupMode?: "ask" | "on-success" | "never"; planReviewMode?: "ask" | "required" | "skip"; diffReviewMode?: "ask" | "required" | "skip" };
type CommandResult = { code: number; stdout: string; stderr: string };
type QualityGateResult = { gate: number; status: "passed" | "failed" | "cancelled"; checks: Array<{ id: string; argv: string[]; exit: number; exitCode: number; timeout: boolean; timedOut: boolean; cancelled: boolean; outputHash: string; summary: string }> };
type QualityMismatch = { signature: string; errors: string[]; actualPaths: string[]; reportedPaths: string[]; violations: Array<{ type: string; contractId: string }> };
type Attempt = { attempt: number; status: StageStatus; startedAt: string; finishedAt?: string; reportFile: string; paneId: string; verdict?: string; error?: string };
type Pane = { paneId: string; name: string; model: string; attempts: Attempt[] };
type LayoutCommand = (program: string, args: string[]) => Promise<CommandResult>;
const ROLE_LABELS = ["Worker · Luna", "Reviewer · Sol"] as const;
function shellQuote(value: string) { return "'" + value.replaceAll("'", "'\\''") + "'"; }

const STAGE_TIMEOUT_MS = Number(process.env.YORISHIRO_STAGE_TIMEOUT_MS ?? 30 * 60 * 1000);
const STARTUP_GRACE_MS = Number(process.env.YORISHIRO_STARTUP_GRACE_MS ?? 15 * 1000);
const INFO: Record<Stage, { label: string; tools: string; thinking: "high" | "medium" }> = {
  implement: { label: "Worker · Luna", tools: "read,grep,find,ls,bash,edit,write,submit_stage_report", thinking: "high" },
  review: { label: "Reviewer · Sol", tools: "read,grep,find,ls,run_verification_command,submit_stage_report", thinking: "medium" },
};
const stages: Stage[] = ["implement", "review"];
function rootDir() { return process.env.YORISHIRO_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."); }
function now() { return new Date().toISOString(); }
function json(value: unknown) { return JSON.stringify(value, null, 2); }
async function recordGate(dir: string, name: string, result: PlanGateResult | DiffGateResult) { await atomicWrite(path.join(dir, name), json(result)); }
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
async function fingerprintSnapshot(cwd: string, dir: string, name: string): Promise<FingerprintMap> { const map = await captureFingerprintMap(cwd); await atomicWrite(path.join(dir, `${name}-fingerprint.json`), json(map)); return map; }
function hashOutput(text: string) { return createHash("sha256").update(text, "utf8").digest("hex"); }
async function runQualityGate(contract: QualityContract, cwd: string, gate: number, signal?: AbortSignal): Promise<QualityGateResult> {
  const checks: QualityGateResult["checks"] = [];
  for (const check of contract.requiredChecks) {
    const timeoutMs = check.timeoutMs ?? 120000;
    let result: { code: number; stdout: string; stderr: string; truncated: boolean; cancelled: boolean; timedOut: boolean };
    try { result = await runSandboxedVerification(check.program, check.args, cwd, timeoutMs, signal); }
    catch (error) { result = { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error), truncated: false, cancelled: !!signal?.aborted, timedOut: false }; }
    const output = `${result.stdout}${result.stderr}`;
    const status = result.timedOut ? "タイムアウトしました" : result.cancelled ? "キャンセルされました" : `終了コード${result.code}`;
    checks.push({ id: check.id, argv: [check.program, ...check.args], exit: result.code, exitCode: result.code, timeout: result.timedOut, timedOut: result.timedOut, cancelled: result.cancelled, outputHash: hashOutput(output), summary: `独立check「${check.id}」は${status}。出力はSHA-256で記録しました。` });
  }
  return { gate, status: checks.every(check => check.exitCode === 0 && !check.timeout && !check.cancelled) ? "passed" : signal?.aborted ? "cancelled" : "failed", checks };
}
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
export async function renameDetectedPane(id: string, label: string, run: LayoutCommand = (program, args) => command(program, args)) {
  const payload = herdrEnvelope(await run("herdr", ["pane", "rename", id, label]), `pane rename ${id}`);
  const responseType = payload.type;
  const returnedId = payload.pane?.pane_id;
  if (!((responseType === "ok" || responseType === "pane_info") && returnedId === id)) throw new Error(`Herdr pane rename ${id} was not confirmed with matching pane ID`);
  return payload;
}
async function writeLauncher(dir: string, stage: Stage, name: string, prompt: string, cwd: string, reportPath: string) {
  const promptFile = path.join(dir, `${stage}-prompt.md`), launcher = path.join(dir, `${stage}-launcher.sh`);
  await fs.writeFile(promptFile, prompt, { encoding: "utf8", mode: 0o700 });
  const reporter = path.join(rootDir(), "extensions", "development-pipeline", "stage-reporter.ts");
  const verifier = path.join(rootDir(), "extensions", "development-pipeline", "verifier-tools.ts");
  const role = stage === "implement" ? "Worker · Luna" : "Reviewer · Sol";
  const schema = stage === "implement" ? "worker" : "reviewer";
  const target = `export YORISHIRO_REPORT_SCHEMA=${shellQuote(schema)}\nexport YORISHIRO_REPORT_STAGE=${shellQuote(stage)}\nexport YORISHIRO_ROLE=${shellQuote(role)}\nexport YORISHIRO_REPORT_PATH=${shellQuote(reportPath)}\nexport YORISHIRO_PROMPT_PATH=${shellQuote(promptFile)}\n${stage === "review" ? `export YORISHIRO_TARGET_CWD=${shellQuote(cwd)}\n` : ""}`;
  const script = `#!/bin/sh\nset -eu\n${target}prompt=$(cat -- ${shellQuote(promptFile)})\nexec pi --name ${shellQuote(name)} --model ${shellQuote(MODELS[stage])} --thinking ${shellQuote(INFO[stage].thinking)} --tools ${shellQuote(INFO[stage].tools)} --no-extensions --no-skills -e ${shellQuote(reporter)}${stage === "review" ? ` -e ${shellQuote(verifier)}` : ""} "$prompt"\n`;
  await fs.writeFile(launcher, script, { encoding: "utf8", mode: 0o700 });
  return { promptFile, launcher };
}
export async function interrupt(id: string, run: (program: string, args: string[]) => Promise<CommandResult> = (program, args) => command(program, args), getPane: (paneId: string) => Promise<unknown> = paneGet): Promise<boolean> { for (let attempt = 0; attempt < 2; attempt++) { const ctrl = await run("herdr", ["pane", "send-keys", id, "ctrl+c"]); const esc = await run("herdr", ["pane", "send-keys", id, "escape"]); const waited = await run("herdr", ["agent", "wait", id, "--status", "idle", "--timeout", "2000"]); const pane = await getPane(id); const status = field(pane, "agent_status"); if (!ctrl.code && !esc.code && !waited.code && (status === "idle" || status === "unknown")) return true; await new Promise(r => setTimeout(r, 250)); } return false; }
async function startPane(stage: Stage, name: string, cwd: string, parent: string, tab: string, prompt: string, reportPath: string, workers: string[], artifactDir: string, onPaneCreated: (paneId: string, files: { promptFile: string; launcher: string }) => Promise<void>) {
  const layoutIndex = workers.length;
  const target = layoutIndex === 0 ? parent : workers.at(-1)!;
  const direction = layoutIndex === 0 ? "right" as const : "down" as const;
  const ratio = layoutIndex === 0 ? "0.55" : "0.5";
  const split = await splitPane(target, direction, ratio, cwd);
  let layout: any;
  try {
    layout = await inspectLayout(parent);
    validateGeometry(layout, parent, [...workers, split.paneId], ["right", ...(layoutIndex > 0 ? ["down"] : [])], [0.55, ...(layoutIndex > 0 ? [0.5] : [])]);
  } catch (error) {
    try { await rollbackPane(split.paneId); } catch (rollbackError) { throw new Error(`${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
    throw error;
  }
  const files = await writeLauncher(artifactDir, stage, name, prompt, cwd, reportPath);
  await onPaneCreated(split.paneId, files);
  const launched = await command("herdr", ["pane", "run", split.paneId, shellQuote(files.launcher)]);
  if (launched.code) throw new Error(`Herdr pane run ${split.paneId} failed: ${launched.stderr || launched.stdout || `exit ${launched.code}`}`);
  return { paneId: split.paneId, layout, files };
}
async function sendPrompt(id: string, prompt: string) { const sent = await command("herdr", ["pane", "send-text", id, prompt]); if (sent.code) throw new Error(`Could not send prompt: ${sent.stderr || sent.stdout || `exit ${sent.code}`}`); const enter = await command("herdr", ["pane", "send-keys", id, "enter"]); if (enter.code) throw new Error(`Could not submit prompt: ${enter.stderr || enter.stdout}`); }
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
function promptFor(stage: Stage, task: string, dir: string, plan: string, review: string, attempt: number, workerReportPath = "", workerReportContent = "", contractJson = "", qualityGatePath = "", qualityGateContent = "", workerSnapshotAttempt = attempt) {
  const label = INFO[stage].label, report = path.join(dir, `${stage}-${attempt}.json`);
  const common = `あなたは${label}です。可視化された逐次pipelineの一員として、現在のrepositoryで作業してください。\n作業内容：\n${task}\n\nartifact保存先：${dir}。今回のattempt：${attempt}。`;
  const reportInstruction = `最後に必ずsubmit_stage_reportを呼び出し、structured JSON契約で報告してください。orchestratorが指定したpending先は${report}（attempt ${attempt}）です。`;
  if (stage === "implement") return `${common}\n承認済み計画：\n${plan}\nquality contract（このJSONを厳守）：\n${contractJson}\n${review ? `\norchestratorからのsanitized修正finding（このstructured dataだけを使用）：\n${review}\n` : ""}承認済み計画の範囲だけを実装してください。sourceを変更し、実装・test・動作確認を行った結果を、COMPLETEDまたはBLOCKEDと日本語のsummary、changedScope、evidenceで報告してください。COMPLETEDのcompletedPlanItemsは契約の全planItemsをidごとに一度ずつ、BLOCKEDは実際に完了したcontract IDのsubsetだけを含め、日本語のevidenceを付けてください。どちらもchangedPathsにはbaseline以後のgit実diffを正確に列挙し、allowedPathPrefixesを守ってください。${reportInstruction}`;
  return `${common}\n承認済み計画：\n${plan}\nquality contract（validator済み）：\n${contractJson}\n現在のWorker report path：${workerReportPath}\nvalidator済みWorker report JSON本文：\n${workerReportContent}\ncurrent quality-gate artifact path：${qualityGatePath}\nvalidator済みquality-gate内容：\n${qualityGateContent}\n今回のWorker attemptのactual snapshot：${path.join(dir, `diffs/implement-${workerSnapshotAttempt}-status.txt`)} / ${path.join(dir, `diffs/implement-${workerSnapshotAttempt}-diff.patch`)} / ${path.join(dir, `diffs/implement-${workerSnapshotAttempt}-fingerprint.json`)}\nbaseline：${path.join(dir, "diffs/baseline-status.txt")} / ${path.join(dir, "diffs/baseline-diff.patch")} / ${path.join(dir, "diffs/baseline-fingerprint.json")}\nread-onlyの確認手段だけを使い、sourceを変更しないでください。Workerの自己申告ではなくactual changed pathsと独立check結果を確認し、APPROVED、APPROVED_WITH_NOTES、CHANGES_REQUESTED、NEEDS_PLANNERとstructuredな日本語fieldを報告してください。${reportInstruction}`;
}

export default function (pi: ExtensionAPI) {
  registerCleanupTool(pi, rootDir());
  registerResetTool(pi, rootDir());
  pi.registerTool({ name: "development_pipeline", label: "Development Pipeline", description: "可視のHerdrペインで監査可能な開発パイプラインを実行します。", parameters: Type.Object({ task: Type.String({ description: "User-approved development task" }), approvedPlan: Type.String({ description: "Plan approved in the parent Sol conversation" }), qualityContract: Type.Object({ planItems: Type.Array(Type.Object({ id: Type.String(), description: Type.String() })), requiredChecks: Type.Array(Type.Object({ id: Type.String(), program: Type.String(), args: Type.Array(Type.String()), timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 300000 })) })), allowedPathPrefixes: Type.Optional(Type.Array(Type.String())) }), cwd: Type.Optional(Type.String()), maxReviewCycles: Type.Optional(Type.Integer({ minimum: 0, maximum: 3, default: 2 })), maxRepairCycles: Type.Optional(Type.Integer({ minimum: 0, maximum: 3, default: 2 })), cleanupMode: Type.Optional(Type.String({ description: "ask, on-success, or never; defaults to ask" })), planReviewMode: Type.Optional(Type.String({ description: "計画レビュー: ask, required, skip（既定 ask）" })), diffReviewMode: Type.Optional(Type.String({ description: "差分レビュー: ask, required, skip（既定 ask）" })) }), async execute(_id, input: Input, signal, onUpdate, ctx) {
    const contractCheck = validateQualityContract(input?.qualityContract);
    if (!contractCheck.valid) throw new Error(`Invalid qualityContract: ${contractCheck.error}`);
    const qualityContract = contractCheck.value;
    const task = input.task?.trim(), approvedPlan = input.approvedPlan?.trim(), cwd = path.resolve(input.cwd?.trim() || ctx.cwd);
    if (!task) throw new Error("task must not be empty");
    if (!approvedPlan) throw new Error("approvedPlan must not be empty; planning is expected in the parent Sol conversation");
    const cleanupMode = input.cleanupMode ?? "ask"; if (!["ask", "on-success", "never"].includes(cleanupMode)) throw new Error("cleanupMode must be ask, on-success, or never");
    const planReviewMode = resolveReviewMode(input.planReviewMode), diffReviewMode = resolveReviewMode(input.diffReviewMode);
    for (const key of ["HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_SOCKET_PATH"]) if (!process.env[key]) throw new Error(`Herdr context is required (${key} is missing)`);
    if (!existsSync(process.env.HERDR_SOCKET_PATH!)) throw new Error(`Herdr socket is unavailable: ${process.env.HERDR_SOCKET_PATH}`);
    const herdr = await command("herdr", ["status"]); if (herdr.code) throw new Error(`Herdr is unavailable: ${herdr.stderr || herdr.stdout}`);
    try { if (!(await fs.stat(cwd)).isDirectory()) throw new Error(); } catch { throw new Error(`cwd does not exist: ${cwd}`); }
    await preflightVerifierSandbox(cwd);
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`, artifactDir = path.join(rootDir(), "artifacts", path.basename(cwd) || "repository", id), diffs = path.join(artifactDir, "diffs"); await fs.mkdir(diffs, { recursive: true });
    await atomicWrite(path.join(artifactDir, "request.md"), `# 依頼\n\n${task}\n\n対象: ${cwd}\n`); await atomicWrite(path.join(artifactDir, "approved-plan.md"), `# 承認済み計画\n\n${approvedPlan}\n`); await atomicWrite(path.join(artifactDir, "quality-contract.json"), json(qualityContractArtifact(qualityContract))); await snapshot(cwd, diffs, "baseline");
    const baselineFingerprint = await fingerprintSnapshot(cwd, diffs, "baseline");
    const qualityContractHash = hashQualityContract(qualityContract);
    const metadata: any = { targetRepository: path.basename(cwd), targetPath: cwd, startedAt: now(), qualityContractHash, qualityContract: { sha256: qualityContractHash, artifact: "quality-contract.json" }, baselineFingerprint: "diffs/baseline-fingerprint.json", parentPaneId: process.env.HERDR_PANE_ID, tabId: process.env.HERDR_TAB_ID, workspaceId: process.env.HERDR_WORKSPACE_ID, limitation: "baseline fingerprintとの差分で今回変化したpathを機械的に照合します。", planning: { status: "pending", mode: planReviewMode, source: "親Plannerセッション", artifact: "approved-plan.md" }, humanReview: { planMode: planReviewMode, diffMode: diffReviewMode }, stages: Object.fromEntries(stages.filter(s => s !== "plan").map(s => [s, { status: "pending", attempts: [] }])), panes: [], repairCycles: 0, qualityGates: [], qualityContractBaselineCount: Object.keys(baselineFingerprint).length };
    await atomicWrite(path.join(artifactDir, "run.json"), json(metadata));
    const parentPaneId = metadata.parentPaneId as string;
    const emit = (stage: string, text: string) => onUpdate?.({ content: [{ type: "text", text: `${stage}: ${text}` }], details: { stage, artifactDir, panes: metadata.panes } });
    const heartbeat = async (stage: string, attempt: number, reason: string) => {
      metadata.heartbeat = { stage, attempt, updatedAt: now(), waitingReason: reason };
      await atomicWrite(path.join(artifactDir, "run.json"), json(metadata));
      emit(stage, `進捗: 試行${attempt}、${reason}`);
    };
    let activePane: string | undefined, abortWork: Promise<boolean> | undefined, plan = approvedPlan, verification = "", review = "";
    const runStage = async (stage: Stage, text: string, attempt: number): Promise<{ valid: boolean; positive: boolean; verdict?: string; text: string; qualityMismatch?: QualityMismatch }> => {
      const reportFile = path.join(artifactDir, `${stage}-${attempt}.json`), pendingReport = path.join(artifactDir, `${stage}-pending.json`), terminalFile = path.join(artifactDir, `${stage}-${attempt}.terminal.txt`), record: Attempt = { attempt, status: "running", startedAt: now(), reportFile: path.basename(reportFile), paneId: "" }; let terminalCaptured = false, snapshotSucceeded = true, parsed: any, report = ""; let stageResult: { valid: boolean; positive: boolean; verdict?: string; text: string; qualityMismatch?: QualityMismatch } = { valid: false, positive: false, text: "" };
      const stageData = metadata.stages[stage]; stageData.status = "running"; stageData.attempts.push(record); let pane = metadata.panes.find((p: Pane) => p.name === INFO[stage].label) as Pane | undefined;
      if (!pane) { pane = { paneId: "", name: INFO[stage].label, model: MODELS[stage], attempts: [] }; metadata.panes.push(pane); }
      pane.attempts.push(record); await atomicWrite(path.join(artifactDir, "run.json"), json(metadata));
      const abortHandler = () => { if (pane?.paneId && !abortWork) abortWork = interrupt(pane.paneId); };
      signal?.addEventListener("abort", abortHandler, { once: true });
      try {
        if (signal?.aborted) { const result = abortBeforePaneStart(); record.status = result.status; stageData.status = result.status; record.error = result.evidence; return { valid: false, positive: false, text: "" }; }
        await fs.rm(pendingReport, { force: true });
        await heartbeat(stage, attempt, "子ペインの準備を開始しています");
        if (shouldSplitForAttempt(pane.paneId)) {
          if (metadata.panes.every((p: Pane) => !p.paneId)) {
            const initialLayout = await inspectLayout(parentPaneId);
            try { assertInitialLayout(initialLayout, parentPaneId); }
            catch (error) {
              const occupiedPaneIds = initialLayout.panes.map((p: any) => p.pane_id).filter((id: string) => id !== parentPaneId);
              metadata.occupiedPaneIds = occupiedPaneIds;
              metadata.layout = { ...(metadata.layout ?? {}), initial: initialLayout, status: "LAYOUT_OCCUPIED", occupiedPaneIds, error: error instanceof Error ? error.message : String(error) };
              await atomicWrite(path.join(artifactDir, "run.json"), json(metadata));
              throw error;
            }
            metadata.layout = { ...(metadata.layout ?? {}), initial: initialLayout, intended: { parentPaneId, roleOrder: ROLE_LABELS } };
            await atomicWrite(path.join(artifactDir, "run.json"), json(metadata));
          }
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
        activePane = pane.paneId; await heartbeat(stage, attempt, `${pane.paneId}（${pane.name}）の完了を待機しています`);
        const state = await waitPane(pane.paneId, pendingReport, signal, m => emit(stage, m)); if (state === "aborted" || signal?.aborted) { const result = await routeMonitorFailure("aborted", abortWork ? () => abortWork! : () => interrupt(pane.paneId)); record.status = result!.status; stageData.status = result!.status; record.error = result!.evidence; return { valid: false, positive: false, text: "" }; }
        if (state === "startup-timeout" || state === "timeout" || state === "process-info-failure") { const result = await routeMonitorFailure(state, () => interrupt(pane.paneId)); record.status = result!.status; stageData.status = result!.status; record.error = result!.evidence; return { valid: false, positive: false, text: "" }; }
        if (state !== "settled") { record.status = "failed"; stageData.status = "failed"; record.error = `pane ${state}; pane preserved`; return { valid: false, positive: false, text: "" }; }
        await renameDetectedPane(pane.paneId, pane.name);
        await captureTranscript(pane.paneId, terminalFile); terminalCaptured = true;
        const submitted = await fs.readFile(pendingReport, "utf8"); await atomicWrite(reportFile, submitted); await fs.rm(pendingReport, { force: true });
        try { report = await fs.readFile(reportFile, "utf8"); } catch { record.error = "missing durable report"; }
        try { parsed = JSON.parse(report); } catch { parsed = undefined; }
        const checked = stage === "implement" ? (parsed ? validateWorkerReport(parsed) : { valid: false as const, error: "missing or malformed worker report" }) : (parsed ? validateReviewerReport(parsed) : { valid: false as const, error: "missing or malformed reviewer report" });
        const v = parsed?.verdict ? `VERDICT: ${parsed.verdict}` : undefined, valid = checked.valid, positive = valid && (stage === "implement" ? parsed.verdict === "COMPLETED" : parsed.verdict === "APPROVED" || parsed.verdict === "APPROVED_WITH_NOTES"); record.verdict = v;
        if (stage === "implement") metadata.workerValidations = [...(metadata.workerValidations ?? []), { attempt, accepted: valid, verdict: parsed?.verdict, validator: "validateWorkerReport" }];
        record.status = valid ? (positive ? "passed" : "failed") : "failed"; stageData.status = record.status; if (!valid) record.error = record.error || (checked as any).error; stageResult.valid = valid; stageResult.positive = positive; stageResult.verdict = v; stageResult.text = report; return stageResult;
      } catch (e) {
        record.status = signal?.aborted ? "aborted" : "failed"; stageData.status = record.status; record.error = e instanceof Error ? e.message : String(e);
        if (pane?.paneId && (record.status === "aborted" || record.paneId === pane.paneId)) {
          abortWork ??= interrupt(pane.paneId);
          const stopped = await abortWork;
          if (!stopped) record.error += "; 子ペインをidleにできませんでした";
          else if (!record.error.includes("pane preserved")) record.error += "; active child stopped; pane preserved";
        }
        return { valid: false, positive: false, text: "" };
      }
      finally { if (pane?.paneId && !terminalCaptured) { try { await captureTranscript(pane.paneId, terminalFile); } catch (e) { record.error = record.error || `terminal capture failed: ${e instanceof Error ? e.message : String(e)}`; } } record.finishedAt = now(); stageData.finishedAt = record.finishedAt; try { await snapshot(cwd, diffs, `${stage}-${attempt}`); const currentFingerprint = await fingerprintSnapshot(cwd, diffs, `${stage}-${attempt}`); stageData.fingerprint = `diffs/${stage}-${attempt}-fingerprint.json`; if (stage === "implement" && stageResult.valid && parsed) { const actualPaths = changedPathsBetween(baselineFingerprint, currentFingerprint); const evidence = compareWorkerEvidence(parsed, qualityContract, actualPaths); if (!evidence.valid) { const mismatch = { signature: evidence.signature, errors: evidence.errors, actualPaths, reportedPaths: parsed.changedPaths ?? [], violations: evidence.violations }; stageResult.qualityMismatch = mismatch; stageResult.valid = false; stageResult.positive = false; record.status = "failed"; stageData.status = "failed"; record.error = "WORKER_EVIDENCE_MISMATCH: " + evidence.errors.join("。 "); await atomicWrite(path.join(artifactDir, `quality-gate-${attempt}.json`), json({ gate: attempt, status: "failed", code: "WORKER_EVIDENCE_MISMATCH", details: "Workerの自己申告と実diffまたはquality contractが一致しません。", errors: evidence.errors, actualPaths, reportedPaths: parsed.changedPaths ?? [] })); } } } catch (e) { if (record.status !== "aborted") { record.status = "failed"; stageData.status = "failed"; snapshotSucceeded = false; record.error = `stage fingerprint failed: ${e instanceof Error ? e.message : String(e)}`; stageResult.valid = false; stageResult.positive = false; stageResult.text = ""; } } if (signal?.aborted && pane?.paneId) { abortWork ??= interrupt(pane.paneId); const stopped = await abortWork; if (!stopped) record.error = record.error || "abort could not be confirmed"; } const finalized = finalizeStage(stageResult, snapshotSucceeded); stageResult.valid = finalized.valid; stageResult.positive = finalized.positive; stageResult.text = finalized.text; signal?.removeEventListener("abort", abortHandler); await atomicWrite(path.join(artifactDir, "run.json"), json(metadata)); }
    };
    const qualityAfterWorker = async (worker: { qualityMismatch?: QualityMismatch }, attempt: number): Promise<string | undefined> => {
      if (worker.qualityMismatch) {
        const mismatch = worker.qualityMismatch;
        const history = metadata.qualityContractViolations ?? (metadata.qualityContractViolations = []);
        const repeated = history.some((entry: any) => entry.signature === mismatch.signature);
        const sanitizedFinding = { code: "WORKER_EVIDENCE_MISMATCH", signature: mismatch.signature, violations: mismatch.violations.map(item => ({ type: item.type, contractId: item.contractId })), instruction: "quality contractと実diffに一致するreportへ修正してください。" };
        history.push({ attempt, signature: mismatch.signature, violations: sanitizedFinding.violations, errors: mismatch.errors, actualPaths: mismatch.actualPaths, reportedPaths: mismatch.reportedPaths });
        if (repeated) {
          metadata.plannerReason = "同一signatureのquality evidence違反がquality repair後も再発したため、Planner裁定でLunaからSol Workerへ切り替える必要があります。";
          metadata.qualityFallback = { reason: metadata.plannerReason, from: "Luna", to: "Sol Worker", automatic: false, trigger: "QC_REPEAT_UNREACHABLE" };
          await atomicWrite(path.join(artifactDir, "quality-planner-escalation.json"), json(metadata.qualityFallback));
          return "NEEDS_PLANNER";
        }
        if (history.length > 1) return "WORKER_EVIDENCE_MISMATCH";
        metadata.qualityRepair = { status: "requested", sourceAttempt: attempt, nextAttempt: attempt + 1, paneId: metadata.panes.find((p: Pane) => p.name === INFO.implement.label)?.paneId, artifact: `quality-repair-${attempt}.json`, finding: sanitizedFinding };
        await atomicWrite(path.join(artifactDir, `quality-repair-${attempt}.json`), json(sanitizedFinding));
        await atomicWrite(path.join(artifactDir, "run.json"), json(metadata));
        return "QUALITY_REPAIR";
      }
      const gate = await runQualityGate(qualityContract, cwd, attempt, signal);
      const gateFile = `quality-gate-${attempt}.json`;
      await atomicWrite(path.join(artifactDir, gateFile), json(gate));
      metadata.qualityGates = [...(metadata.qualityGates ?? []), { ...gate, artifact: gateFile }];
      await atomicWrite(path.join(artifactDir, "run.json"), json(metadata));
      return gate.status === "passed" ? undefined : "QUALITY_GATE_FAILED";
    };
    let implementAttempt = 0;
    const resolveQualityMismatch = async (worker: Awaited<ReturnType<typeof runStage>>, repairContext: string) => {
      if (!worker.qualityMismatch) return { worker };
      const decision = await qualityAfterWorker(worker, implementAttempt);
      if (decision !== "QUALITY_REPAIR") return { worker, outcome: decision };
      implementAttempt++;
      const finding = json(metadata.qualityRepair.finding);
      const repaired = await runStage("implement", promptFor("implement", task, artifactDir, plan, finding, implementAttempt, "", "", json(qualityContract)), implementAttempt);
      metadata.qualityRepair = { ...metadata.qualityRepair, status: repaired.qualityMismatch ? "failed" : "completed", completedAttempt: implementAttempt, context: repairContext };
      await atomicWrite(path.join(artifactDir, "run.json"), json(metadata));
      if (!repaired.qualityMismatch) return { worker: repaired };
      return { worker: repaired, outcome: await qualityAfterWorker(repaired, implementAttempt) };
    };
    const finish = async (outcome: string) => { if (signal?.aborted) { if (activePane) { const stopped = abortWork ? await abortWork : await interrupt(activePane); if (!stopped) metadata.abortError = "Herdr could not confirm the active pane became idle"; } outcome = "ABORTED"; } if (outcome === "ABORTED" && !metadata.cleanup) metadata.cleanup = { status: "aborted", results: (metadata.panes ?? []).map((pane: Pane) => ({ paneId: pane.paneId, name: pane.name, status: "skipped", reason: "cleanupは中断されました" })) }; metadata.finishedAt = now(); metadata.outcome = outcome; await atomicWrite(path.join(artifactDir, "run.json"), json(metadata)); return { content: [{ type: "text", text: `${outcome}\n成果物: ${artifactDir}\n${outcome === "SUCCESS" ? "cleanupの判断待ちです。" : "子ペインを保持しました。"}` }], details: { outcome, cleanupDecision: cleanupMode, artifactDir, panes: metadata.panes } }; };
    let cycle = 0;
    const hasReviewEventBus = !!(pi as any).events;
    const reviewEventBus = (pi as any).events ?? { emit: async () => { throw new Error("review event bus is unavailable"); } };
    if (signal?.aborted) {
      await runStage("implement", promptFor("implement", task, artifactDir, plan, "", 1, "", "", json(qualityContract)), 1);
      return finish("ABORTED");
    }
    const planGate = await reviewPlan({ mode: planReviewMode, planContent: approvedPlan, planFilePath: path.join(artifactDir, "approved-plan.md"), origin: "親Plannerセッション", eventBus: reviewEventBus, signal, confirm: ctx.hasUI && hasReviewEventBus ? () => ctx.ui.confirm("計画を人間に確認してもらいますか？", "承認されるまで子ペインは起動しません。") : undefined });
    await recordGate(artifactDir, "plan-review.json", planGate);
    metadata.planning = { ...metadata.planning, status: planGate.decision, hash: planGate.hash, reviewId: planGate.reviewId, approvedAt: planGate.approvedAt, feedback: planGate.feedback, error: planGate.error, artifact: "plan-review.json" };
    await atomicWrite(path.join(artifactDir, "run.json"), json(metadata));
    if (signal?.aborted || planGate.decision === "aborted") return finish("ABORTED");
    if (planGate.decision === "rejected") return finish("PLAN_REJECTED");
    if (planReviewMode === "required" && planGate.decision !== "approved") return finish("PLAN_REVIEW_UNAVAILABLE");
    implementAttempt = 1;
    let implemented = await runStage("implement", promptFor("implement", task, artifactDir, plan, "", implementAttempt, "", "", json(qualityContract)), implementAttempt);
    let qualityResolution = await resolveQualityMismatch(implemented, "initial"); implemented = qualityResolution.worker;
    if (qualityResolution.outcome) return finish(signal?.aborted ? "ABORTED" : qualityResolution.outcome);
    if (!implemented.positive) return finish(signal?.aborted ? "ABORTED" : implemented.valid ? "IMPLEMENTATION_BLOCKED" : "IMPLEMENTATION_FAILED");
    const initialQualityOutcome = await qualityAfterWorker(implemented, implementAttempt); if (initialQualityOutcome) return finish(initialQualityOutcome);
    const initialGateContent = await fs.readFile(path.join(artifactDir, `quality-gate-${implementAttempt}.json`), "utf8");
    let reviewed = await runStage("review", promptFor("review", task, artifactDir, plan, "", 1, path.join(artifactDir, `implement-${implementAttempt}.json`), implemented.text, json(qualityContract), path.join(artifactDir, `quality-gate-${implementAttempt}.json`), initialGateContent, implementAttempt), 1); review = reviewed.text;
    if (!reviewed.valid) return finish(signal?.aborted ? "ABORTED" : "REVIEW_FAILED");
    while (!reviewed.positive) {
      const reviewData = (() => { try { return JSON.parse(reviewed.text); } catch { return undefined; } })();
      if (!reviewData) return finish("REVIEW_FAILED");
      const transition = transitionAfterReview(reviewData, metadata.reviewIds ?? [], cycle, { maxReviewCycles: input.maxReviewCycles, maxRepairCycles: input.maxRepairCycles });
      metadata.reviewIds = transition.reviewIds; metadata.reviewBudget = transition.budget; metadata.repeatedIds = transition.repeatedIds; if (transition.plannerReason) metadata.plannerReason = transition.plannerReason;
      if (transition.outcome === "NEEDS_PLANNER") return finish("NEEDS_PLANNER");
      if (transition.outcome === "CHANGES_REQUIRED") return finish("CHANGES_REQUIRED");
      cycle++; metadata.repairCycles = cycle;
      const handoff = JSON.stringify(workerHandoffFromReviewer(reviewData));
      implementAttempt++;
      implemented = await runStage("implement", promptFor("implement", task, artifactDir, plan, handoff, implementAttempt, "", "", json(qualityContract)), implementAttempt);
      qualityResolution = await resolveQualityMismatch(implemented, `review-${cycle}`); implemented = qualityResolution.worker;
      if (qualityResolution.outcome) return finish(signal?.aborted ? "ABORTED" : qualityResolution.outcome);
      if (!implemented.positive) return finish(signal?.aborted ? "ABORTED" : implemented.valid ? "IMPLEMENTATION_BLOCKED" : "IMPLEMENTATION_FAILED");
      const repairQualityOutcome = await qualityAfterWorker(implemented, implementAttempt); if (repairQualityOutcome) return finish(repairQualityOutcome);
      const repairGateContent = await fs.readFile(path.join(artifactDir, `quality-gate-${implementAttempt}.json`), "utf8");
      reviewed = await runStage("review", promptFor("review", task, artifactDir, plan, handoff, cycle + 1, path.join(artifactDir, `implement-${implementAttempt}.json`), implemented.text, json(qualityContract), path.join(artifactDir, `quality-gate-${implementAttempt}.json`), repairGateContent, implementAttempt), cycle + 1); review = reviewed.text;
      if (!reviewed.valid) return finish(signal?.aborted ? "ABORTED" : "REVIEW_FAILED");
    }
    const finalReview = JSON.parse(reviewed.text); const finalTransition = transitionAfterReview(finalReview, metadata.reviewIds ?? [], cycle, { maxReviewCycles: input.maxReviewCycles, maxRepairCycles: input.maxRepairCycles });
    metadata.reviewIds = finalTransition.reviewIds; metadata.reviewBudget = finalTransition.budget; metadata.repeatedIds = finalTransition.repeatedIds;
    if (signal?.aborted) return finish("ABORTED");
    const diffGate = await reviewDiff({ mode: diffReviewMode, cwd, signal, confirm: ctx.hasUI && hasReviewEventBus ? () => ctx.ui.confirm("最終差分を人間に確認してもらいますか？", "承認されるまでcleanupは実行しません。") : undefined, exec: (program, args, reviewSignal) => executeDiffProcess(program, args, cwd, reviewSignal) });
    await recordGate(artifactDir, "diff-review.json", diffGate);
    metadata.humanReview.diff = { ...diffGate, artifact: "diff-review.json", argv: ["--yes", "github:tanabe1478/diffai", "--cwd", cwd] };
    await atomicWrite(path.join(artifactDir, "run.json"), json(metadata));
    if (diffGate.decision === "aborted" || signal?.aborted) return finish("ABORTED");
    if (diffGate.decision === "changes_requested") return finish("HUMAN_CHANGES_REQUESTED");
    if (diffReviewMode === "required" && diffGate.decision !== "approved") return finish(diffGate.decision === "timeout" ? "HUMAN_DIFF_REVIEW_TIMEOUT" : `HUMAN_DIFF_REVIEW_${diffGate.decision.toUpperCase()}`);
    await assertSuccessQualityEvidence(metadata, artifactDir, qualityContract);
    const finalResult: any = await finish("SUCCESS"); let cleanupMessage = cleanupMode === "never" ? "cleanupは無効です。子ペインを保持しました。" : "cleanupは実行されませんでした。子ペインを保持しました。";
    let confirmed = false;
    try {
      if (signal?.aborted) { await markRunAborted(artifactDir, path.join(rootDir(), "artifacts")); cleanupMessage = "cleanupを中断しました。子ペインを保持しました。"; }
      else confirmed = cleanupMode === "ask" && ctx.hasUI ? await ctx.ui.confirm("パイプラインのペインを閉じますか？", "このrunに属するidle状態の子ペインだけを閉じます。") : false;
      if (signal?.aborted) { await markRunAborted(artifactDir, path.join(rootDir(), "artifacts")); cleanupMessage = "cleanupを中断しました。子ペインを保持しました。"; }
      else if (shouldCleanup("SUCCESS", cleanupMode, ctx.hasUI, confirmed)) {
        try { const cleanup = await cleanupRun(artifactDir, path.join(rootDir(), "artifacts"), parentPaneId, signal); const allClosed = cleanup.results.length > 0 && cleanup.results.every((r: any) => r.status === "closed"); cleanupMessage = allClosed ? "cleanupが完了し、子ペインを閉じました。" : `cleanupは一部だけ完了しました。閉じられなかった子ペインを保持しています。${cleanup.summary}`; finalResult.details.cleanup = cleanup; if (allClosed) { const audited = await clearLaunchersAfterCleanup(artifactDir); metadata.cleanup = audited.cleanup; metadata.launchers = []; } }
        catch (error) { const message = error instanceof Error ? error.message : String(error); await recordCleanupFailure(artifactDir, path.join(rootDir(), "artifacts"), message); cleanupMessage = `cleanupに失敗しました。閉じられていない子ペインを保持しています。${message}`; finalResult.details.cleanupError = message; }
      } else if (cleanupMode === "ask" && !ctx.hasUI) cleanupMessage = "利用可能なUIがないためcleanupを確認できません。子ペインを保持しました。後からdevelopment_pipeline_cleanupを使用してください。";
    } catch (error) { const message = error instanceof Error ? error.message : String(error); await recordCleanupFailure(artifactDir, path.join(rootDir(), "artifacts"), message); cleanupMessage = `cleanup確認に失敗しました。子ペインを保持しています。${message}`; finalResult.details.cleanupError = message; }
    if (signal?.aborted) { try { await markRunAborted(artifactDir, path.join(rootDir(), "artifacts")); } catch (error) { finalResult.details.cleanupError = error instanceof Error ? error.message : String(error); } }
    const durable = JSON.parse(await fs.readFile(path.join(artifactDir, "run.json"), "utf8"));
    finalResult.details.outcome = durable.outcome;
    finalResult.content[0].text = finalResult.content[0].text.replace("SUCCESS", durable.outcome).replace("cleanupの判断待ちです。", durable.outcome === "ABORTED" ? "cleanupを中断しました。子ペインを保持しました。" : cleanupMessage); return finalResult;
    }
  });
}
