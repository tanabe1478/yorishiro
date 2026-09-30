import * as os from "node:os";
import * as path from "node:path";
import { SessionReader, findLatestSession, findSessionById, type Format } from "./parse.ts";
import { analyze, contextLimitFor, type Options, type Snapshot } from "./analyze.ts";
import { render } from "./render.ts";
import { gitDiffStat, herdrPaneSession, openObserverPane, claudeSettingsModel, projectChecks, herdrViewport } from "./probe.ts";
import { Advisor, DEFAULT_MODELS, type Backend } from "./advisor.ts";
import { handleHook, installHooks, notifyMac, readHookInput } from "./hook.ts";
import { serve } from "./server.ts";
import { spawn } from "node:child_process";

type Args = { command?: "hook" | "install-hooks" | "serve"; port: number; host: string; hours: number; open: boolean; file?: string; format?: Format; cwd: string; pane?: string; sessionId?: string; once: boolean; json: boolean; notify: boolean; interval: number; verify?: RegExp; contextLimit?: number; advisor: Backend; advisorModel?: string; openPane?: number; dryRun: boolean; help: boolean };

const USAGE = `usage: yorishiro-observe [session.jsonl] [options]
       yorishiro-observe hook              Claude Code hook として stdin の JSON を処理する
       yorishiro-observe install-hooks     ~/.claude/settings.json に hook を登録する（バックアップ付き）
       yorishiro-observe serve             Web ダッシュボードを起動し、全セッションを自動検出して表示する
  --port N              serve のポート（既定: 4877）
  --host H              serve の bind 先（既定: 127.0.0.1）
  --hours N             serve で表示対象にする最終更新からの時間（既定: 24）
  --open                serve 起動後にブラウザで開く
  --pi | --claude       セッション形式を固定する（省略時は自動判定）
  --cwd DIR             最新セッションを探す作業ディレクトリ（既定: カレント）
  --pane ID|current     Herdr のペインに紐づくセッションを追う
  --session-id ID       セッション ID でファイルを探す
  --once                1回だけ評価して終了する
  --json                人間向け表示の代わりに JSON を出力する
  --notify              黄・赤に変わったとき macOS 通知を出す
  --interval MS         ファイルを見直す間隔（既定: 1000）
  --verify REGEX        検証コマンドとみなす正規表現を上書きする
  --context-limit N     モデルのコンテキスト上限（既定: モデル名から推定）
  --advisor pi|claude|none  分類器の呼び出し先（既定: pi）
  --advisor-model M     分類器のモデル（既定: pi=${DEFAULT_MODELS.pi}, claude=${DEFAULT_MODELS.claude}）
  --open-pane [RATIO]   現在の Herdr ペインを分割し、そこで自分のセッションを追う observer を起動する
  --dry-run             --open-pane で実行するコマンドを表示するだけにする`;

export function parseArgs(argv: string[], env = process.env): Args {
  const args: Args = { port: Number(env.YORISHIRO_OBSERVER_PORT) || 4877, host: "127.0.0.1", hours: 24, open: false, cwd: process.cwd(), once: false, json: false, notify: false, interval: 1000, advisor: (env.YORISHIRO_OBSERVER_ADVISOR as Backend) || "pi", advisorModel: env.YORISHIRO_OBSERVER_ADVISOR_MODEL || undefined, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (i === 0 && (arg === "hook" || arg === "install-hooks" || arg === "serve")) args.command = arg;
    else if (arg === "--port") args.port = Number(argv[++i]);
    else if (arg === "--host") args.host = argv[++i] ?? "127.0.0.1";
    else if (arg === "--hours") args.hours = Number(argv[++i]);
    else if (arg === "--open") args.open = true;
    else if (arg === "--pi") args.format = "pi";
    else if (arg === "--claude") args.format = "claude";
    else if (arg === "--cwd") args.cwd = path.resolve(argv[++i] ?? ".");
    else if (arg === "--pane") args.pane = argv[++i] ?? "current";
    else if (arg === "--session-id") args.sessionId = argv[++i];
    else if (arg === "--once") args.once = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--notify") args.notify = true;
    else if (arg === "--interval") args.interval = Number(argv[++i]);
    else if (arg === "--verify") args.verify = new RegExp(argv[++i] ?? "");
    else if (arg === "--context-limit") args.contextLimit = Number(argv[++i]);
    else if (arg === "--advisor") { const value = argv[++i]; if (value !== "pi" && value !== "claude" && value !== "none") throw new Error(`--advisor must be pi, claude or none`); args.advisor = value; }
    else if (arg === "--advisor-model") args.advisorModel = argv[++i];
    else if (arg === "--open-pane") { const next = argv[i + 1]; args.openPane = next && /^0?\.\d+$/.test(next) ? Number(argv[++i]) : 0.3; }
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    else args.file = path.resolve(arg);
  }
  return args;
}

