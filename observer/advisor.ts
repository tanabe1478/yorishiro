import type { Snapshot } from "./analyze.ts";
import { run, type Runner } from "./probe.ts";

export type Verdict = "CONTINUE" | "VERIFY" | "REPLAN" | "COMPACT" | "ASK_USER";
export type CostVerdict = "FINE" | "WASTED_TURNS" | "CACHE_MISSES" | "OUTPUT_HEAVY" | "EFFORT_TOO_HIGH" | "EFFORT_TOO_LOW" | "DELEGATE_LOOKUPS" | "SUBAGENTS_EXPENSIVE" | "COMPACT_NOW" | "CLEAR_NOW";
export type Advice = { verdict: Verdict; reason: string; suggestion: string; progress?: number; requirementCovered?: "yes" | "no" | "unknown"; reportMatchesActions?: "yes" | "no" | "unknown"; costVerdict?: CostVerdict; costReason?: string; costSuggestion?: string; model?: string; at: number; /** Deterministic signature the advice was produced for; the UI trusts a CONTINUE only while it still matches. */ forSignature?: string };
export type Backend = "pi" | "claude" | "none";
export type AdvisorConfig = { backend: Backend; model?: string; minIntervalMs?: number; timeoutMs?: number; runner?: Runner };
export const DEFAULT_MODELS: Record<Exclude<Backend, "none">, string> = { pi: "google-vertex/gemini-3.8-flash", claude: "haiku" };
const VERDICTS: Verdict[] = ["CONTINUE", "VERIFY", "REPLAN", "COMPACT", "ASK_USER"];
const COST_VERDICTS: CostVerdict[] = ["FINE", "WASTED_TURNS", "CACHE_MISSES", "OUTPUT_HEAVY", "EFFORT_TOO_HIGH", "EFFORT_TOO_LOW", "DELEGATE_LOOKUPS", "SUBAGENTS_EXPENSIVE", "COMPACT_NOW", "CLEAR_NOW"];

/** The cost model the classifier judges against (from "What a task costs on Opus 5.5"). */
export const COST_RUBRIC = [
  "Cost model (per the operator's reference article): cost per task, not per token. Every turn re-sends the whole context, so the cheapest turn is the one you do not need; a model that finishes in 25 turns beats one that takes 40 at the same price.",
  "Cache: cached context reads cost 1/20 of fresh input; rewriting the cache once costs about 25 cached reads. A large context is fine, repeatedly missing the cache is not. Idle gaps longer than the cache lifetime turn the next cheap read into a full rewrite.",
  "Output and thinking tokens cost about 100x a cached read token. Reading lots of code is cheap; thinking a lot, writing long text, or re-deriving the same reasoning is expensive.",
  "Effort: mechanical work (renames, boilerplate) at low; ordinary scoped work at medium; raise to high only when medium is stuck; xhigh/max only for genuinely hard problems. Before raising effort, give the agent a verification loop (tests) so it can catch its own mistakes at medium.",
  "Model split: searches, log reading and locating things go to a small cheap model; judgment and code changes stay with the strong model. A lookup mistake is cheap to detect; a design or edit mistake makes every later turn detour.",
  "Subagents each carry their own context and loop, so they multiply cost; parallel agents in plan mode used about 7x the tokens of a normal session. Prefer fewer wasted retries in the main agent over more agents.",
  "/compact costs roughly one context rewrite and saves a little per later turn, so it pays off only if 10+ turns remain on the same work; switching to unrelated work should be /clear; finishing soon should be left alone.",
].join("\n");

