import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export type Format = "pi" | "claude";
export type Category = "read" | "edit" | "exec" | "search" | "agent" | "other";
export type Usage = { context: number; output: number; freshInput: number; cacheRead: number; cacheWrite: number; thinking: number; cost?: number; /** Per-bucket dollars when the log provides them (pi does); lets cache-miss cost be computed the way pi does. */ costInput?: number; costCacheRead?: number; costCacheWrite?: number; /** Prompt-cache lifetime the provider reported for this call (Claude Code logs ephemeral_1h vs ephemeral_5m buckets). */ cacheTtlMs?: number };
export type Event =
  | { kind: "session"; ts: number; cwd?: string; id?: string }
  | { kind: "user"; ts: number; text: string }
  | { kind: "assistant"; ts: number; text: string; usage?: Usage; stop?: string }
  | { kind: "tool_call"; ts: number; id: string; tool: string; category: Category; target: string; sidechain?: boolean }
  | { kind: "tool_result"; ts: number; id: string; tool?: string; isError: boolean; text: string; sidechain?: boolean }
  | { kind: "compaction"; ts: number }
  | { kind: "model"; ts: number; model: string }
  | { kind: "thinking_level"; ts: number; level: string }
  /** A slash command typed by the user (Claude Code records it as a user message). Not a real prompt. */
  | { kind: "command"; ts: number; name: string };

const PI_CATEGORY: Record<string, Category> = { read: "read", edit: "edit", write: "edit", bash: "exec", grep: "search", find: "search", ls: "search" };
const CLAUDE_CATEGORY: Record<string, Category> = { Read: "read", Edit: "edit", Write: "edit", NotebookEdit: "edit", Bash: "exec", Grep: "search", Glob: "search", Agent: "agent", Task: "agent" };
const RESULT_LIMIT = 2000;

export function detectFormat(firstLine: string): Format | undefined {
  try {
    const record = JSON.parse(firstLine);
    if (record?.type === "session" && typeof record.version === "number") return "pi";
    if (typeof record?.sessionId === "string" || typeof record?.uuid === "string" || "parentUuid" in record) return "claude";
  } catch {}
  return undefined;
}

function toMs(value: unknown, fallback = 0) {
  if (typeof value === "number") return value;
  if (typeof value === "string") { const ms = Date.parse(value); if (!Number.isNaN(ms)) return ms; }
  return fallback;
}
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n");
}
function clip(text: string, limit = RESULT_LIMIT) { return text.length > limit ? text.slice(0, limit) : text; }
function targetOf(category: Category, tool: string, args: any): string {
  if (!args || typeof args !== "object") return "";
  const candidates = category === "exec" ? ["command"] : category === "search" ? ["pattern", "path", "query"] : category === "agent" ? ["description", "prompt"] : ["path", "file_path", "notebook_path", "pattern", "command"];
  for (const key of candidates) if (typeof args[key] === "string" && args[key]) return args[key];
  return tool;
}

export function parsePiRecord(record: any): Event[] {
  const ts = toMs(record?.timestamp);
  if (record?.type === "session") return [{ kind: "session", ts, cwd: record.cwd, id: record.id }];
  if (record?.type === "compaction") return [{ kind: "compaction", ts }];
  if (record?.type === "model_change") return [{ kind: "model", ts, model: [record.provider, record.modelId].filter(Boolean).join("/") }];
  if (record?.type === "thinking_level_change") return [{ kind: "thinking_level", ts, level: String(record.thinkingLevel ?? "") }];
  if (record?.type !== "message" || !record.message) return [];
  const message = record.message;
  if (message.role === "user") return [{ kind: "user", ts, text: textOf(message.content) }];
  if (message.role === "toolResult") return [{ kind: "tool_result", ts, id: String(message.toolCallId ?? ""), tool: message.toolName, isError: Boolean(message.isError), text: clip(textOf(message.content)) }];
  if (message.role !== "assistant") return [];
  const events: Event[] = [];
  const u = message.usage;
  const usage: Usage | undefined = u ? { context: Number(u.input ?? 0) + Number(u.cacheRead ?? 0) + Number(u.cacheWrite ?? 0), output: Number(u.output ?? 0), freshInput: Number(u.input ?? 0), cacheRead: Number(u.cacheRead ?? 0), cacheWrite: Number(u.cacheWrite ?? 0), thinking: Number(u.reasoning ?? 0), cost: typeof u.cost?.total === "number" ? u.cost.total : undefined, costInput: typeof u.cost?.input === "number" ? u.cost.input : undefined, costCacheRead: typeof u.cost?.cacheRead === "number" ? u.cost.cacheRead : undefined, costCacheWrite: typeof u.cost?.cacheWrite === "number" ? u.cost.cacheWrite : undefined } : undefined;
  const text = textOf(message.content);
  events.push({ kind: "assistant", ts, text, usage, stop: message.stopReason });
  for (const part of Array.isArray(message.content) ? message.content : []) {
    if (part?.type !== "toolCall") continue;
    const tool = String(part.name ?? "");
    const category = PI_CATEGORY[tool] ?? "other";
    events.push({ kind: "tool_call", ts, id: String(part.id ?? ""), tool, category, target: targetOf(category, tool, part.arguments) });
  }
  return events;
}

