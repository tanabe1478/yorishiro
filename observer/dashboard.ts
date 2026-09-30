/** Single-file dashboard: no build step, no external assets. Data comes from /api/events (SSE) with /api/sessions as fallback. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>yorishiro observer</title>
<style>
  :root { --bg: #0f1115; --card: #171a21; --line: #262a33; --fg: #e6e6e6; --dim: #8a90a0; --green: #3fb950; --yellow: #d29922; --red: #f85149; --accent: #58a6ff; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; }
  header { display: flex; align-items: center; gap: 16px; padding: 12px 20px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 1; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .meta { color: var(--dim); font-size: 12px; margin-left: auto; }
  header label { color: var(--dim); font-size: 12px; }
  main { padding: 16px 20px; display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(520px, 1fr)); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; border-left-width: 5px; }
  .card.green { border-left-color: var(--green); } .card.yellow { border-left-color: var(--yellow); } .card.red { border-left-color: var(--red); }
  .card.stale { opacity: 0.55; }
  .title { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .title .name { font-weight: 600; font-size: 15px; }
  .title .badge { font-size: 11px; padding: 1px 7px; border-radius: 10px; border: 1px solid var(--line); color: var(--dim); }
  .level { font-weight: 600; }
  .level.green { color: var(--green); } .level.yellow { color: var(--yellow); } .level.red { color: var(--red); }
  .status { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 4px 14px; margin: 10px 0; font-size: 12px; color: var(--dim); }
  .status b { color: var(--fg); font-weight: 500; }
  ul { margin: 6px 0; padding-left: 18px; }
  li { margin: 3px 0; }
  li .hint { color: var(--dim); display: block; font-size: 12px; }
  li.green { color: var(--dim); }
  .advice { margin-top: 10px; padding: 10px 12px; background: #11141a; border-radius: 6px; font-size: 13px; }
  .advice .verdict { font-weight: 600; color: var(--accent); }
  .advice blockquote { margin: 6px 0 0; padding: 6px 10px; border-left: 3px solid var(--accent); color: var(--fg); background: #0d1117; border-radius: 4px; white-space: pre-wrap; }
  .advice .cost { margin-top: 8px; color: var(--yellow); }
  .advice .cost .how { color: var(--fg); display: block; margin-top: 2px; }
  details { margin-top: 8px; font-size: 12px; color: var(--dim); }
  details summary { cursor: pointer; }
  details pre { white-space: pre-wrap; margin: 6px 0 0; font: 12px/1.4 ui-monospace, Menlo, monospace; color: var(--fg); }
  .empty { color: var(--dim); padding: 40px; text-align: center; grid-column: 1 / -1; }
  .copy { font-size: 11px; color: var(--accent); background: none; border: 1px solid var(--line); border-radius: 4px; cursor: pointer; margin-left: 8px; padding: 1px 6px; }
</style>
</head>
<body>
<header>
  <h1>yorishiro observer</h1>
  <label><input type="checkbox" id="activeOnly" checked> 1時間以内に動いたものだけ</label>
  <span class="meta" id="meta">接続中…</span>
</header>
<main id="main"><div class="empty">セッションを探しています…</div></main>
<script>
const LEVEL = { green: "緑 放置してよい", yellow: "黄 そろそろ確認", red: "赤 介入を検討" };
const PHASE = { idle: "開始待ち", waiting: "入力待ち", explore: "探索", implement: "実装", verify: "検証", delegate: "委譲中", ended: "終了" };
const VERDICT = { CONTINUE: "任せてよい", VERIFY: "検証させる", REPLAN: "計画を見直させる", COMPACT: "コンテキスト整理", ASK_USER: "あなたの判断が必要" };
const COST = { FINE: "問題なし", WASTED_TURNS: "無駄なターン", CACHE_MISSES: "キャッシュミス", OUTPUT_HEAVY: "出力・thinking 過多", EFFORT_TOO_HIGH: "effort 高すぎ", EFFORT_TOO_LOW: "effort 低すぎ", DELEGATE_LOOKUPS: "lookup は安いモデルへ", SUBAGENTS_EXPENSIVE: "サブエージェントが高い", COMPACT_NOW: "/compact の頃合い", CLEAR_NOW: "/clear の頃合い" };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ago = (ts, now) => { if (!ts) return "-"; const s = Math.max(0, Math.round((now - ts) / 1000)); if (s < 60) return "1分以内"; if (s < 3600) return Math.floor(s / 60) + "分前"; return Math.floor(s / 3600) + "時間" + Math.floor((s % 3600) / 60) + "分前"; };
const k = n => Math.round((n || 0) / 1000) + "k";
const clock = ts => new Date(ts).toLocaleTimeString("ja-JP", { hour12: false });
let latest = { sessions: [] };
function card(v, now) {
  const s = v.snapshot, a = v.advice, c = s.cost, t = c.turns[c.turns.length - 1];
  const name = v.cwd ? v.cwd.split("/").filter(Boolean).slice(-2).join("/") : v.id.slice(0, 8);
  const stale = now - s.lastActivity > 3600e3 || Boolean(s.supersededBy);
  const calm = a && a.verdict === "CONTINUE" && a.forSignature === v.signature && s.level !== "green";
  const shownLevel = calm && s.level === "red" ? "yellow" : s.level;
  const levelLabel = s.supersededBy ? "■ 終了 → 新セッション " + esc(s.supersededBy.slice(0, 8)) + " に置換" : (s.startedBy && s.turns === 0 ? "● " + (s.startedBy === "clear" ? "/clear 直後" : "新規セッション") + "、最初の指示待ち" : "● " + LEVEL[shownLevel] + (calm ? "（分類器は継続でよいと判断）" : ""));
  const ratio = s.contextLimit ? Math.round(s.context / s.contextLimit * 100) : 0;
  const ran = s.audit.ran, mark = ok => ok ? "✓" : "✗";
  const findings = s.findings.length ? "<ul>" + s.findings.map(f => "<li class=\\"" + f.level + "\\">" + (f.level === "green" ? "(参考) " : "") + esc(f.message) + (f.suggestion ? "<span class=\\"hint\\">提案: " + esc(f.suggestion) + "</span>" : "") + "</li>").join("") + "</ul>" : "<div style=\\"color:var(--dim)\\">気になる点はありません。</div>";
  const advice = a ? "<div class=\\"advice\\"><span class=\\"verdict\\">" + esc(a.verdict) + " — " + esc(VERDICT[a.verdict] || "") + "</span>" + (a.progress != null ? " 進捗 " + a.progress + "%" : "") + " <span style=\\"color:var(--dim)\\">(" + esc(a.model || "") + ", " + ago(a.at, now) + ")</span>" + (a.reason ? "<div>" + esc(a.reason) + "</div>" : "") + ((a.requirementCovered !== "unknown" || a.reportMatchesActions !== "unknown") ? "<div style=\\"color:var(--dim)\\">要件カバー: " + esc(a.requirementCovered) + " / 報告と行動の一致: " + esc(a.reportMatchesActions) + "</div>" : "") + (a.suggestion ? "<div style=\\"color:var(--dim);margin-top:6px\\">エージェントへ送る文案 <button class=\\"copy\\" data-copy=\\"" + esc(a.suggestion) + "\\">コピー</button></div><blockquote>" + esc(a.suggestion) + "</blockquote>" : "") + (a.costVerdict ? "<div class=\\"cost\\">コスト: " + esc(a.costVerdict) + " — " + esc(COST[a.costVerdict] || "") + (a.costReason ? " " + esc(a.costReason) : "") + (a.costSuggestion ? "<span class=\\"how\\">運転の変え方: " + esc(a.costSuggestion) + "</span>" : "") + "</div>" : "") + "</div>" : (v.advisorError ? "<div class=\\"advice\\" style=\\"color:var(--red)\\">分類器エラー: " + esc(v.advisorError) + "</div>" : "");
  return "<section class=\\"card " + s.level + (stale ? " stale" : "") + "\\">" +
    "<div class=\\"title\\"><span class=\\"name\\">" + esc(name) + "</span><span class=\\"badge\\">" + esc(v.format) + (s.model ? " · " + esc(s.model) : "") + "</span>" + (v.pane ? "<span class=\\"badge\\">pane " + esc(v.pane) + "</span>" : "") + "<span class=\\"level " + (s.supersededBy ? "" : s.level) + "\\">" + levelLabel + "</span><span style=\\"margin-left:auto;color:var(--dim);font-size:12px\\">" + ago(s.lastActivity, now) + "</span></div>" +
    "<div class=\\"status\\"><span>フェーズ <b>" + PHASE[s.phase] + "</b></span><span>コンテキスト <b>" + (s.context ? k(s.context) + " (" + ratio + "%)" : "-") + "</b>" + (s.compactions ? " compaction " + s.compactions : "") + "</span><span>ターン <b>" + s.turns + "</b> / tool <b>" + s.toolCalls + "</b></span><span>最後の検証 <b>" + (s.lastVerification ? (s.lastVerification.ok ? "✓ " : "✗ ") + esc(s.lastVerification.command.slice(0, 40)) : "なし") + "</b></span><span>編集以降 <b>test" + mark(ran.test) + " lint" + mark(ran.lint) + " type" + mark(ran.typecheck) + " build" + mark(ran.build) + "</b></span><span>変更 <b>" + s.editedFiles.length + "files</b>" + (s.diff ? " +" + s.diff.added + " -" + s.diff.deleted + (s.diff.untracked ? " +" + s.diff.untracked + "untracked" : "") + (s.diff.todoAdded ? " TODO+" + s.diff.todoAdded : "") : "") + "</span>" +
    "<span>cache read <b>" + k(c.totals.cacheRead) + "</b> / write <b>" + k(c.totals.cacheWrite) + "</b></span><span>出力 <b>" + k(c.totals.output) + "</b> (thinking " + k(c.totals.thinking) + ") 比 <b>" + Math.round(c.outputShare * 100) + "%</b></span><span>cache miss <b>" + c.cacheMisses + "</b>" + (c.totals.cost != null ? " ≒ $" + c.totals.cost.toFixed(2) : "") + (c.thinkingLevel ? " thinking " + esc(c.thinkingLevel) : "") + "</span>" + (t ? "<span>このターン model <b>" + t.modelCalls + "</b> / tool <b>" + t.toolCalls + "</b></span>" : "") + "</div>" +
    findings + advice +
    "<details><summary>変更ファイルと直近の動き</summary><pre>" + esc(s.editedFiles.slice(-10).join("\\n")) + (s.editedFiles.length ? "\\n\\n" : "") + esc(s.recent.map(r => clock(r.ts) + " " + r.label).join("\\n")) + "</pre></details>" +
    "<details><summary>" + esc(v.file) + "</summary><pre>" + esc(s.lastUser || "") + "</pre></details>" +
    "</section>";
}
function draw() {
  const now = Date.now();
  const activeOnly = document.getElementById("activeOnly").checked;
  const list = latest.sessions.filter(v => !activeOnly || (now - v.snapshot.lastActivity <= 3600e3 && !v.snapshot.supersededBy));
  document.getElementById("main").innerHTML = list.length ? list.map(v => card(v, now)).join("") : "<div class=\\"empty\\">表示するセッションがありません。</div>";
  document.getElementById("meta").textContent = list.length + " / " + latest.sessions.length + " sessions · 更新 " + clock(latest.generatedAt || now) + (latest.advisor ? " · 分類器 " + latest.advisor : "");
}
document.addEventListener("click", e => { const b = e.target.closest("button.copy"); if (b) { navigator.clipboard.writeText(b.dataset.copy); b.textContent = "コピーしました"; setTimeout(() => b.textContent = "コピー", 1500); } });
document.getElementById("activeOnly").addEventListener("change", draw);
if (location.search.includes("all=1")) document.getElementById("activeOnly").checked = false;
async function poll() { try { const r = await fetch("/api/sessions", { cache: "no-store" }); latest = await r.json(); draw(); } catch {} }
function connect() {
  const es = new EventSource("/api/events");
  es.onmessage = e => { const d = JSON.parse(e.data); latest = { ...latest, ...d }; draw(); };
  es.onerror = () => { es.close(); setTimeout(connect, 3000); };
}
// ?nosse=1 keeps the page static (polling only), which lets headless screenshots finish; SSE otherwise holds the page in "loading".
poll().then(() => { if (!location.search.includes("nosse")) connect(); else setInterval(poll, 5000); });
setInterval(draw, 30000);
</script>
</body>
</html>`;
