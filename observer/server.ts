import * as http from "node:http";
import * as os from "node:os";
import { SessionReader, discoverSessions, type SessionFile } from "./parse.ts";
import { analyze, contextLimitFor, type Snapshot, type Options } from "./analyze.ts";
import { Advisor, type Backend, DEFAULT_MODELS } from "./advisor.ts";
import { gitDiffStat, projectChecks, claudeSettingsModel, run, type Runner } from "./probe.ts";
import { notifyMac } from "./hook.ts";
import { DASHBOARD_HTML } from "./dashboard.ts";

export type ServerOptions = { port: number; host: string; withinMs: number; /** Only sessions active within this window are sent to the classifier (default 1h), so startup does not fan out one call per stale session. */ adviseWithinMs?: number; advisor: Backend; advisorModel?: string; notify: boolean; pollMs: number; home?: string; runner?: Runner; verifyPattern?: RegExp; contextLimit?: number };
export type SessionView = { id: string; file: string; format: string; cwd?: string; pane?: string; mtime: number; snapshot: Snapshot; advice?: Advisor["latest"]; advisorError?: string; signature: string };

type Tracked = { info: SessionFile; reader: SessionReader; advisor: Advisor; cwd?: string; diff?: Snapshot["diff"]; diffAt: number; checks?: Awaited<ReturnType<typeof projectChecks>>; view?: SessionView; previous?: string };

/**
 * Link a fresh session to the one it replaced so the dashboard shows "ended → replaced" instead of two live cards.
 * Claude Code: the new transcript starts with the /clear command (old one gets no marker).
 * pi: no marker at all, so a session with no prompt yet counts as the successor of a same-project session that was active within the previous 10 minutes.
 */
export function linkSupersededSessions(views: SessionView[], now = Date.now()): SessionView[] {
  const result = views.map(view => ({ ...view, snapshot: { ...view.snapshot, supersededBy: undefined, startedBy: view.snapshot.startedBy === "new" ? undefined : view.snapshot.startedBy } }));
  const ordered = [...result].sort((a, b) => a.snapshot.startedAt - b.snapshot.startedAt);
  for (const successor of ordered) {
    if (!successor.cwd) continue;
    const startedAt = successor.snapshot.startedAt || successor.mtime;
    const explicit = successor.snapshot.startedBy === "clear";
    const implicit = !explicit && successor.format === "pi" && successor.snapshot.turns === 0;
    if (!explicit && !implicit) continue;
    const earliest = implicit ? startedAt - 10 * 60_000 : 0;
    const candidates = result.filter(other => other !== successor && other.cwd === successor.cwd && other.format === successor.format && other.snapshot.lastActivity <= startedAt + 60_000 && other.snapshot.lastActivity >= earliest && !other.snapshot.supersededBy);
    const predecessor = candidates.sort((a, b) => b.snapshot.lastActivity - a.snapshot.lastActivity)[0];
    if (!predecessor) continue;
    predecessor.snapshot = { ...predecessor.snapshot, supersededBy: successor.id, phase: "ended", level: "green", findings: [] };
    if (implicit) successor.snapshot = { ...successor.snapshot, startedBy: "new" };
  }
  void now;
  return result;
}

function signature(snapshot: Snapshot) { return `${snapshot.level}|${snapshot.phase}|${snapshot.findings.map(item => item.id).join(",")}`; }

