import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import * as path from "node:path";

export type QualityPlanItem = { id: string; description: string };
export type RequiredCheck = { id: string; program: string; args: string[]; timeoutMs?: number };
export type QualityContract = { planItems: QualityPlanItem[]; requiredChecks: RequiredCheck[]; allowedPathPrefixes?: string[] };
export type Validation = { valid: true; value: QualityContract } | { valid: false; error: string };
export type FingerprintMap = Record<string, string>;

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key)) && actual.every(key => typeof key === "string" && keys.includes(key));
};
const id = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const unique = (items: unknown[], get: (item: unknown) => unknown) => {
  const ids = new Set<string>();
  for (const item of items) {
    const value = get(item);
    if (!id(value) || ids.has(value)) return false;
    ids.add(value);
  }
  return true;
};

export function isRepositoryRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\")) return false;
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("//")) return false;
  const parts = value.split("/");
  return parts.every(part => part.length > 0 && part !== "." && part !== "..");
}

function prefix(value: unknown): value is string {
  if (!text(value)) return false;
  const normalized = value.replace(/\/+$/, "");
  return normalized.length > 0 && isRepositoryRelativePath(normalized);
}

export function validateQualityContract(value: unknown): Validation {
  if (!plain(value) || !exact(value, ["planItems", "requiredChecks", "allowedPathPrefixes"])) {
    // allowedPathPrefixes is optional, so validate the exact required shape separately.
    if (!plain(value) || !exact(value, ["planItems", "requiredChecks"])) return { valid: false, error: "qualityContract must contain exact planItems and requiredChecks fields" };
  }
  const c = value as Record<string, unknown>;
  const planItems = c.planItems, requiredChecks = c.requiredChecks;
  if (!Array.isArray(planItems) || planItems.length === 0 || !unique(planItems, item => plain(item) ? item.id : undefined)) return { valid: false, error: "planItems must be a nonempty array with unique canonical IDs" };
  for (const item of planItems) {
    if (!plain(item) || !exact(item, ["id", "description"]) || !id(item.id) || !text(item.description)) return { valid: false, error: "planItems must contain exact id and nonempty description" };
  }
  if (!Array.isArray(requiredChecks) || requiredChecks.length === 0 || !unique(requiredChecks, item => plain(item) ? item.id : undefined)) return { valid: false, error: "requiredChecks must be a nonempty array with unique canonical IDs" };
  for (const item of requiredChecks) {
    if (!plain(item) || !exact(item, ["id", "program", "args", "timeoutMs"])) {
      if (!plain(item) || !exact(item, ["id", "program", "args"])) return { valid: false, error: "requiredChecks must contain exact id, program, and args fields" };
    }
    if (!id(item.id) || !text(item.program) || !Array.isArray(item.args) || !item.args.every(arg => typeof arg === "string")) return { valid: false, error: "requiredChecks has an invalid id, program, or args" };
    if (Object.prototype.hasOwnProperty.call(item, "timeoutMs") && (!Number.isInteger(item.timeoutMs) || (item.timeoutMs as number) < 1 || (item.timeoutMs as number) > 300000)) return { valid: false, error: "requiredChecks timeoutMs must be an integer from 1 to 300000" };
  }
  if (Object.prototype.hasOwnProperty.call(c, "allowedPathPrefixes")) {
    if (!Array.isArray(c.allowedPathPrefixes) || !c.allowedPathPrefixes.every(prefix)) return { valid: false, error: "allowedPathPrefixes must be a string array of repository-relative prefixes" };
    const prefixes = c.allowedPathPrefixes as string[];
    if (new Set(prefixes.map(x => x.replace(/\/+$/, ""))).size !== prefixes.length) return { valid: false, error: "allowedPathPrefixes must be unique" };
  }
  return { valid: true, value: c as unknown as QualityContract };
}

