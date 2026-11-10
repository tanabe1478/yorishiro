import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Claude Code asks "Is this a project you created or one you trust?" the first time it starts in a directory,
 * even with --setting-sources project and --permission-mode dontAsk. Herdr then reports the pane as `blocked`
 * until a human answers. Observed with claude 2.1.316 (launcher flags, one throwaway pane per case):
 *   - a new non-git directory under a trusted non-git directory: no dialog (trust is inherited from parents);
 *   - a new subdirectory of a trusted git repository: no dialog (the git root is what counts);
 *   - a new, independent git repository under a trusted git repository: dialog (a nested repo does not inherit
 *     the outer repo's trust, because its own git root is the unit of trust).
 *
 * The accepted answer is stored in Claude Code's global state file as
 * `projects[<dir>].hasTrustDialogAccepted`. That file is not a documented interface, so anything unreadable
 * or unexpected is reported as "unknown" and never as "untrusted". This only reads; it never grants trust.
 */
export type WorkspaceTrust = { status: "trusted" | "untrusted" | "unknown"; source?: string; checkedDir?: string };

export function claudeStateFile(env: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return dir ? path.join(dir, ".claude.json") : path.join(home, ".claude.json");
}

/**
 * `gitCeiling` works like GIT_CEILING_DIRECTORIES: the search for a git root never moves up into that directory
 * (it is only examined when cwd is the ceiling itself). Production leaves it unset; tests use it so that a
 * temporary directory inside some other git checkout is not mistaken for part of that checkout.
 */
export async function checkWorkspaceTrust(cwd: string, options: { stateFile?: string; gitCeiling?: string } = {}): Promise<WorkspaceTrust> {
  const file = options.stateFile ?? claudeStateFile();
  let state: any;
  try { state = JSON.parse(await fs.readFile(file, "utf8")); } catch { return { status: "unknown" }; }
  const projects = state?.projects;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) return { status: "unknown" };
  const starts = new Set<string>([path.resolve(cwd)]);
  try { starts.add(await fs.realpath(cwd)); } catch { /* cwd validity is checked elsewhere */ }
  const ceilings = new Set<string>();
  if (options.gitCeiling) {
    ceilings.add(path.resolve(options.gitCeiling));
    try { ceilings.add(await fs.realpath(options.gitCeiling)); } catch { /* an unreadable ceiling just matches by its resolved path */ }
  }
  for (const start of starts) {
    let root: string | null;
    try { root = await findGitRoot(start, ceilings); } catch { return { status: "unknown" }; }
    if (root) {
      // Inside a git repository only the git root's entry counts; outer directories are not consulted.
      if (projects[root]?.hasTrustDialogAccepted === true) return { status: "trusted", source: file, checkedDir: root };
      continue;
    }
    for (let dir = start; ; dir = path.dirname(dir)) {
      if (projects[dir]?.hasTrustDialogAccepted === true) return { status: "trusted", source: file, checkedDir: dir };
      if (path.dirname(dir) === dir) break;
    }
  }
  return { status: "untrusted", source: file };
}

/** Multi-repository run: each repository is checked on its own (the unit of trust is a git root). */
export async function checkRepositoriesTrust(cwd: string, repositories: readonly string[], options: { stateFile?: string; gitCeiling?: string } = {}): Promise<Array<WorkspaceTrust & { repository: string }>> {
  const results: Array<WorkspaceTrust & { repository: string }> = [];
  for (const repository of repositories) results.push({ repository, ...await checkWorkspaceTrust(path.join(cwd, ...repository.split("/")), options) });
  return results;
}

/** Nearest ancestor (or self) holding a `.git` entry (a directory, or a file for worktrees and submodules), not searching up into a ceiling. null when there is none. Throws when it cannot be determined. */
async function findGitRoot(start: string, ceilings: ReadonlySet<string>): Promise<string | null> {
  for (let dir = start; ; dir = path.dirname(dir)) {
    try { await fs.stat(path.join(dir, ".git")); return dir; } catch (error: any) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    }
    const parent = path.dirname(dir);
    if (parent === dir || ceilings.has(parent)) return null;
  }
}

export function workspaceTrustWarning(cwd: string) {
  return `[yorishiro] 警告: ${cwd} はClaude Codeで未信頼です。Workerペインにワークスペース信頼のダイアログが出て、応答するまで進みません（Herdr status: blocked）。ペインのダイアログに応答してください。信頼は自動では付与しません。`;
}