/** Compact structured summary handed to the classifier instead of the full transcript. */
export function buildSummary(snapshot: Snapshot) {
  const clip = (text: string | undefined, limit: number) => text ? (text.length > limit ? `${text.slice(0, limit)}…` : text) : undefined;
  return {
    goal: clip(snapshot.lastUser, 600),
    agentLastReport: clip(snapshot.lastAssistant, 600),
    phase: snapshot.phase,
    turn: snapshot.turns,
    toolCalls: snapshot.toolCalls,
    subagentCalls: snapshot.subagentCalls,
    recentActions: snapshot.recent.map(item => item.label),
    filesChanged: snapshot.editedFiles.slice(-20),
    lastVerification: snapshot.lastVerification ? { command: snapshot.lastVerification.command.slice(0, 120), passed: snapshot.lastVerification.ok, kind: snapshot.lastVerification.kind } : null,
    editsSinceLastVerification: snapshot.audit.editsSinceVerify,
    cumulativeTests: snapshot.tests,
    verificationPassedSinceEdit: snapshot.audit.ran,
    turnEnded: snapshot.audit.turnEnded,
    contextUsage: snapshot.contextLimit ? Math.round((snapshot.context / snapshot.contextLimit) * 100) / 100 : undefined,
    compactions: snapshot.compactions,
    cost: {
      thinkingLevel: snapshot.cost.thinkingLevel ?? null,
      sessionTotals: snapshot.cost.totals,
      outputShareOfWeightedCost: Math.round(snapshot.cost.outputShare * 100) / 100,
      cacheMisses: snapshot.cost.cacheMisses,
      recentTurns: snapshot.cost.turns.map(t => ({ turn: t.turn, modelCalls: t.modelCalls, toolCalls: t.toolCalls, freshInput: t.freshInput, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, output: t.output, thinking: t.thinking, cost: t.cost ?? null, idleBeforeMin: Math.round(t.idleBeforeMs / 60000), cacheMiss: t.cacheMiss })),
    },
    workingTreeDiff: snapshot.diff,
    deterministicFindings: snapshot.findings.map(item => ({ id: item.id, level: item.level, message: item.message })),
  };
}

export function buildPrompt(summary: ReturnType<typeof buildSummary>) {
  return [
    "You observe a coding-agent session on behalf of the human operator. You do not talk to the agent. Classify the situation; do not solve the task. The operator wants you to apply the cost model below so they do not have to keep it in mind themselves.",
    COST_RUBRIC,
    "Respond with one JSON object only, no prose, with these keys:",
    '  verdict: one of "CONTINUE" (leave it alone), "VERIFY" (agent should verify before going on), "REPLAN" (agent is looping or drifting; hypothesis should be revisited), "COMPACT" (context is the main risk), "ASK_USER" (human decision or clarification is needed)',
    "  reason: one short sentence in Japanese",
    "  suggestion: the exact message the human could send to the agent, in Japanese, or empty string if verdict is CONTINUE",
    "  progress: integer 0-100, your estimate of how far the goal is",
    '  requirementCovered: "yes" | "no" | "unknown" — whether agentLastReport plus actions cover the goal',
    '  reportMatchesActions: "yes" | "no" | "unknown" — whether the agent\'s report is consistent with the observed actions (e.g. it claims tests passed but no test ran)',
    '  costVerdict: one of "FINE", "WASTED_TURNS" (retries or detours the main agent did not need), "CACHE_MISSES", "OUTPUT_HEAVY" (thinking or long outputs dominate), "EFFORT_TOO_HIGH" (mechanical work at high thinking), "EFFORT_TOO_LOW" (stuck repeatedly at low/medium without a verification loop), "DELEGATE_LOOKUPS" (strong model spending turns on search/log reading a cheap model could do), "SUBAGENTS_EXPENSIVE", "COMPACT_NOW", "CLEAR_NOW"',
    "  costReason: one short sentence in Japanese citing the numbers from the summary (turns, tokens, idle gaps)",
    "  costSuggestion: in Japanese, what the operator should change in how they run the agent (effort level, model, /compact or /clear, delegation, how to phrase the next instruction); empty string when FINE",
    "Notes: cumulativeTests counts every verification run in the whole session, including failures that were fixed later; judge the current state from lastVerification and editsSinceLastVerification.",
    "Session summary:",
    JSON.stringify(summary, null, 2),
  ].join("\n");
}