function canonical(value: QualityContract): string {
  const normalized = {
    planItems: value.planItems.map(item => ({ id: item.id, description: item.description })),
    requiredChecks: value.requiredChecks.map(item => Object.prototype.hasOwnProperty.call(item, "timeoutMs") ? { id: item.id, program: item.program, args: [...item.args], timeoutMs: item.timeoutMs } : { id: item.id, program: item.program, args: [...item.args] }),
    ...(value.allowedPathPrefixes === undefined ? {} : { allowedPathPrefixes: value.allowedPathPrefixes.map(x => x.replace(/\/+$/, "")) }),
  };
  return JSON.stringify(normalized);
}
export function canonicalQualityContract(value: QualityContract): string { return canonical(value); }
export function hashQualityContract(value: QualityContract): string { return createHash("sha256").update(canonical(value), "utf8").digest("hex"); }
export function qualityContractArtifact(value: QualityContract) { return { ...value, contract: value, sha256: hashQualityContract(value) }; }

function git(programArgs: string[], cwd: string): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn("git", programArgs, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: string[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(chunk.toString()));
    child.once("error", error => resolve({ code: 1, stdout: Buffer.concat(stdout), stderr: error.message }));
    child.once("close", code => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: stderr.join("") }));
  });
}
function digest(value: Uint8Array | string) { return createHash("sha256").update(value).digest("hex"); }
function parseStatus(raw: Buffer): Map<string, string> {
  const tokens = raw.toString("utf8").split("\0");
  const result = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const status = token.slice(0, 2), first = token.slice(3);
    if (!status || first.length === 0) continue;
    result.set(first, status);
    if ((status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C") && tokens[i + 1]) result.set(tokens[++i], status);
  }
  return result;
}
async function fileState(file: string) {
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) return { kind: "symlink", linkTarget: await readlink(file, "utf8").catch(() => ""), contentHash: undefined, deleted: false };
    if (stat.isFile()) return { kind: "file", linkTarget: undefined, contentHash: digest(await readFile(file)), deleted: false };
    return { kind: "other", linkTarget: undefined, contentHash: undefined, deleted: false };
  } catch { return { kind: "deleted", linkTarget: undefined, contentHash: undefined, deleted: true }; }
}
async function diffHash(cwd: string, staged: boolean, file: string) {
  const args = ["diff", "--no-ext-diff", "--binary", ...(staged ? ["--cached"] : []), "--", file];
  const result = await git(args, cwd);
  if (result.code) throw new Error(`git diff failed for ${file}: ${result.stderr}`);
  return digest(result.stdout);
}
export async function captureFingerprintMap(cwd: string): Promise<FingerprintMap> {
  const status = await git(["status", "--short", "--porcelain=v1", "-z", "--untracked-files=all"], cwd);
  if (status.code) throw new Error(`git status failed: ${status.stderr}`);
  const paths = parseStatus(status.stdout);
  const result: FingerprintMap = {};
  for (const [file, state] of [...paths.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const current = await fileState(path.join(cwd, file));
    const unstagedDiffHash = await diffHash(cwd, false, file);
    const stagedDiffHash = await diffHash(cwd, true, file);
    result[file] = digest(JSON.stringify({ path: file, status: state, ...current, unstagedDiffHash, stagedDiffHash }));
  }
  return result;
}
export function changedPathsBetween(before: FingerprintMap, after: FingerprintMap): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)].filter(file => before[file] !== after[file]))].sort();
}
export const captureGitFingerprint = captureFingerprintMap;
export const diffFingerprintMaps = changedPathsBetween;
export function pathsWithinPrefixes(paths: string[], prefixes: string[] | undefined): string[] {
  if (prefixes === undefined) return [];
  const normalized = prefixes.map(item => item.replace(/\/+$/, ""));
  return paths.filter(file => !normalized.some(item => file === item || file.startsWith(`${item}/`)));
}
export type EvidenceViolation = { type: "missing-item" | "unknown-item" | "path-mismatch-missing" | "path-mismatch-unknown" | "prefix"; contractId: string };
export function assertSuccessQualityState(metadata: any, contract: QualityContract, artifactNames: string[]) {
  const validations = Array.isArray(metadata?.workerValidations) ? metadata.workerValidations : [];
  const completed = validations.filter((item: any) => item?.accepted === true && item?.verdict === "COMPLETED").at(-1);
  if (!completed) throw new Error("SUCCESS requires an accepted COMPLETED worker validation event");
  const gates = Array.isArray(metadata?.qualityGates) ? metadata.qualityGates : [];
  const gate = gates.filter((item: any) => item?.gate === completed.attempt).at(-1);
  if (!gate || gate.status !== "passed" || typeof gate.artifact !== "string") throw new Error("SUCCESS requires a passed quality gate event for the completed Worker attempt");
  const expectedIds = contract.requiredChecks.map(item => item.id).sort();
  const actualIds = Array.isArray(gate.checks) ? gate.checks.map((item: any) => item?.id).sort() : [];
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds) || gate.checks.some((item: any) => item.exitCode !== 0 || item.timeout || item.cancelled)) throw new Error("SUCCESS quality gate checks do not match the contract");
  if (!artifactNames.includes(gate.artifact)) throw new Error("SUCCESS quality gate artifact observation is missing");
  return gate;
}
export function evidenceViolationSignature(violations: EvidenceViolation[]): string {
  return [...new Set(violations.map(item => `${item.type}:${item.contractId}`))].sort().join("|");
}
export function compareWorkerEvidence(report: { verdict?: "COMPLETED" | "BLOCKED"; completedPlanItems: { id: string; evidence: string }[]; changedPaths: string[] }, contract: QualityContract, actualPaths: string[]) {
  const expectedPlan = contract.planItems.map(item => item.id).sort();
  const expectedSet = new Set(expectedPlan);
  const reportedPlan = report.completedPlanItems.map(item => item.id).sort();
  const reportedSet = new Set(reportedPlan);
  const reportedPaths = [...report.changedPaths].sort();
  const actualSorted = [...actualPaths].sort();
  const actualSet = new Set(actualSorted), reportedPathSet = new Set(reportedPaths);
  const outside = pathsWithinPrefixes(actualSorted, contract.allowedPathPrefixes);
  const violations: EvidenceViolation[] = [];
  const errors: string[] = [];
  const missing = expectedPlan.filter(item => !reportedSet.has(item));
  const unknown = reportedPlan.filter(item => !expectedSet.has(item));
  if (report.verdict !== "BLOCKED") for (const item of missing) violations.push({ type: "missing-item", contractId: item });
  for (const item of unknown) violations.push({ type: "unknown-item", contractId: item });
  if ((report.verdict !== "BLOCKED" && missing.length) || unknown.length) errors.push(`completedPlanItemsが${report.verdict === "BLOCKED" ? "契約IDのsubset" : "契約"}と一致しません（契約=${expectedPlan.join(",")}、報告=${reportedPlan.join(",")}）`);
  const missingPaths = actualSorted.filter(item => !reportedPathSet.has(item));
  const unknownPaths = reportedPaths.filter(item => !actualSet.has(item));
  if (missingPaths.length) violations.push({ type: "path-mismatch-missing", contractId: "changedPaths" });
  if (unknownPaths.length) violations.push({ type: "path-mismatch-unknown", contractId: "changedPaths" });
  if (missingPaths.length || unknownPaths.length) errors.push(`changedPathsが実diffと一致しません（実際=${actualSorted.join(",")}、報告=${reportedPaths.join(",")}）`);
  if (outside.length) { violations.push({ type: "prefix", contractId: "allowedPathPrefixes" }); errors.push(`許可されていない変更pathがあります（${outside.join(",")}）`); }
  return { valid: violations.length === 0, errors, outside, violations, signature: evidenceViolationSignature(violations) };
}