export function parseClaudeRecord(record: any): Event[] {
  const ts = toMs(record?.timestamp);
  const sidechain = record?.isSidechain === true;
  // The first record of a Claude Code transcript carries cwd and sessionId; surface it like pi's session header.
  if (record?.parentUuid === null && typeof record?.cwd === "string") return [{ kind: "session", ts, cwd: record.cwd, id: record.sessionId }, ...parseClaudeBody(record, ts, sidechain)];
  return parseClaudeBody(record, ts, sidechain);
}

function parseClaudeBody(record: any, ts: number, sidechain: boolean): Event[] {
  if (record?.type === "summary" || record?.isCompactSummary === true) return [{ kind: "compaction", ts }];
  if (record?.type === "attachment" && record.attachment?.type === "model" && typeof record.attachment.identity?.modelId === "string") return [{ kind: "model", ts, model: record.attachment.identity.modelId }];
  if (record?.type === "system" && record?.subtype === "compact_boundary") return [{ kind: "compaction", ts }];
  if (record?.type === "user" && record.message) {
    const content = record.message.content;
    if (typeof content === "string") {
      if (content.startsWith("This session is being continued from a previous conversation")) return [{ kind: "compaction", ts }];
      const command = content.match(/^<command-name>\/([\w:-]+)<\/command-name>/);
      if (command) return [{ kind: "command", ts, name: command[1] }];
      if (/^<local-command-(?:caveat|stdout|stderr)>/.test(content)) return [];
      return sidechain ? [] : [{ kind: "user", ts, text: content }];
    }
    if (!Array.isArray(content)) return [];
    const results = content.filter((part: any) => part?.type === "tool_result");
    if (results.length) {
      return results.map((part: any): Event => {
        let text = textOf(part.content);
        const meta = record.toolUseResult;
        if (!text && meta && typeof meta === "object") text = [meta.stdout, meta.stderr].filter(Boolean).join("\n");
        const interrupted = Boolean(meta && typeof meta === "object" && meta.interrupted);
        return { kind: "tool_result", ts, id: String(part.tool_use_id ?? ""), isError: Boolean(part.is_error) || interrupted, text: clip(text), sidechain };
      });
    }
    const text = textOf(content);
    if (!text || sidechain) return [];
    if (text.startsWith("This session is being continued from a previous conversation")) return [{ kind: "compaction", ts }];
    return [{ kind: "user", ts, text }];
  }
  if (record?.type !== "assistant" || !record.message) return [];
  const message = record.message;
  const events: Event[] = [];
  const u = message.usage;
  const usage: Usage | undefined = u ? { context: Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0), output: Number(u.output_tokens ?? 0), freshInput: Number(u.input_tokens ?? 0), cacheRead: Number(u.cache_read_input_tokens ?? 0), cacheWrite: Number(u.cache_creation_input_tokens ?? 0), thinking: Number(u.output_tokens_details?.thinking_tokens ?? 0), cacheTtlMs: u.cache_creation ? (Number(u.cache_creation.ephemeral_1h_input_tokens ?? 0) > 0 ? 3_600_000 : Number(u.cache_creation.ephemeral_5m_input_tokens ?? 0) > 0 ? 300_000 : undefined) : undefined } : undefined;
  if (!sidechain && typeof message.model === "string" && message.model) events.push({ kind: "model", ts, model: message.model });
  if (!sidechain) events.push({ kind: "assistant", ts, text: textOf(message.content), usage, stop: message.stop_reason ?? undefined });
  for (const part of Array.isArray(message.content) ? message.content : []) {
    if (part?.type !== "tool_use") continue;
    const tool = String(part.name ?? "");
    const category = CLAUDE_CATEGORY[tool] ?? "other";
    events.push({ kind: "tool_call", ts, id: String(part.id ?? ""), tool, category, target: targetOf(category, tool, part.input), sidechain });
  }
  return events;
}

