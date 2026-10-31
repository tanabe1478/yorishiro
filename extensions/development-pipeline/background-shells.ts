import { execFile } from "node:child_process";

/**
 * Claude Code runs each Bash tool call in its own shell, started as a direct
 * child of the `claude` process, with a command line that sources a file under
 * `.claude/shell-snapshots/`. Herdr's foreground_processes does not list these
 * shells, so a child waiting on a background job looks idle to the monitor.
 */
export const SHELL_SNAPSHOT_MARKER = ".claude/shell-snapshots/";

export type ProcessRow = { pid: number; ppid: number; command: string };

/** Parse `ps -axo pid=,ppid=,command=` output. Lines that do not start with two integers are ignored. */
export function parsePsOutput(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return rows;
}

/** PIDs of processes whose exact argv[0] (or argv0) is `binary`, found anywhere in Herdr process-info. */
export function agentPidsFromProcessInfo(value: unknown, binary: string): number[] {
  const found = new Set<number>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const exact = record.argv0 === binary || (Array.isArray(record.argv) && record.argv[0] === binary);
    if (exact && typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0) found.add(record.pid);
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return [...found];
}

/** Number of Bash-tool shells that are direct children of one of `agentPids`. */
export function countBackgroundShells(agentPids: number[], rows: ProcessRow[]): number {
  if (agentPids.length === 0) return 0;
  const parents = new Set(agentPids);
  return rows.filter(row => parents.has(row.ppid) && row.command.includes(SHELL_SNAPSHOT_MARKER)).length;
}

/** Process table via `ps`, which behaves the same on macOS and Linux for these columns. Returns [] when ps is unavailable. */
export function listProcesses(signal?: AbortSignal): Promise<ProcessRow[]> {
  return new Promise(resolve => {
    try {
      execFile("ps", ["-axwwo", "pid=,ppid=,command="], { maxBuffer: 32 * 1024 * 1024, signal }, (error, stdout) => resolve(error ? [] : parsePsOutput(String(stdout))));
    } catch { resolve([]); }
  });
}

/** Shells still running under the pane's agent process. 0 when the agent PID is unknown or ps fails. */
export async function detectBackgroundShells(processInfo: unknown, binary: string, list: () => Promise<ProcessRow[]> = listProcesses): Promise<number> {
  const pids = agentPidsFromProcessInfo(processInfo, binary);
  if (pids.length === 0) return 0;
  return countBackgroundShells(pids, await list());
}
