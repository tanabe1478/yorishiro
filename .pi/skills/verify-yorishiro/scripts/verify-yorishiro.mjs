#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(skillDir, "..", "..", "..");
const piBin = process.env.YORISHIRO_PI_BIN || "pi";
const evidenceRoot = process.env.YORISHIRO_VERIFY_EVIDENCE_ROOT || path.join(root, "artifacts", "verify-yorishiro");

function usage() {
  return `Yorishiro verification helper

Usage:
  node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs doctor [--json]
  node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs drive <feature> [--json]
  node .pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs cleanup --run <evidence-run-dir> [--json]

Features:
  launcher-rpc       Real bin/yorishiro + Pi RPC get_state
  extension-load     Real Pi/Jiti load of extensions/development-pipeline
  skill-discovery    Real Pi explicit --skill load of this verification Skill
  workflow-skill     Real Pi explicit --skill load of skills/development-workflow
  observer-help      Real bin/yorishiro-observe --help (help surface only)

Evidence is written under ${path.relative(root, evidenceRoot)}/<run-id>/ and survives cleanup.
`;
}

function parse(argv) {
  const args = [...argv];
  const json = args.includes("--json");
  const filtered = args.filter(arg => arg !== "--json");
  const command = filtered[0];
  const rest = filtered.slice(1);
  const runIndex = rest.indexOf("--run");
  const run = runIndex >= 0 ? rest[runIndex + 1] : undefined;
  const feature = rest.find(arg => !arg.startsWith("--") && arg !== run);
  return { command, feature, run, json };
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function executable(file) {
  try { const info = await lstat(file); return info.isFile() && (info.mode & 0o111) !== 0; } catch { return false; }
}

async function doctor() {
  const checks = [];
  const add = (name, ok, detail, required) => checks.push({ name, ok, detail, required });
  const [major, minor] = process.versions.node.split(".").map(Number);
  add("node", major > 22 || (major === 22 && minor >= 19), `node ${process.versions.node}`, true);
  const piProbe = spawnSync(piBin, ["--version"], { encoding: "utf8", timeout: 15000, env: { ...process.env, PI_OFFLINE: "1" } });
  add("pi", piProbe.status === 0, piProbe.status === 0 ? piProbe.stdout.trim() : "pi --version failed", true);
  add("launcher", await executable(path.join(root, "bin", "yorishiro")), "bin/yorishiro", true);
  add("verification-skill", await exists(path.join(skillDir, "SKILL.md")), ".pi/skills/verify-yorishiro/SKILL.md", true);
  add("bwrap", await exists("/usr/bin/bwrap"), "pipeline sandbox prerequisite", false);
  const herdrProbe = spawnSync("herdr", ["status"], { encoding: "utf8", timeout: 10000 });
  add("herdr", herdrProbe.status === 0, herdrProbe.status === 0 ? "herdr status ok" : "herdr status failed", false);
  add("observer", await executable(path.join(root, "bin", "yorishiro-observe")), "bin/yorishiro-observe", false);
  add("package-extension", await exists(path.join(root, "extensions", "development-pipeline", "index.ts")), "development-pipeline index.ts", false);
  const requiredOk = checks.filter(check => check.required).every(check => check.ok);
  const optionalOk = checks.filter(check => !check.required).every(check => check.ok);
  return { status: !requiredOk ? "blocked" : optionalOk ? "ok" : "degraded", checks };
}

function runProcess(argv, stdin, timeoutMs = 30000) {
  return spawnSync(argv[0], argv.slice(1), {
    cwd: root,
    input: stdin,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PI_OFFLINE: "1", YORISHIRO_ROOT: root },
  });
}

function parseRpc(stdout, id) {
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const value = JSON.parse(line);
      if (value.type === "response" && value.id === id) return value;
    } catch { /* extension UI or non-JSON line */ }
  }
  return undefined;
}

function drive(profile) {
  if (profile === "launcher-rpc") {
    const argv = [path.join(root, "bin", "yorishiro"), "--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--no-skills"];
    const result = runProcess(argv, '{"id":"probe","type":"get_state"}\n');
    const response = parseRpc(result.stdout, "probe");
    const model = response?.data?.model;
    return {
      argv,
      result,
      checks: [
        { name: "exit", ok: result.status === 0, detail: `exit ${result.status}` },
        { name: "rpc response", ok: response?.success === true, detail: response ? "get_state succeeded" : "no get_state response" },
        { name: "model identity", ok: typeof model?.provider === "string" && typeof model?.id === "string", detail: model ? `${model.provider}/${model.id}` : "missing model" },
      ],
    };
  }
  if (profile === "extension-load") {
    const argv = [piBin, "--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "-e", "extensions/development-pipeline/index.ts"];
    const result = runProcess(argv, '{"id":"probe","type":"get_state"}\n');
    const response = parseRpc(result.stdout, "probe");
    return { argv, result, checks: [
      { name: "exit", ok: result.status === 0, detail: `exit ${result.status}` },
      { name: "extension load", ok: response?.success === true, detail: response ? "Pi/Jiti loaded index.ts" : "no get_state response" },
    ] };
  }
  if (profile === "skill-discovery") {
    const argv = [piBin, "--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--skill", ".pi/skills/verify-yorishiro"];
    const result = runProcess(argv, '{"id":"probe","type":"get_commands"}\n');
    const response = parseRpc(result.stdout, "probe");
    const commands = Array.isArray(response?.data?.commands) ? response.data.commands : [];
    return { argv, result, checks: [
      { name: "exit", ok: result.status === 0, detail: `exit ${result.status}` },
      { name: "skill registered", ok: commands.some(command => command?.name === "skill:verify-yorishiro"), detail: "skill:verify-yorishiro" },
    ] };
  }
  if (profile === "workflow-skill") {
    const argv = [piBin, "--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--skill", "skills/development-workflow"];
    const result = runProcess(argv, '{"id":"probe","type":"get_commands"}\n');
    const response = parseRpc(result.stdout, "probe");
    const commands = Array.isArray(response?.data?.commands) ? response.data.commands : [];
    return { argv, result, checks: [
      { name: "exit", ok: result.status === 0, detail: `exit ${result.status}` },
      { name: "skill registered", ok: commands.some(command => command?.name === "skill:development-workflow"), detail: "skill:development-workflow" },
    ] };
  }
  if (profile === "observer-help") {
    const argv = [path.join(root, "bin", "yorishiro-observe"), "--help"];
    const result = runProcess(argv, undefined, 15000);
    return { argv, result, checks: [
      { name: "exit", ok: result.status === 0, detail: `exit ${result.status}` },
      { name: "usage", ok: /usage|yorishiro-observe/i.test(`${result.stdout}${result.stderr}`), detail: "help text" },
    ], limitation: "Help surface only; it does not drive a live session." };
  }
  throw new Error(`Unknown feature: ${profile}`);
}

function stamp() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
}