/** Keeps one reader per active session and exposes the analysed state; the web layer only serialises it. */
export class SessionHub {
  private tracked = new Map<string, Tracked>();
  private listeners = new Set<(views: SessionView[]) => void>();
  private panes = new Map<string, string>();
  private panesAt = 0;
  private claudeLimit: number | undefined;
  private options: ServerOptions;
  private ticking = false;
  constructor(options: ServerOptions) { this.options = options; }
  subscribe(listener: (views: SessionView[]) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  views(): SessionView[] { return linkSupersededSessions([...this.tracked.values()].map(item => item.view).filter((view): view is SessionView => Boolean(view))).sort((a, b) => b.mtime - a.mtime); }
  async refreshPanes() {
    const result = await (this.options.runner ?? run)("herdr", ["pane", "list"], { timeoutMs: 3_000 }).catch(() => undefined);
    if (!result || result.code !== 0) return;
    try { const panes = JSON.parse(result.stdout)?.result?.panes ?? []; this.panes.clear(); for (const pane of panes) if (pane?.agent_session?.value) this.panes.set(String(pane.agent_session.value), String(pane.pane_id)); } catch {}
  }
  async scan() {
    const home = this.options.home ?? os.homedir();
    const sessions = await discoverSessions(this.options.withinMs, home);
    const keep = new Set(sessions.map(item => item.file));
    for (const file of this.tracked.keys()) if (!keep.has(file)) this.tracked.delete(file);
    for (const info of sessions) if (!this.tracked.has(info.file)) this.tracked.set(info.file, { info, reader: new SessionReader(info.file, info.format), advisor: new Advisor({ backend: this.options.advisor, model: this.options.advisorModel, runner: this.options.runner }), diffAt: 0 });
    if (Date.now() - this.panesAt > 10_000) { await this.refreshPanes(); this.panesAt = Date.now(); }
    if (this.claudeLimit === undefined && !this.options.contextLimit) { const model = await claudeSettingsModel(home); this.claudeLimit = model && /\[1m\]/i.test(model) ? contextLimitFor(model) : 0; }
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try { await this.tickInner(); } finally { this.ticking = false; }
  }
  private async tickInner() {
    await this.scan();
    let changed = false;
    for (const item of this.tracked.values()) {
      const fresh = await item.reader.poll().catch(() => [] as never[]);
      if (!item.cwd) { const head = item.reader.events.find(event => event.kind === "session"); if (head && head.kind === "session") item.cwd = head.cwd; }
      const stat = await import("node:fs/promises").then(fs => fs.stat(item.info.file)).catch(() => undefined);
      if (stat) item.info.mtime = stat.mtimeMs;
      if (item.cwd && Date.now() - item.diffAt >= 5_000 && (fresh.length || !item.diff)) { item.diff = await gitDiffStat(item.cwd, this.options.runner); if (!item.checks) item.checks = await projectChecks(item.cwd); item.diffAt = Date.now(); }
      if (!fresh.length && item.view && Date.now() - item.view.snapshot.lastActivity < 60_000) continue;
      const options: Options = { diff: item.diff, cwd: item.cwd, availableChecks: item.checks, ...(this.options.verifyPattern ? { verifyPattern: this.options.verifyPattern } : {}), ...(this.options.contextLimit ? { contextLimit: this.options.contextLimit } : item.info.format === "claude" && this.claudeLimit ? { contextLimit: this.claudeLimit } : {}) };
      const snapshot = analyze(item.reader.events, options);
      const sig = signature(snapshot);
      const sessionId = item.info.id;
      item.view = { id: sessionId, file: item.info.file, format: item.info.format, cwd: item.cwd, pane: this.panes.get(sessionId), mtime: item.info.mtime, snapshot, advice: item.advisor.latest, advisorError: item.advisor.error, signature: sig };
      if (item.previous !== sig) {
        changed = true;
        const superseded = this.views().find(view => view.id === sessionId)?.snapshot.supersededBy;
        // With a classifier enabled, wait for its verdict before alerting so a rule that fires on a doc-only or otherwise benign situation does not page the operator.
        if (this.options.notify && item.previous !== undefined && snapshot.level !== "green" && !superseded && !item.advisor.enabled) notifyMac(`yorishiro observer: ${snapshot.level} (${item.cwd?.split("/").pop() ?? sessionId.slice(0, 8)})`, snapshot.findings[0]?.message ?? "");
        item.previous = sig;
        const before = item.advisor.calls;
        if (!superseded && Date.now() - snapshot.lastActivity <= (this.options.adviseWithinMs ?? 3600_000)) item.advisor.maybeAdvise(snapshot, sig).then(advice => { if (item.advisor.calls !== before && item.view) { item.view = { ...item.view, advice: item.advisor.latest, advisorError: item.advisor.error }; this.emit(); if (advice && this.options.notify && advice.verdict !== "CONTINUE") notifyMac(`yorishiro observer: ${advice.verdict} (${item.cwd?.split("/").pop() ?? sessionId.slice(0, 8)})`, `${snapshot.findings[0]?.message ?? ""} / ${advice.reason}`); } }).catch(() => {});
      } else if (fresh.length) changed = true;
    }
    if (changed) this.emit();
  }
  private emit() { const views = this.views(); for (const listener of this.listeners) listener(views); }
}

export function createServer(hub: SessionHub, options: ServerOptions) {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/") { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(DASHBOARD_HTML); return; }
    if (url.pathname === "/api/sessions") { response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify({ generatedAt: Date.now(), advisor: options.advisor === "none" ? null : `${options.advisor}/${options.advisorModel ?? DEFAULT_MODELS[options.advisor as Exclude<Backend, "none">]}`, sessions: hub.views() })); return; }
    if (url.pathname === "/api/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      const send = (views: SessionView[]) => response.write(`data: ${JSON.stringify({ generatedAt: Date.now(), sessions: views })}\n\n`);
      send(hub.views());
      const unsubscribe = hub.subscribe(send);
      const keepAlive = setInterval(() => response.write(": ping\n\n"), 15_000);
      request.on("close", () => { unsubscribe(); clearInterval(keepAlive); });
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" }); response.end("not found");
  });
}

export async function serve(options: ServerOptions): Promise<{ hub: SessionHub; server: http.Server; url: string; stop: () => Promise<void> }> {
  const hub = new SessionHub(options);
  await hub.tick();
  const server = createServer(hub, options);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.host, () => resolve()); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const timer = setInterval(() => { hub.tick().catch(error => console.error(String(error?.message ?? error))); }, options.pollMs);
  const stop = async () => { clearInterval(timer); await new Promise<void>(resolve => server.close(() => resolve())); };
  return { hub, server, url: `http://${options.host}:${port}/`, stop };
}
