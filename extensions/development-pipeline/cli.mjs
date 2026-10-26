// Claude Code entry point for the development pipeline. It hosts the same Pi
// extension tools without Pi and starts Claude Code children in Herdr panes.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const USAGE = `Usage:
  yorishiro-pipeline run --input <file|-> [--worker-model <model>] [--reviewer-model <model>]
  yorishiro-pipeline cleanup --run <artifact-run-dir>
  yorishiro-pipeline reset --run <artifact-run-dir> --confirm

run は development_pipeline と同じJSON入力を受け取り、Claude Code の Worker / Reviewer を Herdr のペインで動かします。
最終結果は stdout に JSON で出し、進捗は stderr に出します。exit code: 0=SUCCESS, 3=SUCCESS以外の結果, 2=入力・前提の誤り。
planReviewMode / diffReviewMode の required はこのCLIでは使えません。計画の承認は Claude Code の会話で取ってください。
`;

/** Reject inputs this host cannot honor, before any artifact or pane exists. */
export function validateCliInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("input must be a JSON object");
  for (const key of ["planReviewMode", "diffReviewMode"]) {
    if (input[key] === "required") throw new Error(`${key}: required は Claude Code CLI では使えません（人間レビューのUIがありません）。会話で承認を取り、ask か skip を指定してください`);
  }
  return input;
}

async function readInput(source) {
  if (!source) throw new Error("--input is required");
  if (source === "-") {
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    return JSON.parse(text);
  }
  return JSON.parse(await readFile(source, "utf8"));
}

async function loadTools() {
  const { collectTools } = await import("./standalone.mjs");
  const pipeline = await import("./index.ts");
  return collectTools(pipeline.default);
}

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    input: { type: "string" }, run: { type: "string" }, confirm: { type: "boolean" },
    "worker-model": { type: "string" }, "reviewer-model": { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  const [subcommand] = positionals;
  if (values.help || !subcommand) { process.stdout.write(USAGE); return values.help ? 0 : 2; }
  if (!["run", "cleanup", "reset"].includes(subcommand)) throw new Error(`unknown subcommand: ${subcommand}`);
  // The runtime and models are read once when the pipeline modules load.
  process.env.YORISHIRO_RUNTIME = "claude";
  if (values["worker-model"]) process.env.YORISHIRO_CLAUDE_WORKER_MODEL = values["worker-model"];
  if (values["reviewer-model"]) process.env.YORISHIRO_CLAUDE_REVIEWER_MODEL = values["reviewer-model"];
  const controller = new AbortController();
  let interrupts = 0;
  const onSignal = signal => {
    interrupts++;
    if (interrupts > 1) process.exit(130);
    process.stderr.write(`[yorishiro] ${signal} を受け取りました。子ペインを止めて証跡を保存します（もう一度で強制終了）\n`);
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const ctx = { cwd: process.cwd(), hasUI: false, ui: { confirm: async () => false } };
  let last = "";
  const onUpdate = update => {
    const text = update?.content?.[0]?.text;
    if (typeof text === "string" && text !== last) { last = text; process.stderr.write(`[yorishiro] ${text}\n`); }
  };

  if (subcommand === "run") {
    const input = validateCliInput(await readInput(values.input));
    const tools = await loadTools();
    const result = await tools.get("development_pipeline").execute("cli-run", input, controller.signal, onUpdate, ctx);
    const outcome = result?.details?.outcome;
    process.stdout.write(`${JSON.stringify({ outcome, artifactDir: result?.details?.artifactDir, message: result?.content?.[0]?.text }, null, 2)}\n`);
    return outcome === "SUCCESS" ? 0 : 3;
  }
  if (!values.run) throw new Error("--run is required");
  const tools = await loadTools();
  if (subcommand === "cleanup") {
    const result = await tools.get("development_pipeline_cleanup").execute("cli-cleanup", { runDir: values.run }, controller.signal, onUpdate, ctx);
    process.stdout.write(`${JSON.stringify({ message: result.content[0].text, ...result.details }, null, 2)}\n`);
    return 0;
  }
  const result = await tools.get("development_pipeline_reset").execute("cli-reset", { runDir: values.run, confirm: values.confirm === true }, controller.signal, onUpdate, ctx);
  process.stdout.write(`${JSON.stringify({ message: result.content[0].text, ...result.details }, null, 2)}\n`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`yorishiro-pipeline: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
