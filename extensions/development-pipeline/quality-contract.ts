import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { isRepositoryRelativePath, isWithinRepositories, repositoryDir, workspacePath } from "./repositories.ts";

export { isRepositoryRelativePath };
/** Upper bound of one check's timeoutMs (a JVM build takes minutes). verifier-tools.ts, index.ts and claude-mcp.mjs use the same number. */
export const MAX_CHECK_TIMEOUT_MS = 1_800_000;
export type QualityPlanItem = { id: string; description: string };
/** `cwd` is workspace-relative and only valid when the run has `repositories` (it must be one of them or inside one). */
export type RequiredCheck = { id: string; program: string; args: string[]; timeoutMs?: number; cwd?: string };
export type QualityContract = { planItems: QualityPlanItem[]; requiredChecks: RequiredCheck[]; allowedPathPrefixes?: string[] };
export type Validation = { valid: true; value: QualityContract } | { valid: false; error: string };
export type FingerprintMap = Record<string, string>;

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key)) && actual.every(key => typeof key === "string" && keys.includes(key));
};
/** All `required` keys present, and no key beyond `required` and `optional`. */
const hasKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[]) => {
  const actual = Reflect.ownKeys(value);
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key)) && actual.every(key => typeof key === "string" && (required.includes(key) || optional.includes(key)));
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

function prefix(value: unknown): value is string {
  if (!text(value)) return false;
  const normalized = value.replace(/\/+$/, "");
  return normalized.length > 0 && isRepositoryRelativePath(normalized);
}

export function validateQualityContract(value: unknown, options: { repositories?: readonly string[] } = {}): Validation {
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
    if (!plain(item) || !hasKeys(item, ["id", "program", "args"], ["timeoutMs", "cwd"])) return { valid: false, error: "requiredChecks must contain exact id, program, and args fields" };
    if (!id(item.id) || !text(item.program) || !Array.isArray(item.args) || !item.args.every(arg => typeof arg === "string")) return { valid: false, error: "requiredChecks has an invalid id, program, or args" };
    if (Object.prototype.hasOwnProperty.call(item, "timeoutMs") && (!Number.isInteger(item.timeoutMs) || (item.timeoutMs as number) < 1 || (item.timeoutMs as number) > MAX_CHECK_TIMEOUT_MS)) return { valid: false, error: `requiredChecks timeoutMs must be an integer from 1 to ${MAX_CHECK_TIMEOUT_MS}` };
    if (Object.prototype.hasOwnProperty.call(item, "cwd")) {
      if (!options.repositories) return { valid: false, error: `requiredChecks cwd is only allowed when the run has repositories (check ${String(item.id)})` };
      if (!isWithinRepositories(item.cwd, options.repositories)) return { valid: false, error: `requiredChecks cwd must be a workspace-relative path that is one of repositories or inside one (check ${String(item.id)})` };
    }
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
    requiredChecks: value.requiredChecks.map(item => ({ id: item.id, program: item.program, args: [...item.args], ...(Object.prototype.hasOwnProperty.call(item, "timeoutMs") ? { timeoutMs: item.timeoutMs } : {}), ...(Object.prototype.hasOwnProperty.call(item, "cwd") ? { cwd: item.cwd } : {}) })),
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
/**
 * Fingerprint of the whole workspace. Without `repositories` it is the cwd's own repository (unchanged).
 * With them, each repository is fingerprinted at its root and every path gets its repository as a prefix,
 * so the maps of repositories that share file names do not mix.
 */
export async function captureWorkspaceFingerprintMap(cwd: string, repositories?: readonly string[]): Promise<FingerprintMap> {
  if (!repositories) return captureFingerprintMap(cwd);
  const result: FingerprintMap = {};
  for (const repository of repositories) {
    const map = await captureFingerprintMap(repositoryDir(cwd, repository));
    for (const [file, hash] of Object.entries(map)) result[workspacePath(repository, file)] = hash;
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
/**
 * allowedPathPrefixes は「パス区切り単位」で照合する（'tsconfig' は tsconfig.json に一致しない）。
 * 違反pathが prefix 文字列で前方一致している場合だけ、書き損じとみなして提案を返す。
 */
export function prefixHints(outside: string[], prefixes: string[] | undefined): string[] {
  if (prefixes === undefined) return [];
  const normalized = prefixes.map(item => item.replace(/\/+$/, ""));
  const hints: string[] = [];
  for (const file of outside) {
    const near = normalized.find(item => file !== item && file.startsWith(item) && !file.startsWith(`${item}/`));
    if (near !== undefined) hints.push(`prefixはパス区切り単位で照合します。${file} を許可するなら '${file}' を明示してください（現在の '${near}' は ${file} に一致しません）`);
  }
  return hints;
}
export const MISMATCH_PATH_LIMIT = 50;
function limited(paths: string[]) { return paths.filter(isRepositoryRelativePath).slice(0, MISMATCH_PATH_LIMIT); }
/** Worker へ返す修正findingと結果messageへ載せる違反pathの要約。リポジトリ相対pathだけを、各50件まで含める。 */
export function summarizeMismatchPaths(input: { outside: string[]; missingPaths: string[]; unknownPaths: string[]; prefixHints: string[] }) {
  const omitted: Record<string, number> = {};
  const take = (name: string, paths: string[]) => { const kept = limited(paths); if (paths.length > kept.length) omitted[name] = paths.length - kept.length; return kept; };
  return {
    outsidePaths: take("outsidePaths", input.outside),
    missingPaths: take("missingPaths", input.missingPaths),
    unknownPaths: take("unknownPaths", input.unknownPaths),
    prefixHints: input.prefixHints.slice(0, MISMATCH_PATH_LIMIT),
    ...(Object.keys(omitted).length ? { omitted } : {}),
  };
}
export function describeMismatchPaths(summary: ReturnType<typeof summarizeMismatchPaths>): string {
  const lines: string[] = [];
  if (summary.outsidePaths.length) lines.push(`prefix違反のpath: ${summary.outsidePaths.join(", ")}`);
  if (summary.missingPaths.length) lines.push(`changedPathsに無い実diffのpath: ${summary.missingPaths.join(", ")}`);
  if (summary.unknownPaths.length) lines.push(`実diffに無いchangedPaths: ${summary.unknownPaths.join(", ")}`);
  for (const hint of summary.prefixHints) lines.push(`提案: ${hint}`);
  return lines.join("\n");
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
  const hints = prefixHints(outside, contract.allowedPathPrefixes);
  if (outside.length) { violations.push({ type: "prefix", contractId: "allowedPathPrefixes" }); errors.push(`許可されていない変更pathがあります（${outside.join(",")}）`); for (const hint of hints) errors.push(hint); }
  return { valid: violations.length === 0, errors, outside, missingPaths, unknownPaths, prefixHints: hints, violations, signature: evidenceViolationSignature(violations) };
}
