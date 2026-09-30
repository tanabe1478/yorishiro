import type { Event } from "./parse.ts";

export type Level = "green" | "yellow" | "red";
export type Phase = "idle" | "waiting" | "explore" | "implement" | "verify" | "delegate" | "ended";
export type Finding = { id: string; level: Level; message: string; suggestion?: string };
export type VerifyKind = "test" | "lint" | "typecheck" | "build";
export type DiffStat = { files: number; added: number; deleted: number; untracked: number; todoAdded: number };
export type Audit = { editsSinceVerify: number; ran: Record<VerifyKind, boolean>; turnEnded: boolean };
/** A counted cache miss, computed the way pi's cache-stats does: prompt tokens that were in the previous request but were not read from cache. `cost` is the extra dollars versus a full cache hit when pricing is known. */
export type CacheMiss = { cause: "idle" | "model" | "unknown"; tokens: number; cost?: number; ts: number; idleMs: number };
export type TurnStats = { turn: number; startedAt: number; endedAt: number; modelCalls: number; toolCalls: number; freshInput: number; cacheRead: number; cacheWrite: number; output: number; thinking: number; cost?: number; idleBeforeMs: number; cacheMiss: boolean; misses: CacheMiss[] };
export type CostSummary = { totals: Omit<TurnStats, "turn" | "startedAt" | "endedAt" | "idleBeforeMs" | "cacheMiss" | "misses">; turns: TurnStats[]; thinkingLevel?: string; cacheMisses: number; /** Tokens re-billed in small partial rewrites (above pi's 1k noise floor but under 10% of the prompt), which are churn rather than misses. */ churnTokens: number; cacheTtlMs: number; outputShare: number };
export type Verification = { command: string; ok: boolean; ts: number; kind: VerifyKind };
export type Snapshot = {
  level: Level;
  phase: Phase;
  turns: number;
  toolCalls: number;
  subagentCalls: number;
  editedFiles: string[];
  context: number;
  contextLimit: number;
  model?: string;
  compactions: number;
  lastActivity: number;
  lastUser?: string;
  lastAssistant?: string;
  tests: { runs: number; failures: number };
  lastVerification?: Verification;
  /** Timestamp of the first record in the session file. */
  startedAt: number;
  /** How this session began: "clear" (Claude Code /clear marker) or "new" (pi: fresh session right after another one in the same project). */
  startedBy?: string;
  /** Set by the hub when a later session in the same project replaced this one (e.g. after /clear). */
  supersededBy?: string;
  cost: CostSummary;
  diff?: DiffStat;
  audit: Audit;
  findings: Finding[];
  recent: Array<{ ts: number; label: string }>;
};
export type Options = {
  verifyPattern?: RegExp;
  window?: number;
  repeatThreshold?: number;
  unverifiedYellow?: number;
  unverifiedRed?: number;
  deviationLength?: number;
  scopeYellow?: number;
  scopeRed?: number;
  contextLimit?: number;
  contextYellowRatio?: number;
  contextRedRatio?: number;
  diffYellow?: number;
  diffRed?: number;
  stalledMs?: number;
  diff?: DiffStat;
  now?: number;
  /** Working directory of the observed agent; edits outside it are dropped from the file list. */
  cwd?: string;
  /** Verification kinds the project actually provides (from package.json scripts etc.). Undefined means unknown. */
  availableChecks?: VerifyKind[];
  /** Prompt-cache lifetime; an idle gap longer than this before a turn means the next call rewrites the whole context. */
  cacheTtlMs?: number;
  /** Warn when output+thinking tokens exceed this share of all billed tokens weighted by the article's price ratio. */
  outputShareYellow?: number;
  /** Model calls within a single user turn before the turn is called expensive. */
  modelCallsYellow?: number;
  modelCallsRed?: number;
};

