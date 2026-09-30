import type { Snapshot, Level, Phase } from "./analyze.ts";
import type { Advice } from "./advisor.ts";

const LEVEL_LABEL: Record<Level, string> = { green: "● 緑  放置してよい", yellow: "● 黄  そろそろ確認", red: "● 赤  介入を検討" };
const PHASE_LABEL: Record<Phase, string> = { idle: "開始待ち", waiting: "あなたの入力待ち", explore: "探索", implement: "実装", verify: "検証", delegate: "委譲中", ended: "終了" };
const COST_LABEL: Record<NonNullable<Advice["costVerdict"]>, string> = { FINE: "問題なし", WASTED_TURNS: "無駄なターン", CACHE_MISSES: "キャッシュミス", OUTPUT_HEAVY: "出力・thinking 過多", EFFORT_TOO_HIGH: "effort 高すぎ", EFFORT_TOO_LOW: "effort 低すぎ", DELEGATE_LOOKUPS: "lookup は安いモデルへ", SUBAGENTS_EXPENSIVE: "サブエージェントが高い", COMPACT_NOW: "/compact の頃合い", CLEAR_NOW: "/clear の頃合い" };
const VERDICT_LABEL: Record<Advice["verdict"], string> = { CONTINUE: "任せてよい", VERIFY: "検証させる", REPLAN: "計画を見直させる", COMPACT: "コンテキスト整理", ASK_USER: "あなたの判断が必要" };

function ago(ts: number, now: number) {
  if (!ts) return "-";
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return "1分以内";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
  return `${Math.floor(seconds / 3600)}時間${Math.floor((seconds % 3600) / 60)}分前`;
}
function clock(ts: number) { const d = new Date(ts); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, "0")).join(":"); }
const mark = (ok: boolean) => ok ? "✓" : "✗";

/**
 * Render for a pane of `rows` lines. Sections are emitted in priority order (verdict, classifier, status, lists)
 * and the trailing lists are cut so the important part never scrolls off the top.
 */
