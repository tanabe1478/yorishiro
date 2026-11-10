import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import * as path from "node:path";

/**
 * Multi-repository runs. `repositories` lists git work tree roots as paths relative to the run's cwd (the
 * workspace root). Everything the pipeline records about them (changed paths, allowedPathPrefixes, check
 * cwd) is workspace-relative, so `neuhaus-backend/src/a.ts` names one file unambiguously. Without
 * `repositories` none of this is used and the cwd is the single repository, as before.
 */

export function isRepositoryRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\")) return false;
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("//")) return false;
  const parts = value.split("/");
  return parts.every(part => part.length > 0 && part !== "." && part !== "..");
}

export type RepositoryList = { valid: true; value: string[] } | { valid: false; error: string };

/** Shape check only (no file system): a nonempty array of unique, non-nested, workspace-relative paths. */
export function parseRepositories(value: unknown): RepositoryList {
  if (!Array.isArray(value) || value.length === 0) return { valid: false, error: "repositories must be a nonempty array of workspace-relative paths" };
  for (const item of value) if (!isRepositoryRelativePath(item)) return { valid: false, error: `repositories must contain only relative paths without '..', '.', or absolute prefixes (got ${JSON.stringify(item)})` };
  const list = value as string[];
  if (new Set(list).size !== list.length) return { valid: false, error: "repositories must not contain duplicates" };
  for (const outer of list) for (const inner of list) if (outer !== inner && inner.startsWith(`${outer}/`)) return { valid: false, error: `repositories must not be nested (${inner} is inside ${outer})` };
  return { valid: true, value: list };
}

/** A workspace-relative directory that is one of the repositories or inside one. */
export function isWithinRepositories(candidate: unknown, repositories: readonly string[] | undefined): candidate is string {
  if (!repositories || !isRepositoryRelativePath(candidate)) return false;
  return repositories.some(repository => candidate === repository || candidate.startsWith(`${repository}/`));
}

export function repositoryDir(cwd: string, repository: string) { return path.join(cwd, ...repository.split("/")); }

/** Prefix a repository-relative path with its repository: the workspace-relative form. */
export function workspacePath(repository: string, file: string) { return `${repository}/${file}`; }

/** File-name-safe form of a repository path; the digest keeps `a/b` and `a_b` apart. */
export function repositoryArtifactName(repository: string) {
  const slug = repository.replaceAll("/", "__").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48);
  return `${slug}-${createHash("sha256").update(repository, "utf8").digest("hex").slice(0, 8)}`;
}

function gitToplevel(cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn("git", ["rev-parse", "--show-toplevel"], { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.once("error", error => resolve({ code: 1, stdout, stderr: error.message }));
    child.once("close", code => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

/** Each repository must be a real directory under cwd (no symlink on the way) that is the root of a git work tree. */
export async function assertGitRoots(cwd: string, repositories: readonly string[]): Promise<void> {
  const workspace = await realpath(cwd);
  for (const repository of repositories) {
    const dir = repositoryDir(cwd, repository);
    let info: Awaited<ReturnType<typeof stat>>;
    try { info = await stat(dir); } catch { throw new Error(`Invalid repositories: ${repository} does not exist under ${cwd}`); }
    if (!info.isDirectory()) throw new Error(`Invalid repositories: ${repository} is not a directory`);
    const real = await realpath(dir);
    if (real !== repositoryDir(workspace, repository)) throw new Error(`Invalid repositories: ${repository} must not go through a symbolic link`);
    const top = await gitToplevel(dir);
    if (top.code !== 0 || top.stdout === "") throw new Error(`Invalid repositories: ${repository} is not inside a git work tree${top.stderr ? ` (${top.stderr})` : ""}`);
    if (await realpath(top.stdout).catch(() => top.stdout) !== real) throw new Error(`Invalid repositories: ${repository} is not the root of a git work tree (the root is ${top.stdout})`);
  }
}