export function parseLine(format: Format, line: string): Event[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let record: any;
  try { record = JSON.parse(trimmed); } catch { return []; }
  return format === "pi" ? parsePiRecord(record) : parseClaudeRecord(record);
}

/** Incremental JSONL reader: keeps a byte offset and a partial-line buffer between calls. */
export class SessionReader {
  file: string;
  format: Format | undefined;
  events: Event[] = [];
  private offset = 0;
  private pending = "";
  constructor(file: string, format?: Format) { this.file = file; this.format = format; }
  async poll(): Promise<Event[]> {
    const stat = await fs.stat(this.file);
    if (stat.size < this.offset) { this.offset = 0; this.pending = ""; this.events = []; }
    if (stat.size === this.offset) return [];
    const handle = await fs.open(this.file, "r");
    try {
      const buffer = Buffer.alloc(stat.size - this.offset);
      await handle.read(buffer, 0, buffer.length, this.offset);
      this.offset = stat.size;
      this.pending += buffer.toString("utf8");
    } finally { await handle.close(); }
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    const fresh: Event[] = [];
    for (const line of lines) {
      if (!this.format) this.format = detectFormat(line);
      if (!this.format) continue;
      fresh.push(...parseLine(this.format, line));
    }
    this.events.push(...fresh);
    return fresh;
  }
}

export function piSessionDir(cwd: string, home = os.homedir()) { return path.join(home, ".pi", "agent", "sessions", `--${cwd.replace(/^\//, "").replaceAll("/", "-")}--`); }
export function claudeProjectDir(cwd: string, home = os.homedir()) { return path.join(home, ".claude", "projects", cwd.replaceAll(/[\/.]/g, "-")); }

/** Locate a session file by its id in either store. */
export async function findSessionById(id: string, format?: Format, home = os.homedir()): Promise<{ file: string; format: Format } | undefined> {
  const roots: Array<{ dir: string; format: Format; match: (name: string) => boolean }> = [];
  if (format !== "claude") roots.push({ dir: path.join(home, ".pi", "agent", "sessions"), format: "pi", match: name => name.endsWith(`_${id}.jsonl`) });
  if (format !== "pi") roots.push({ dir: path.join(home, ".claude", "projects"), format: "claude", match: name => name === `${id}.jsonl` });
  for (const root of roots) {
    const projects = await fs.readdir(root.dir).catch(() => [] as string[]);
    for (const project of projects) {
      const names = await fs.readdir(path.join(root.dir, project)).catch(() => [] as string[]);
      const hit = names.find(root.match);
      if (hit) return { file: path.join(root.dir, project, hit), format: root.format };
    }
  }
  return undefined;
}

export async function findLatestSession(cwd: string, format?: Format, home = os.homedir()): Promise<{ file: string; format: Format } | undefined> {
  const candidates: Array<{ dir: string; format: Format }> = [];
  if (format !== "claude") candidates.push({ dir: piSessionDir(cwd, home), format: "pi" });
  if (format !== "pi") candidates.push({ dir: claudeProjectDir(cwd, home), format: "claude" });
  let best: { file: string; format: Format; mtime: number } | undefined;
  for (const { dir, format: fmt } of candidates) {
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      const stat = await fs.stat(file).catch(() => undefined);
      if (!stat || (best && stat.mtimeMs <= best.mtime)) continue;
      best = { file, format: fmt, mtime: stat.mtimeMs };
    }
  }
  return best ? { file: best.file, format: best.format } : undefined;
}

export type SessionFile = { file: string; format: Format; id: string; mtime: number };

/** Every session file under both stores touched within `withinMs`, newest first. */
export async function discoverSessions(withinMs: number, home = os.homedir(), now = Date.now()): Promise<SessionFile[]> {
  const roots: Array<{ dir: string; format: Format }> = [{ dir: path.join(home, ".pi", "agent", "sessions"), format: "pi" }, { dir: path.join(home, ".claude", "projects"), format: "claude" }];
  const found: SessionFile[] = [];
  for (const root of roots) {
    const projects = await fs.readdir(root.dir).catch(() => [] as string[]);
    for (const project of projects) {
      const dir = path.join(root.dir, project);
      const names = await fs.readdir(dir).catch(() => [] as string[]);
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const file = path.join(dir, name);
        const stat = await fs.stat(file).catch(() => undefined);
        if (!stat || now - stat.mtimeMs > withinMs) continue;
        const id = root.format === "pi" ? name.replace(/\.jsonl$/, "").replace(/^.*_/, "") : name.replace(/\.jsonl$/, "");
        found.push({ file, format: root.format, id, mtime: stat.mtimeMs });
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}
