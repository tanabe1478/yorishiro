import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * A Claude Code child can only read its working directories (target checkout, artifact dir, workflow skill).
 * A task or plan that names an absolute file outside them, such as a spec in the user's home, makes the child
 * stop at a denied Read. Before the run starts, copy such files into `<artifact>/inputs/` and tell the child
 * where the copy is. The task and plan text are not rewritten.
 */
export const INPUT_FILE_LIMIT_BYTES = 2 * 1024 * 1024;
export const INPUT_TOTAL_LIMIT_BYTES = 10 * 1024 * 1024;
export const INPUT_CANDIDATE_LIMIT = 100;

export type InputFileCopy = { original: string; copy: string; bytes: number };
export type InputFileSkip = { original: string; reason: string };
export type InputFilesReport = { dir: string; copied: InputFileCopy[]; skipped: InputFileSkip[] };

// A path starts at "/" or "~/" and is not the tail of a longer token (so "src/a", "https://host/x" and "a/b" do not match).
const PATH_PATTERN = /(?<![\w./~:\-])(?:~\/|\/)[^\s"'`<>()\[\]{}|*?;,、。，．：；！？（）「」『』【】]+/gu;
const TRAILING = /[.:!]+$/u;

export function extractAbsolutePaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PATH_PATTERN)) {
    const cleaned = match[0].replace(TRAILING, "");
    if (cleaned.length > 1 && cleaned !== "~/" && cleaned !== "/") found.add(cleaned);
  }
  return [...found];
}

function expandHome(value: string, home: string) {
  return value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
}

function isInside(base: string, candidate: string) {
  const relative = path.relative(base, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Path segments or file names that usually hold credentials. Matched against the given path and its resolved target.
const SECRET_SEGMENTS = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config/gcloud"]);
const SECRET_NAME = /(^\.env($|\.))|(\.(pem|key|p12|pfx|keystore|jks)$)|key|secret|token|credential|passwd|password|^\.netrc$|^\.npmrc$|^id_(rsa|dsa|ecdsa|ed25519)/i;
export function looksSecret(file: string): boolean {
  const normalized = file.split(path.sep).join("/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some(segment => SECRET_SEGMENTS.has(segment))) return true;
  if (normalized.includes("/.config/gcloud/")) return true;
  return SECRET_NAME.test(segments.at(-1) ?? "");
}

// System locations: not user input, and copying them into an artifact has no purpose.
const SYSTEM_PREFIXES = ["/usr", "/bin", "/sbin", "/etc", "/System", "/Library", "/dev", "/proc", "/sys", "/private/etc", "/opt", "/Applications"];
function isSystemPath(file: string) {
  return SYSTEM_PREFIXES.some(prefix => file === prefix || file.startsWith(`${prefix}/`));
}

function safeName(file: string) {
  const base = path.basename(file).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return (base || "file").slice(0, 80);
}

export async function stageInputFiles(options: { texts: string[]; cwd: string; artifactDir: string; readableDirs: string[]; home?: string }): Promise<InputFilesReport> {
  const home = options.home ?? os.homedir();
  const dir = path.join(options.artifactDir, "inputs");
  const report: InputFilesReport = { dir, copied: [], skipped: [] };
  const readable: string[] = [];
  for (const base of [options.cwd, options.artifactDir, ...options.readableDirs]) {
    readable.push(path.resolve(base));
    try { readable.push(await fs.realpath(base)); } catch { /* a missing dir cannot make a file readable */ }
  }
  const candidates = [...new Set(options.texts.flatMap(extractAbsolutePaths))].slice(0, INPUT_CANDIDATE_LIMIT);
  const copiedByReal = new Map<string, InputFileCopy>();
  let total = 0;
  for (const original of candidates) {
    const expanded = expandHome(original, home);
    let real: string;
    try { real = await fs.realpath(expanded); } catch { continue; } // does not exist: not an input file
    let stat;
    try { stat = await fs.stat(real); } catch { continue; }
    if (readable.some(base => isInside(base, real))) continue; // the child can already read it
    if (!stat.isFile()) { report.skipped.push({ original, reason: stat.isDirectory() ? "ディレクトリのためコピーしません" : "通常ファイルではない（デバイス等）ためコピーしません" }); continue; }
    if (isSystemPath(real) || isSystemPath(expanded)) { report.skipped.push({ original, reason: "システムのパスのためコピーしません" }); continue; }
    if (looksSecret(expanded) || looksSecret(real)) { report.skipped.push({ original, reason: "秘密情報の可能性があるパスのためコピーしません" }); continue; }
    if (stat.size > INPUT_FILE_LIMIT_BYTES) { report.skipped.push({ original, reason: `1ファイルの上限${INPUT_FILE_LIMIT_BYTES}バイトを超える（${stat.size}バイト）ためコピーしません` }); continue; }
    const earlier = copiedByReal.get(real);
    if (earlier) { report.copied.push({ original, copy: earlier.copy, bytes: earlier.bytes }); continue; } // another spelling of an already copied file
    if (total + stat.size > INPUT_TOTAL_LIMIT_BYTES) { report.skipped.push({ original, reason: `合計の上限${INPUT_TOTAL_LIMIT_BYTES}バイトを超えるためコピーしません` }); continue; }
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const copy = path.join(dir, `${copiedByReal.size + 1}-${safeName(real)}`);
      await fs.copyFile(real, copy);
      await fs.chmod(copy, 0o600);
      total += stat.size;
      const item = { original, copy, bytes: stat.size };
      copiedByReal.set(real, item);
      report.copied.push(item);
    } catch (error) {
      report.skipped.push({ original, reason: `コピーに失敗しました: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return report;
}

/** Brief section. Empty when there is nothing to say. */
export function renderInputFilesSection(report: InputFilesReport | undefined): string {
  if (!report || (report.copied.length === 0 && report.skipped.length === 0)) return "";
  const lines = ["## 外部入力ファイル", ""];
  if (report.copied.length) {
    lines.push("計画・依頼に書かれた次のファイルは、あなたが読める範囲の外にあるため、orchestratorがコピーしました。元のpathではなくコピー先をReadで読むこと。計画本文のpathは書き換えていません。", "", "| 元パス | コピー先 |", "|---|---|");
    for (const item of report.copied) lines.push(`| ${item.original} | ${item.copy} |`);
    lines.push("");
  }
  if (report.skipped.length) {
    lines.push("次のファイルはコピーしていません。読めない場合はBLOCKEDで報告し、Plannerへ戻ること。", "", "| 元パス | 理由 |", "|---|---|");
    for (const item of report.skipped) lines.push(`| ${item.original} | ${item.reason} |`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