function signature(snapshot: Snapshot) { return `${snapshot.level}|${snapshot.phase}|${snapshot.findings.map(item => item.id).join(",")}`; }
function shellQuote(value: string) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
export function selfCommand(root = process.env.YORISHIRO_ROOT ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")) { return path.join(root, "bin", "yorishiro-observe"); }

export async function resolveSession(args: Args): Promise<{ file: string; format?: Format; cwd?: string } | undefined> {
  if (args.file) return { file: args.file, format: args.format };
  if (args.pane) {
    const pane = await herdrPaneSession(args.pane);
    if (!pane) throw new Error(`Herdr のペイン情報を取得できません: ${args.pane}`);
    if (pane.kind === "path" && pane.value) return { file: pane.value, format: args.format, cwd: pane.cwd };
    if (pane.value) { const found = await findSessionById(pane.value, args.format); if (found) return { ...found, cwd: pane.cwd }; }
    if (pane.cwd) { const found = await findLatestSession(pane.cwd, args.format); if (found) return { ...found, cwd: pane.cwd }; }
    return undefined;
  }
  if (args.sessionId) { const found = await findSessionById(args.sessionId, args.format); return found ? { ...found, cwd: args.cwd } : undefined; }
  const found = await findLatestSession(args.cwd, args.format);
  return found ? { ...found, cwd: args.cwd } : undefined;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return 0; }
  if (args.command === "hook") { const outcome = await handleHook(await readHookInput()); if (outcome.recorded) console.error(`yorishiro observer: ${outcome.event} recorded at ${outcome.recorded}`); return 0; }
  if (args.command === "install-hooks") {
    const settingsFile = path.join(os.homedir(), ".claude", "settings.json");
    const result = await installHooks(settingsFile, selfCommand());
    console.log(result.changed ? `hook を登録しました: ${settingsFile}${result.backup ? `（バックアップ: ${result.backup}）` : ""}` : `hook は登録済みです: ${settingsFile}`);
    return 0;
  }
  if (args.command === "serve") {
    const started = await serve({ port: args.port, host: args.host, withinMs: args.hours * 3600 * 1000, advisor: args.advisor, advisorModel: args.advisorModel, notify: args.notify, pollMs: args.interval, verifyPattern: args.verify, contextLimit: args.contextLimit });
    console.log(`yorishiro observer: ${started.url}`);
    if (args.open && process.platform === "darwin") spawn("open", [started.url], { stdio: "ignore", detached: true }).unref();
    await new Promise<void>(resolve => { const stop = () => { started.stop().finally(resolve); }; process.once("SIGINT", stop); process.once("SIGTERM", stop); });
    return 0;
  }
  if (args.openPane !== undefined) {
    const paneId = process.env.HERDR_PANE_ID;
    if (!paneId && !args.dryRun) { console.error("Herdr のペイン内で実行してください（HERDR_PANE_ID がありません）"); return 1; }
    const parts = [selfCommand(), "--pane", paneId ?? "<this-pane>", "--advisor", args.advisor];
    if (args.advisorModel) parts.push("--advisor-model", args.advisorModel);
    if (args.notify) parts.push("--notify");
    if (args.verify) parts.push("--verify", args.verify.source);
    if (args.contextLimit) parts.push("--context-limit", String(args.contextLimit));
    const command = parts.map(shellQuote).join(" ");
    const result = await openObserverPane(command, { ratio: args.openPane, dryRun: args.dryRun });
    for (const item of result.commands) console.log(item.map(shellQuote).join(" "));
    if (result.paneId) console.log(`observer pane: ${result.paneId}`);
    return 0;
  }
  const session = await resolveSession(args);
  if (!session) { console.error(`セッションが見つかりません: ${args.pane ? `pane=${args.pane}` : args.sessionId ? `id=${args.sessionId}` : `cwd=${args.cwd}`}`); return 1; }
  const reader = new SessionReader(session.file, session.format);
  const advisor = new Advisor({ backend: args.advisor, model: args.advisorModel });
  const advisorLabel = advisor.enabled ? `${args.advisor}/${args.advisorModel ?? DEFAULT_MODELS[args.advisor as Exclude<Backend, "none">]}` : undefined;
  let previous = "", previousText = "";
  let diff: Snapshot["diff"], diffAt = 0, repoCwd = session.cwd;
  let availableChecks: Awaited<ReturnType<typeof projectChecks>> | undefined;
  let viewport: { rows: number; columns?: number } | undefined, viewportAt = 0;
  let contextLimit = args.contextLimit;
  if (!contextLimit && (session.format ?? reader.format) !== "pi") { const configured = await claudeSettingsModel(); if (configured && /\[1m\]/i.test(configured)) contextLimit = contextLimitFor(configured); }
  const tick = async () => {
    await reader.poll();
    if (!repoCwd) { const head = reader.events.find(event => event.kind === "session"); if (head && head.kind === "session") repoCwd = head.cwd; }
    if (!args.once && !args.json && Date.now() - viewportAt >= 5000) { viewport = await herdrViewport() ?? viewport; viewportAt = Date.now(); }
    if (repoCwd && Date.now() - diffAt >= 5000) { diff = await gitDiffStat(repoCwd); if (!availableChecks) availableChecks = await projectChecks(repoCwd); diffAt = Date.now(); }
    const options: Options = { diff, cwd: repoCwd, availableChecks, ...(args.verify ? { verifyPattern: args.verify } : {}), ...(contextLimit ? { contextLimit } : {}) };
    const snapshot = analyze(reader.events, options);
    const current = signature(snapshot);
    const renderNow = (snap: Snapshot) => {
      const output = args.json ? JSON.stringify({ file: session.file, format: reader.format, ...snap, advice: advisor.latest, advisorError: advisor.error }) : render(snap, { file: session.file, format: reader.format ?? "unknown", advice: advisor.latest, advisorError: advisor.error, advisorLabel, rows: args.once ? undefined : viewport?.rows || process.stdout.rows || undefined, columns: viewport?.columns || process.stdout.columns || undefined });
      if (args.once || args.json) console.log(output);
      else if (output !== previousText) { previousText = output; process.stdout.write(`\x1b[H\x1b[J${output}\n`); }
    };
    if (args.once || !args.json || current !== previous) renderNow(snapshot);
    if (!args.once) { const before = advisor.calls; advisor.maybeAdvise(snapshot, current).then(advice => { if (advisor.calls !== before) renderNow(snapshot); if (advice && args.notify && advice.verdict !== "CONTINUE") notifyMac(`yorishiro observer: ${advice.verdict}`, advice.reason); }).catch(error => { advisor.error = String(error?.message ?? error); renderNow(snapshot); }); }
    if (args.notify && current !== previous && snapshot.level !== "green" && !advisor.enabled) notifyMac(`yorishiro observer: ${snapshot.level}`, snapshot.findings[0]?.message ?? "");
    previous = current;
  };
  await tick();
  if (args.once) return 0;
  await new Promise<void>(resolve => {
    const timer = setInterval(() => { tick().catch(error => { console.error(String(error?.message ?? error)); }); }, args.interval);
    const stop = () => { clearInterval(timer); resolve(); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  });
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().then(code => process.exit(code)).catch(error => { console.error(String(error?.message ?? error)); process.exit(1); });
}