async function writeEvidence(runDir, payload) {
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "summary.json"), JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
  if (payload.command) await writeFile(path.join(runDir, "command.json"), JSON.stringify({ argv: payload.command, cwd: root }, null, 2), { encoding: "utf8", mode: 0o600 });
  if (payload.stdout !== undefined) await writeFile(path.join(runDir, "stdout.txt"), payload.stdout, { encoding: "utf8", mode: 0o600 });
  if (payload.stderr !== undefined) await writeFile(path.join(runDir, "stderr.txt"), payload.stderr, { encoding: "utf8", mode: 0o600 });
}

async function main() {
  const { command, feature, run, json } = parse(process.argv.slice(2));
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(usage());
    return 0;
  }
  if (command === "doctor") {
    const report = await doctor();
    const runDir = path.join(evidenceRoot, `${stamp()}-doctor`);
    await writeEvidence(runDir, { feature: "doctor", ...report, evidenceDir: runDir });
    if (json) process.stdout.write(JSON.stringify({ ...report, evidenceDir: runDir }, null, 2) + "\n");
    else process.stdout.write(`doctor: ${report.status}\n${report.checks.map(check => `${check.ok ? "ok" : "FAIL"} ${check.name}: ${check.detail}`).join("\n")}\nevidence: ${runDir}\n`);
    return report.status === "blocked" ? 2 : 0;
  }
  if (command === "drive") {
    if (!feature) throw new Error("drive requires a feature name");
    const driven = drive(feature);
    const ok = driven.checks.every(check => check.ok);
    const runDir = path.join(evidenceRoot, `${stamp()}-${feature}`);
    const payload = { feature, status: ok ? "passed" : "failed", checks: driven.checks, command: driven.argv, stdout: driven.result.stdout, stderr: driven.result.stderr, exit: driven.result.status, signal: driven.result.signal ?? null, evidenceDir: runDir, limitation: driven.limitation };
    await writeEvidence(runDir, payload);
    if (json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else process.stdout.write(`${feature}: ${payload.status}\n${driven.checks.map(check => `${check.ok ? "ok" : "FAIL"} ${check.name}: ${check.detail}`).join("\n")}\nevidence: ${runDir}\n`);
    return ok ? 0 : 1;
  }
  if (command === "cleanup") {
    if (!run) throw new Error("cleanup requires --run <evidence-run-dir>");
    const resolved = path.resolve(run);
    const canonicalRoot = await realpath(evidenceRoot).catch(() => undefined);
    const canonicalRun = await realpath(resolved).catch(() => undefined);
    if (!canonicalRoot || !canonicalRun) throw new Error("cleanup run or evidence root is unavailable");
    const relative = path.relative(canonicalRoot, canonicalRun);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("cleanup run must be inside the verification evidence root");
    const info = await lstat(resolved);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("cleanup run must be a real evidence directory");
    const summaryFile = path.join(resolved, "summary.json");
    const summaryInfo = await lstat(summaryFile).catch(() => undefined);
    if (!summaryInfo || summaryInfo.isSymbolicLink() || !summaryInfo.isFile()) throw new Error("cleanup summary must be a regular file, not a symlink");
    const scratch = path.join(resolved, ".scratch");
    const scratchInfo = await lstat(scratch).catch(() => undefined);
    if (scratchInfo?.isSymbolicLink()) throw new Error("cleanup scratch must not be a symlink");
    // The helper starts only synchronous, already-exited processes. Cleanup removes
    // scratch files, never the evidence itself.
    await rm(scratch, { recursive: true, force: true });
    const summary = JSON.parse(await readFile(summaryFile, "utf8"));
    summary.cleanup = { at: new Date().toISOString(), evidenceRetained: true };
    await writeFile(summaryFile, JSON.stringify(summary, null, 2), { encoding: "utf8", mode: 0o600 });
    const result = { status: "ok", run: canonicalRun, evidenceRetained: await exists(summaryFile) };
    if (json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else process.stdout.write(`cleanup: ok\nrun: ${canonicalRun}\nevidence retained: ${result.evidenceRetained}\n`);
    return 0;
  }
  throw new Error(`Unknown command: ${command}`);
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`verify-yorishiro: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