export function render(snapshot: Snapshot, meta: { file: string; format: string; now?: number; advice?: Advice; advisorError?: string; advisorLabel?: string; rows?: number; columns?: number }): string {
  const now = meta.now ?? Date.now();
  const columns = meta.columns ?? 120;
  const lines: string[] = [];
  const ratio = snapshot.contextLimit ? Math.round((snapshot.context / snapshot.contextLimit) * 100) : 0;
  if (snapshot.supersededBy) lines.push(`■ 終了  新しいセッション ${snapshot.supersededBy.slice(0, 8)} に置き換わりました`);
  else if (snapshot.startedBy && snapshot.turns === 0) lines.push(`● 緑  ${snapshot.startedBy === "clear" ? "/clear" : "新規"}で開始したセッション。最初の指示待ちです`);
  else lines.push(LEVEL_LABEL[snapshot.level] + (meta.advice && meta.advice.verdict === "CONTINUE" && snapshot.level !== "green" ? "（分類器は継続でよいと判断）" : ""));
  if (!snapshot.findings.length) lines.push("  気になる点はありません。");
  for (const finding of snapshot.findings) {
    lines.push(`  - ${finding.level === "green" ? "(参考) " : ""}${finding.message}`);
    if (finding.suggestion) lines.push(`    提案: ${finding.suggestion}`);
  }
  if (meta.advice) {
    const a = meta.advice;
    lines.push("");
    lines.push(`分類器 (${a.model ?? "?"}, ${ago(a.at, now)}): ${a.verdict} — ${VERDICT_LABEL[a.verdict]}${a.progress !== undefined ? `   進捗 ${a.progress}%` : ""}`);
    if (a.reason) lines.push(`  理由: ${a.reason}`);
    if (a.requirementCovered !== "unknown" || a.reportMatchesActions !== "unknown") lines.push(`  要件カバー: ${a.requirementCovered}   報告と行動の一致: ${a.reportMatchesActions}`);
    if (a.suggestion) { lines.push("  エージェントへ送る文案:"); lines.push(`    > ${a.suggestion}`); }
    if (a.costVerdict) {
      lines.push(`  コスト: ${a.costVerdict} — ${COST_LABEL[a.costVerdict]}${a.costReason ? `   ${a.costReason}` : ""}`);
      if (a.costSuggestion) lines.push(`    運転の変え方: ${a.costSuggestion}`);
    }
  } else if (meta.advisorLabel) { lines.push(""); lines.push(`分類器 (${meta.advisorLabel}): 黄・赤への変化かターン終了で呼びます`); }
  if (meta.advisorError) lines.push(`  分類器エラー: ${meta.advisorError}`);
  const audit = snapshot.audit.ran;
  const last = snapshot.lastVerification;
  const diff = snapshot.diff ? `   Diff: +${snapshot.diff.added} -${snapshot.diff.deleted} ${snapshot.diff.files}files${snapshot.diff.untracked ? ` +${snapshot.diff.untracked}untracked` : ""}${snapshot.diff.todoAdded ? ` TODO+${snapshot.diff.todoAdded}` : ""}` : "";
  lines.push("");
  lines.push(`Phase: ${PHASE_LABEL[snapshot.phase]}   Last activity: ${ago(snapshot.lastActivity, now)}   Context: ${snapshot.context ? `約${Math.round(snapshot.context / 1000)}k (${ratio}%)` : "-"}${snapshot.compactions ? ` compaction ${snapshot.compactions}回` : ""}   Turns: ${snapshot.turns}   Tool calls: ${snapshot.toolCalls}${snapshot.subagentCalls ? ` (subagent ${snapshot.subagentCalls})` : ""}`);
  lines.push(`Last check: ${last ? `${last.ok ? "✓" : "✗"} ${shorten(last.command, 50)} (${ago(last.ts, now)})` : "なし"}   Since edit: test${mark(audit.test)} lint${mark(audit.lint)} typecheck${mark(audit.typecheck)} build${mark(audit.build)}   Edited: ${snapshot.editedFiles.length}files${diff}`);
  const c = snapshot.cost;
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  const turn = c.turns.at(-1);
  lines.push(`Cost: fresh ${k(c.totals.freshInput)} / cache read ${k(c.totals.cacheRead)} / cache write ${k(c.totals.cacheWrite)} / output ${k(c.totals.output)} (thinking ${k(c.totals.thinking)})${c.totals.cost !== undefined ? ` ≒ $${c.totals.cost.toFixed(2)}` : ""}   出力比 ${Math.round(c.outputShare * 100)}%   cache miss ${c.cacheMisses}回${c.churnTokens ? ` (部分再書込 ${k(c.churnTokens)})` : ""}   cache TTL ${Math.round(c.cacheTtlMs / 60000)}分${c.thinkingLevel ? `   thinking ${c.thinkingLevel}` : ""}${turn ? `   このターン: model ${turn.modelCalls}回 / tool ${turn.toolCalls}回` : ""}`);
  lines.push(`Source: ${meta.format}${snapshot.model ? ` (${snapshot.model})` : ""}   ${meta.file}`);
  const wrapped = lines.flatMap(line => wrap(line, columns));
  const rows = meta.rows ?? Number.POSITIVE_INFINITY;
  const tail: string[] = [];
  if (snapshot.editedFiles.length) { tail.push("", "変更ファイル:"); for (const file of snapshot.editedFiles.slice(-8)) tail.push(`  ${shorten(file, columns - 2)}`); }
  if (snapshot.recent.length) { tail.push("", "直近の動き:"); for (const item of snapshot.recent) tail.push(`  ${clock(item.ts)} ${shorten(item.label, columns - 11)}`); }
  const room = Math.max(0, rows - wrapped.length - 1);
  return [...wrapped, ...tail.slice(0, room)].join("\n");
}

function shorten(text: string, limit: number) { return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text; }
function wrap(line: string, columns: number): string[] {
  if (line.length <= columns) return [line];
  const parts: string[] = [];
  for (let i = 0; i < line.length; i += columns) parts.push(line.slice(i, i + columns));
  return parts;
}