export function parseAdvice(text: string, model?: string, at = Date.now()): Advice | undefined {
  const start = text.indexOf("{"); const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: any;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
  const verdict = String(parsed?.verdict ?? "").toUpperCase() as Verdict;
  if (!VERDICTS.includes(verdict)) return undefined;
  const tri = (value: unknown) => value === "yes" || value === "no" ? value : "unknown";
  const progress = Number(parsed.progress);
  const costVerdictRaw = String(parsed.costVerdict ?? "").toUpperCase() as CostVerdict;
  const costVerdict = COST_VERDICTS.includes(costVerdictRaw) ? costVerdictRaw : undefined;
  return { verdict, reason: String(parsed.reason ?? ""), suggestion: String(parsed.suggestion ?? ""), progress: Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : undefined, requirementCovered: tri(parsed.requirementCovered), reportMatchesActions: tri(parsed.reportMatchesActions), costVerdict, costReason: String(parsed.costReason ?? ""), costSuggestion: String(parsed.costSuggestion ?? ""), model, at };
}

export function backendCommand(backend: Exclude<Backend, "none">, model: string, prompt: string): { program: string; args: string[]; input?: string } {
  // The prompt goes through stdin for both backends: pi exits 1 without output when the multi-line prompt is passed as an argument.
  if (backend === "pi") return { program: "pi", args: ["-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--model", model, "--thinking", "off"], input: prompt };
  return { program: "claude", args: ["-p", "--model", model, "--no-session-persistence", "--output-format", "json", "--tools", ""], input: prompt };
}

export function extractBackendText(backend: Exclude<Backend, "none">, stdout: string) {
  if (backend === "pi") return stdout;
  try { const parsed = JSON.parse(stdout); if (typeof parsed?.result === "string") return parsed.result; } catch {}
  return stdout;
}

/** Decide whether the classifier is worth calling for this snapshot. */
export function shouldAdvise(previousSignature: string | undefined, snapshot: Snapshot, signature: string, lastAt: number | undefined, now: number, minIntervalMs: number) {
  if (previousSignature === signature) return false;
  if (lastAt !== undefined && now - lastAt < minIntervalMs) return false;
  return snapshot.level !== "green" || snapshot.audit.turnEnded;
}

export class Advisor {
  private lastAt: number | undefined;
  private lastSignature: string | undefined;
  private inFlight = false;
  latest: Advice | undefined;
  error: string | undefined;
  /** Number of backend invocations so far; lets callers notice a completed call. */
  calls = 0;
  private config: AdvisorConfig;
  constructor(config: AdvisorConfig) { this.config = config; }
  get enabled() { return this.config.backend !== "none"; }
  async maybeAdvise(snapshot: Snapshot, signature: string, now = Date.now()): Promise<Advice | undefined> {
    if (!this.enabled || this.inFlight) return undefined;
    if (!shouldAdvise(this.lastSignature, snapshot, signature, this.lastAt, now, this.config.minIntervalMs ?? 30_000)) return undefined;
    this.lastSignature = signature; this.lastAt = now; this.inFlight = true;
    try {
      const backend = this.config.backend as Exclude<Backend, "none">;
      const model = this.config.model ?? DEFAULT_MODELS[backend];
      const command = backendCommand(backend, model, buildPrompt(buildSummary(snapshot)));
      const result = await (this.config.runner ?? run)(command.program, command.args, { input: command.input, timeoutMs: this.config.timeoutMs ?? 90_000 });
      this.calls++;
      if (result.code !== 0) { this.error = `${backend} exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 200)}`; return undefined; }
      const advice = parseAdvice(extractBackendText(backend, result.stdout), model, now);
      if (!advice) { this.error = `${backend} returned no parsable verdict`; return undefined; }
      this.error = undefined; this.latest = { ...advice, forSignature: signature };
      return advice;
    } finally { this.inFlight = false; }
  }
}