export const DEFAULT_VERIFY = /\b(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?(?:test|lint|typecheck|check|build)\b|\bnode\b.*\btest\b|\bvitest\b|\bjest\b|\bmocha\b|\bpytest\b|\bgo\s+(?:test|vet|build)\b|\bcargo\s+(?:test|check|clippy|build)\b|\btsc\b|\beslint\b|\bmise\s+run\b|\bmake\s+(?:test|check|lint|build)\b|\bswift\s+(?:test|build)\b|\bmoon\s+(?:test|check|build)\b|\bplaywright\s+test\b|\bxcodebuild\b|\bbiome\b|\bruff\b|\bmypy\b|\bprettier\b.*--check/;
const VERIFY_KINDS: Array<[VerifyKind, RegExp]> = [
  ["lint", /\blint\b|\beslint\b|\bbiome\b|\bruff\b|\bclippy\b|\bgo\s+vet\b|\bprettier\b/],
  ["typecheck", /\btypecheck\b|\btsc\b|\bmypy\b|\bcargo\s+check\b|\bmoon\s+check\b/],
  ["build", /\bbuild\b|\bxcodebuild\b/],
  ["test", /\btest\b|\bvitest\b|\bjest\b|\bmocha\b|\bpytest\b|\bplaywright\b|\bcheck\b|\bmise\s+run\b/],
];
export function verifyKind(command: string): VerifyKind {
  for (const [kind, pattern] of VERIFY_KINDS) if (pattern.test(command)) return kind;
  return "test";
}
export const DEFAULT_CONTEXT_LIMIT = 200_000;
export function contextLimitFor(model?: string): number {
  if (!model) return DEFAULT_CONTEXT_LIMIT;
  if (/\[1m\]|1m$|-1m\b/i.test(model)) return 1_000_000;
  if (/gemini/i.test(model)) return 1_000_000;
  if (/gpt-5|gpt-6|codex/i.test(model)) return 400_000;
  if (/claude|haiku|sonnet|opus|fable/i.test(model)) return 200_000;
  return DEFAULT_CONTEXT_LIMIT;
}
const LEVEL_RANK: Record<Level, number> = { green: 0, yellow: 1, red: 2 };
/** Price ratio from the article (Opus 5.5): output $20/M vs cache read $0.20/M, fresh input $4/M, cache write $5/M. Used only for weighting shares. */
const WEIGHT = { freshInput: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 };
const DEFAULTS = { cacheTtlMs: 5 * 60 * 1000, outputShareYellow: 0.5, modelCallsYellow: 25, modelCallsRed: 50, verifyPattern: DEFAULT_VERIFY, window: 20, repeatThreshold: 3, unverifiedYellow: 12, unverifiedRed: 25, deviationLength: 5, scopeYellow: 8, scopeRed: 15, contextYellowRatio: 0.75, contextRedRatio: 0.9, diffYellow: 300, diffRed: 1000, stalledMs: 10 * 60 * 1000 };

type Category = Extract<Event, { kind: "tool_call" }>["category"];
type Call = { ts: number; tool: string; category: Category; target: string; isError?: boolean; result?: string; verify: boolean; verifyKind?: VerifyKind; sidechain: boolean };

export function normalizeError(text: string) {
  const lines = text.split("\n").map(item => item.trim()).filter(item => item.length > 0).slice(0, 2);
  return lines.join(" | ").replace(/\d+/g, "#").replace(/\s+/g, " ").slice(0, 160);
}
/** heredoc の本文を落とし、コマンド行だけを残す（本文中の `cat >` を編集と誤認しないため）。 */
export function stripHeredocs(command: string) { return command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, "<<HEREDOC"); }
/** Bash 経由の書き込み（heredoc, tee, sed -i）を編集とみなし、対象パスを返す。 */
export function shellEditTarget(rawCommand: string): string | undefined {
  const command = stripHeredocs(rawCommand);
  const pick = (m: RegExpMatchArray | null) => { const target = m ? (m[1] ?? m[2] ?? m[3]) : undefined; return target && target !== "/dev/null" ? target : undefined; };
  const redirect = pick(command.match(/(?:^|[;&|]\s*)(?:cat|printf|echo)\b[^;&|]*?(?<![0-9&])>{1,2}\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|>]+))/));
  if (redirect) return redirect;
  const tee = pick(command.match(/\btee\s+(?:-a\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|>]+))/));
  if (tee) return tee;
  const sed = command.match(/\bsed\s+-i\b([^;&|]*)/);
  if (!sed) return undefined;
  const tokens = sed[1].match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? [];
  const last = tokens.at(-1)?.replace(/^["']|["']$/g, "");
  return last && !last.startsWith("-") && last !== "/dev/null" ? last : undefined;
}
export function shortTarget(target: string, limit = 70) {
  const oneLine = target.split("\n")[0] ?? "";
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}
function maxLevel(findings: Finding[]): Level { return findings.reduce<Level>((acc, item) => LEVEL_RANK[item.level] > LEVEL_RANK[acc] ? item.level : acc, "green"); }

export function analyze(events: Event[], options: Options = {}): Snapshot {
  const opt = { ...DEFAULTS, ...options };
  const calls: Call[] = [];
  const byId = new Map<string, Call>();
  let turns = 0, context = 0, compactions = 0, lastActivity = 0, lastUser: string | undefined, lastAssistant: string | undefined, model: string | undefined;
  let lastKind: Event["kind"] | undefined;
  let lastAssistantHadTools = false;
  let turnStart = 0;
  let thinkingLevel: string | undefined;
  let startedBy: string | undefined;
  const startedAt = events[0]?.ts ?? 0;
  let sessionCalls = 0;
  // Previous model request, for cache-miss accounting (reset by compaction, like pi does).
  let prevRequest: { promptTokens: number; modelKey: string | undefined; ts: number; reportedCache: boolean } | undefined;
  const NOISE_FLOOR_TOKENS = 1024;
  /** Below this share of the previous prompt a rewrite is churn (changing tail of the prompt), not a miss. */
  const MISS_SHARE = 0.1;
  let churnTokens = 0;
  let observedTtl: number | undefined;
  const turnsStats: TurnStats[] = [];
  let currentTurn: TurnStats | undefined;
  let lastAssistantTs = 0;
  const recent: Snapshot["recent"] = [];
  const push = (ts: number, label: string) => { recent.push({ ts, label }); if (recent.length > 12) recent.shift(); };
  for (const event of events) {
    if (event.ts > lastActivity) lastActivity = event.ts;
    switch (event.kind) {
      case "user": {
        turns++; turnStart = calls.length; lastUser = event.text; push(event.ts, `user: ${shortTarget(event.text, 60)}`); lastAssistantHadTools = false;
        const idleBeforeMs = lastAssistantTs ? Math.max(0, event.ts - lastAssistantTs) : 0;
        currentTurn = { turn: turns, startedAt: event.ts, endedAt: event.ts, modelCalls: 0, toolCalls: 0, freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0, cost: undefined, idleBeforeMs, cacheMiss: false, misses: [] };
        turnsStats.push(currentTurn);
        break;
      }
      case "assistant": {
        if (event.usage) context = event.usage.context; lastAssistant = event.text || lastAssistant; lastAssistantHadTools = false; lastAssistantTs = event.ts;
        if (currentTurn) {
          currentTurn.modelCalls++; currentTurn.endedAt = event.ts;
          if (event.usage) {
            const u = event.usage;
            sessionCalls++;
            const promptTokens = u.freshInput + u.cacheRead + u.cacheWrite;
            const reportedCache = u.cacheRead + u.cacheWrite > 0;
            if (u.cacheTtlMs) observedTtl = u.cacheTtlMs;
            const ttl = options.cacheTtlMs ?? observedTtl ?? opt.cacheTtlMs;
            if (prevRequest && promptTokens > 0 && (reportedCache || prevRequest.reportedCache)) {
              const missed = Math.min(prevRequest.promptTokens, promptTokens) - u.cacheRead;
              if (missed > NOISE_FLOOR_TOKENS && missed < prevRequest.promptTokens * MISS_SHARE) churnTokens += missed;
              else if (missed > NOISE_FLOOR_TOKENS) {
                const paidTokens = u.freshInput + u.cacheWrite;
                const paidPerToken = paidTokens > 0 && u.costInput !== undefined && u.costCacheWrite !== undefined ? (u.costInput + u.costCacheWrite) / paidTokens : undefined;
                const readPerToken = u.cacheRead > 0 && u.costCacheRead !== undefined ? u.costCacheRead / u.cacheRead : 0;
                const idleMs = Math.max(0, event.ts - prevRequest.ts);
                const cause: CacheMiss["cause"] = model !== prevRequest.modelKey ? "model" : idleMs >= ttl ? "idle" : "unknown";
                currentTurn.misses.push({ cause, tokens: missed, cost: paidPerToken === undefined ? undefined : missed * Math.max(0, paidPerToken - readPerToken), ts: event.ts, idleMs });
                currentTurn.cacheMiss = true;
              }
            }
            if (promptTokens > 0) prevRequest = { promptTokens, modelKey: model, ts: event.ts, reportedCache: reportedCache || (prevRequest?.reportedCache ?? false) };
            currentTurn.freshInput += u.freshInput; currentTurn.cacheRead += u.cacheRead; currentTurn.cacheWrite += u.cacheWrite; currentTurn.output += u.output; currentTurn.thinking += u.thinking;
            if (u.cost !== undefined) currentTurn.cost = (currentTurn.cost ?? 0) + u.cost;
          }
        }
        break;
      }
      case "model": model = event.model; break;
      case "thinking_level": thinkingLevel = event.level; break;
      case "command": if (!startedBy && turns === 0 && event.name === "clear") startedBy = "clear"; push(event.ts, `/${event.name}`); break;
      case "compaction": compactions++; prevRequest = undefined; push(event.ts, "compaction"); break;
      case "tool_call": {
        const shellEdit = event.category === "exec" ? shellEditTarget(event.target) : undefined;
        const verify = event.category === "exec" && opt.verifyPattern.test(stripHeredocs(event.target));
        const call: Call = { ts: event.ts, tool: event.tool, category: shellEdit ? "edit" : event.category, target: shellEdit ?? event.target, verify, verifyKind: verify ? verifyKind(event.target) : undefined, sidechain: Boolean(event.sidechain) };
        calls.push(call); byId.set(event.id, call); lastAssistantHadTools = true; if (currentTurn && !call.sidechain) currentTurn.toolCalls++;
        push(event.ts, `${event.tool}: ${shortTarget(event.target)}`);
        break;
      }
      case "tool_result": { const call = byId.get(event.id); if (call) { call.isError = event.isError; call.result = event.text; if (event.isError) push(event.ts, `  ✗ ${shortTarget(normalizeError(event.text))}`); } break; }
    }
    if (event.kind !== "model" && event.kind !== "thinking_level" && event.kind !== "command") lastKind = event.kind;
  }
  const mainCalls = calls.filter(call => !call.sidechain);
  const findings: Finding[] = [];
  const window = mainCalls.slice(-opt.window);
  const now = opt.now ?? Date.now();
  // A live session cannot exceed its own window, so an observed context above the assumed limit means the model runs with the 1M window (Claude Code drops the [1m] suffix from transcripts).
  const assumedLimit = opt.contextLimit ?? contextLimitFor(model);
  const contextLimit = context > assumedLimit ? 1_000_000 : assumedLimit;
  const turnEnded = lastKind === "assistant" && !lastAssistantHadTools;

  // 1. repeated identical commands / reads
  const repeats = new Map<string, number>();
  for (const call of window) if (call.category === "exec" || call.category === "read") { const key = `${call.category}:${call.target}`; repeats.set(key, (repeats.get(key) ?? 0) + 1); }
  for (const [key, count] of repeats) if (count >= opt.repeatThreshold) {
    const [category, ...rest] = key.split(":"); const target = rest.join(":");
    findings.push({ id: `repeat-${category}`, level: count >= opt.repeatThreshold + 2 ? "red" : "yellow", message: category === "exec" ? `直近${window.length}回のツール呼び出しで同じコマンドを${count}回実行しています: ${shortTarget(target)}` : `直近${window.length}回のツール呼び出しで同じファイルを${count}回読み直しています: ${shortTarget(target)}`, suggestion: category === "exec" ? "「同じコマンドを繰り返す前に、前回の結果から何が分かったか整理して」と伝える" : "「そのファイルの要点をメモしてから次に進んで」と伝える" });
  }

  // 2. repeated identical failure signatures
  const errors = new Map<string, number>();
  for (const call of window) if (call.isError && call.result) { const key = normalizeError(call.result); if (key) errors.set(key, (errors.get(key) ?? 0) + 1); }
  for (const [signature, count] of errors) if (count >= opt.repeatThreshold) findings.push({ id: "error-loop", level: "red", message: `同じエラーが${count}回出ています: ${signature}`, suggestion: "「コード変更を止めて、なぜこのエラーが出るのか仮説を列挙して」と伝える" });

  // 3. consecutive verification failures
  const verifications = mainCalls.filter(call => call.verify && call.isError !== undefined);
  const tests = { runs: verifications.length, failures: verifications.filter(call => call.isError).length };
  let streak = 0;
  for (let i = verifications.length - 1; i >= 0 && verifications[i].isError; i--) streak++;
  if (streak >= 2) findings.push({ id: "verify-failing", level: streak >= opt.repeatThreshold ? "red" : "yellow", message: `検証コマンドが${streak}回連続で失敗しています: ${shortTarget(verifications.at(-1)!.target)}`, suggestion: "「失敗しているテストと期待値を先に整理して、修正方針を説明して」と伝える" });

  // 4. edits without verification, and the turn-end audit
  const lastVerifyIndex = mainCalls.reduce((acc, call, index) => call.verify ? index : acc, -1);
  // Documentation edits do not need a test run; only code edits open the "unverified" window.
  const editsAfter = mainCalls.slice(lastVerifyIndex + 1).filter(call => call.category === "edit" && !isDocFile(call.target));
  const editedFiles = [...new Set(mainCalls.filter(call => call.category === "edit").map(call => call.target).filter(target => isProjectFile(target, opt.cwd)))];
  const firstEdit = editsAfter.length ? mainCalls.indexOf(editsAfter[0]) : -1;
  const firstEditThisTurn = mainCalls.findIndex((call, index) => index >= turnStart && call.category === "edit" && !isDocFile(call.target));
  const ran: Record<VerifyKind, boolean> = { test: false, lint: false, typecheck: false, build: false };
  if (firstEditThisTurn >= 0) for (const call of mainCalls.slice(firstEditThisTurn)) if (call.verify && call.verifyKind && !call.isError) ran[call.verifyKind] = true;
  const audit: Audit = { editsSinceVerify: editsAfter.length, ran, turnEnded };
  if (editsAfter.length) {
    const since = mainCalls.length - firstEdit;
    if (turnEnded) findings.push({ id: "unverified-stop", level: "yellow", message: `最後の検証以降に${editsAfter.length}件の編集がありますが、検証せずにターンを終えています`, suggestion: "「変更に対応するテスト・型チェックを実行して結果を報告して」と伝える" });
    else if (since >= opt.unverifiedRed) findings.push({ id: "unverified", level: "red", message: `最初の未検証編集から${since}回ツールを呼んでいますが、検証コマンドを実行していません`, suggestion: "「ここまでの変更をテストしてから次に進んで」と伝える" });
    else if (since >= opt.unverifiedYellow) findings.push({ id: "unverified", level: "yellow", message: `編集後${since}回のツール呼び出しで検証コマンドが実行されていません`, suggestion: "「区切りのよいところでテストを実行して」と伝える" });
    // phase deviation: expected verify after edits, but drifted back into exploration
    const tail = mainCalls.slice(mainCalls.indexOf(editsAfter.at(-1)!) + 1);
    if (!turnEnded && tail.length >= opt.deviationLength && tail.every(call => call.category === "read" || call.category === "search")) findings.push({ id: "phase-deviation", level: "yellow", message: `編集後に検証へ進まず、${tail.length}回連続で読み取り・検索に戻っています`, suggestion: "「探索を続ける前に、いま加えた変更をテストして」と伝える" });
  } else if (turnEnded && firstEditThisTurn >= 0) {
    const missing = (["lint", "typecheck"] as VerifyKind[]).filter(kind => !ran[kind] && (opt.availableChecks ? opt.availableChecks.includes(kind) : false));
    if (missing.length) findings.push({ id: "audit-partial", level: "green", message: `テストは実行済みですが、${missing.join(" と ")}は実行されていません`, suggestion: "プロジェクトに lint / 型チェックがあるなら「実行して結果を報告して」と伝える" });
  }

  // 5. scope growth within the current turn
  const turnFiles = new Set(calls.slice(turnStart).filter(call => !call.sidechain && call.category === "edit").map(call => call.target));
  if (turnFiles.size >= opt.scopeYellow) findings.push({ id: "scope", level: turnFiles.size >= opt.scopeRed ? "red" : "yellow", message: `このターンだけで変更ファイルが${turnFiles.size}件に広がっています`, suggestion: "「変更ファイル一覧と、それぞれが依頼のどの部分に対応するか説明して」と伝える" });

  // 6. working-tree diff size and TODO markers
  if (opt.diff) {
    const changed = opt.diff.added + opt.diff.deleted;
    if (changed >= opt.diffYellow) findings.push({ id: "diff-size", level: changed >= opt.diffRed ? "red" : "yellow", message: `作業ツリーの差分が${changed}行（+${opt.diff.added} / -${opt.diff.deleted}、${opt.diff.files}ファイル${opt.diff.untracked ? `、未追跡${opt.diff.untracked}件` : ""}）に達しています`, suggestion: "「依頼に不要な変更が混ざっていないか、差分を項目ごとに説明して」と伝える" });
    if (opt.diff.todoAdded > 0) findings.push({ id: "todo-added", level: "yellow", message: `差分に TODO / FIXME が${opt.diff.todoAdded}行追加されています`, suggestion: "「残した TODO を一覧にして、今回やらない理由を説明して」と伝える" });
  }

  // 7. context usage ratio
  const ratio = contextLimit ? context / contextLimit : 0;
  if (ratio >= opt.contextYellowRatio) findings.push({ id: "context", level: ratio >= opt.contextRedRatio ? "red" : "yellow", message: `コンテキストが上限の${Math.round(ratio * 100)}%（約${Math.round(context / 1000)}k / ${Math.round(contextLimit / 1000)}k、compaction ${compactions}回）です`, suggestion: "同じ作業がまだ10ターン以上続くなら /compact（1回の圧縮コストは約10ターン分の節約で回収）、別の作業に移るなら /clear、もうすぐ終わるならそのまま" });

  // 8. subagent volume
  const subagentCalls = mainCalls.filter(call => call.category === "agent").length;
  if (subagentCalls >= 3) findings.push({ id: "subagents", level: "yellow", message: `サブエージェントを${subagentCalls}回起動しています`, suggestion: "並列調査が本当に必要か、親で直接やる方が安くないか確認する" });

  // 9. cost signals from the article: wasted turns, cache misses, output/thinking weight
  const totals = turnsStats.reduce((acc, t) => ({ modelCalls: acc.modelCalls + t.modelCalls, toolCalls: acc.toolCalls + t.toolCalls, freshInput: acc.freshInput + t.freshInput, cacheRead: acc.cacheRead + t.cacheRead, cacheWrite: acc.cacheWrite + t.cacheWrite, output: acc.output + t.output, thinking: acc.thinking + t.thinking, cost: t.cost === undefined ? acc.cost : (acc.cost ?? 0) + t.cost }), { modelCalls: 0, toolCalls: 0, freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0, cost: undefined as number | undefined });
  const weighted = totals.freshInput * WEIGHT.freshInput + totals.cacheRead * WEIGHT.cacheRead + totals.cacheWrite * WEIGHT.cacheWrite + totals.output * WEIGHT.output;
  const outputShare = weighted ? (totals.output * WEIGHT.output) / weighted : 0;
  const cacheMisses = turnsStats.filter(t => t.cacheMiss).length;
  const cost: CostSummary = { totals, turns: turnsStats.slice(-8), thinkingLevel, cacheMisses, churnTokens, cacheTtlMs: options.cacheTtlMs ?? observedTtl ?? opt.cacheTtlMs, outputShare };
  const current = turnsStats.at(-1);
  if (current && current.misses.length) {
    const tokens = current.misses.reduce((acc, miss) => acc + miss.tokens, 0);
    const costs = current.misses.map(miss => miss.cost).filter((cost): cost is number => cost !== undefined);
    const costText = costs.length === current.misses.length ? `、キャッシュが効いていれば約$${costs.reduce((a, b) => a + b, 0).toFixed(2)}安く済んだ分` : "";
    const causes = new Set(current.misses.map(miss => miss.cause));
    const idle = Math.max(...current.misses.map(miss => miss.idleMs));
    const why = causes.has("model") ? "モデルを切り替えたためキャッシュが無効化され" : causes.has("idle") ? `${Math.round(idle / 60000)}分の中断でキャッシュが切れ` : "キャッシュが効かず";
    findings.push({ id: "cache-miss", level: "yellow", message: `${why}、このターンで${current.misses.length}回、約${Math.round(tokens / 1000)}kトークンを再課金されました${costText}（cache write 1回 ≒ cache read 25回分）`, suggestion: causes.has("model") ? "モデル切替は毎回コンテキスト全体の再送になる。切り替えるなら作業の区切り（/clear や新セッション）で行うか、切替後はそのまま続ける" : causes.has("idle") ? "長く離れるときは、戻ってすぐ続けるより /clear して新しい作業として始める方が安いことがある。短い離席なら1回の再書き込みは許容" : "同じターンで繰り返すなら、会話履歴を書き換える操作（メッセージ編集、ツール結果の差し替え）がないか確認する" });
  }
  if (current && !turnEnded && current.modelCalls >= opt.modelCallsYellow) findings.push({ id: "turn-cost", level: current.modelCalls >= opt.modelCallsRed ? "red" : "yellow", message: `このターンだけでモデル呼び出しが${current.modelCalls}回、ツール呼び出しが${current.toolCalls}回です（毎回コンテキスト全体を送り直しています）`, suggestion: "「ここまでで分かったことと残りの手順を箇条書きにして」と一度区切らせる。同じ問題で回り続けているなら、より強いモデルや高い effort で少ないターンで終わらせる方が安い" });
  if (turnsStats.length >= 2 && outputShare >= opt.outputShareYellow) findings.push({ id: "output-heavy", level: "yellow", message: `出力・thinking トークンが料金換算で全体の${Math.round(outputShare * 100)}%を占めています（出力1トークン ≒ cache read 100トークン）`, suggestion: `${thinkingLevel && /high|xhigh|max/.test(thinkingLevel) ? `thinking が ${thinkingLevel} です。機械的な作業なら medium/low に下げる。` : ""}長い説明や大きなファイル全文の出力を控えさせ、検証はテストに任せて thinking を減らす` });

  const phase = detectPhase(mainCalls, lastKind, lastAssistantHadTools, events.length);

  // 10. stalled while supposedly active
  if (phase !== "waiting" && phase !== "idle" && lastActivity && now - lastActivity >= opt.stalledMs) findings.push({ id: "stalled", level: "yellow", message: `${Math.round((now - lastActivity) / 60000)}分間ログに動きがありません（フェーズ: ${phase}）`, suggestion: "ペインを見て、コマンドが固まっていないか、権限待ちになっていないか確認する" });

  const lastVerify = verifications.at(-1);
  const lastVerification = lastVerify ? { command: verifyLabel(lastVerify.target, opt.verifyPattern), ok: !lastVerify.isError, ts: lastVerify.ts, kind: lastVerify.verifyKind ?? "test" } : undefined;
  // Nothing has happened yet in a session with no prompt (e.g. right after /clear): a pre-existing working-tree diff is not its doing.
  if (turns === 0) findings.length = 0;
  return { level: maxLevel(findings), phase, turns, toolCalls: mainCalls.length, subagentCalls, editedFiles, context, contextLimit, model, compactions, lastActivity, lastUser, lastAssistant, tests, lastVerification, startedAt, startedBy, cost, diff: opt.diff, audit, findings, recent };
}

/** The line of a compound command that actually is the verification, so the display does not show the unrelated head. */
export function verifyLabel(command: string, pattern: RegExp) {
  const segments = command.split(/\n|&&|\|\||;/).map(item => item.trim()).filter(Boolean);
  return segments.find(item => pattern.test(item)) ?? command;
}

/** Documentation and prose files: editing them does not call for a test run. */
export function isDocFile(target: string) { return /\.(?:md|mdx|markdown|txt|rst|adoc|org)$/i.test(target) || /(?:^|\/)docs?\//.test(target); }

/** Drop unresolved shell variables and paths outside the project from the edited-file list. */
export function isProjectFile(target: string, cwd?: string) {
  if (!target || target.startsWith("$") || target.includes("${")) return false;
  if (!target.startsWith("/")) return true;
  if (!cwd) return !target.startsWith("/tmp/") && !target.startsWith("/private/tmp/");
  return target === cwd || target.startsWith(cwd.endsWith("/") ? cwd : `${cwd}/`);
}

function detectPhase(calls: Call[], lastKind: Event["kind"] | undefined, lastAssistantHadTools: boolean, eventCount: number): Phase {
  if (eventCount === 0) return "idle";
  if (lastKind === "assistant" && !lastAssistantHadTools) return "waiting";
  if (lastKind === "user" || lastKind === "session") return "idle";
  const tail = calls.slice(-6);
  if (!tail.length) return "explore";
  const last = tail.at(-1)!;
  if (last.category === "agent") return "delegate";
  if (last.verify) return "verify";
  if (tail.some(call => call.category === "edit")) return "implement";
  return "explore";
}
