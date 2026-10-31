import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Claude Code asks "Is this a project you created or one you trust?" the first time it starts in a directory,
 * even with --setting-sources project and --permission-mode dontAsk. Herdr then reports the pane as `blocked`
 * until a human answers (observed with claude 2.1.316: the dialog appears in an untrusted directory and does
 * not appear in a subdirectory of a trusted one).
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

export async function checkWorkspaceTrust(cwd: string, options: { stateFile?: string } = {}): Promise<WorkspaceTrust> {
  const file = options.stateFile ?? claudeStateFile();
  let state: any;
  try { state = JSON.parse(await fs.readFile(file, "utf8")); } catch { return { status: "unknown" }; }
  const projects = state?.projects;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) return { status: "unknown" };
  const starts = new Set<string>([path.resolve(cwd)]);
  try { starts.add(await fs.realpath(cwd)); } catch { /* cwd validity is checked elsewhere */ }
  for (const start of starts) {
    for (let dir = start; ; dir = path.dirname(dir)) {
      if (projects[dir]?.hasTrustDialogAccepted === true) return { status: "trusted", source: file, checkedDir: dir };
      if (path.dirname(dir) === dir) break;
    }
  }
  return { status: "untrusted", source: file };
}

export function workspaceTrustWarning(cwd: string) {
  return `[yorishiro] 警告: ${cwd} はClaude Codeで未信頼です。Workerペインにワークスペース信頼のダイアログが出て、応答するまで進みません（Herdr status: blocked）。ペインのダイアログに応答してください。信頼は自動では付与しません。`;
}
