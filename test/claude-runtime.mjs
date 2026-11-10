import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The runtime is read once at module load, so set it before importing.
process.env.YORISHIRO_RUNTIME = "claude";
delete process.env.YORISHIRO_CLAUDE_WORKER_MODEL;
delete process.env.YORISHIRO_CLAUDE_REVIEWER_MODEL;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const models = await import("../extensions/development-pipeline/models.ts");
const { renderLauncher, renderClaudeMcpConfig, writeLauncher } = await import("../extensions/development-pipeline/launcher.ts");
const { hasExactPiIdentity } = await import("../extensions/development-pipeline/pane-monitor.ts");
const { parseClaudeAuthStatus, preflightClaudeModels } = await import("../extensions/development-pipeline/model-preflight.ts");

assert.equal(models.RUNTIME, "claude");
assert.equal(models.AGENT_BINARY, "claude");
assert.deepEqual(models.MODELS, { implement: "claude-sonnet-5-5", review: "claude-opus-5-5" });
assert.deepEqual(models.ROLE_LABELS, { implement: "Worker · Claude", review: "Reviewer · Claude" });
assert.throws(() => models.resolveRuntime("codex"), /YORISHIRO_RUNTIME must be one of pi, claude/);
assert.equal(models.resolveRuntime(""), "pi");
assert.throws(() => models.resolveClaudeModel("sonnet; rm -rf /", "x", "M"), /not a valid Claude model id/);

// Model overrides are read from the environment at load time.
const override = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", `const m=await import(${JSON.stringify(path.join(root, "extensions/development-pipeline/models.ts"))});process.stdout.write(JSON.stringify(m.MODELS));`], { encoding: "utf8", env: { ...process.env, YORISHIRO_RUNTIME: "claude", YORISHIRO_CLAUDE_WORKER_MODEL: "claude-haiku-5-5", YORISHIRO_CLAUDE_REVIEWER_MODEL: "opus" } });
assert.equal(override.status, 0, override.stderr);
assert.deepEqual(JSON.parse(override.stdout), { implement: "claude-haiku-5-5", review: "opus" });
const invalid = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", `await import(${JSON.stringify(path.join(root, "extensions/development-pipeline/models.ts"))});`], { encoding: "utf8", env: { ...process.env, YORISHIRO_RUNTIME: "claude", YORISHIRO_CLAUDE_WORKER_MODEL: "$(id)" } });
assert.notEqual(invalid.status, 0, "an invalid model id must fail before any launcher is written");

// Herdr reports Claude Code children as argv0 "claude".
const herdrClaude = { process_info: { foreground_processes: [{ argv: ["claude", "-c"], argv0: "claude", name: "2.1.310" }] } };
assert.equal(hasExactPiIdentity(herdrClaude, "claude"), true);
assert.equal(hasExactPiIdentity(herdrClaude, "pi"), false);
assert.equal(hasExactPiIdentity({ argv: ["/usr/local/bin/claude"] }, "claude"), false, "only the exact argv[0] counts");

// A workspace-trust or permission prompt shows up as "blocked": keep waiting,
// tell the human, and settle once the report appears.
{
  const { monitorPane } = await import("../extensions/development-pipeline/pane-monitor.ts");
  let clock = 0, polls = 0;
  const messages = [];
  const statuses = ["blocked", "blocked", "blocked", "working", "idle"];
  const state = await monitorPane({
    now: () => clock,
    sleep: async ms => { clock += ms; },
    poll: async () => ({ status: statuses[Math.min(polls++, statuses.length - 1)], processInfo: herdrClaude, processInfoValid: true }),
    reportExists: () => polls >= 5,
    onUpdate: message => { messages.push(message); },
    timeoutMs: 600_000,
    startupGraceMs: 1000,
    pollIntervalMs: 1000,
    reportMissingGraceMs: 1000,
    agentBinary: "claude",
  });
  assert.equal(state, "settled");
  assert.ok(messages.some(message => message.includes("人間の確認待ち")), "a blocked child must be reported as waiting for a human");
}

const cleanup = await import("../extensions/development-pipeline/cleanup.ts");
assert.deepEqual(cleanup.resolveCleanupMode([{ name: "Worker · Claude" }, { name: "Reviewer · Claude" }]), { status: "ok", mode: "claude", order: ["Reviewer · Claude", "Worker · Claude"] });
assert.equal(cleanup.resolveCleanupMode([{ name: "Worker · Claude" }, { name: "Reviewer · Sol" }]).status, "ambiguous");
assert.equal(cleanup.resolveCleanupMode([{ name: "Worker · Claude" }, { name: "Worker · DeepSeek" }]).status, "ambiguous");

// Auth preflight keeps readiness fields only.
assert.deepEqual(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "someone@example.com", orgId: "x", orgName: "y", subscriptionType: "team" })), { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "team" });
const ready = await preflightClaudeModels(["claude-sonnet-5-5", "claude-opus-5-5"], { env: {}, run: async (program, args) => { assert.equal(program, "claude"); assert.deepEqual(args, ["auth", "status"]); return { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "someone@example.com" }), stderr: "" }; } });
assert.equal(ready.status, "ready");
assert.equal(JSON.stringify(ready).includes("someone@example.com"), false, "email must not be recorded");
assert.deepEqual(ready.auth.apiKeyEnv, []);
assert.deepEqual(ready.models.map(entry => entry.availability), ["unverified-until-child-start", "unverified-until-child-start"]);
await assert.rejects(preflightClaudeModels(["claude-sonnet-5-5"], { env: {}, run: async () => ({ code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" }) }), /MODEL_PREFLIGHT_FAILED: Claude Code is not logged in/);
const keyOnly = await preflightClaudeModels(["claude-sonnet-5-5"], { env: { ANTHROPIC_API_KEY: "secret-value" }, run: async () => ({ code: 1, stdout: "", stderr: "" }) });
assert.deepEqual(keyOnly.auth.apiKeyEnv, ["ANTHROPIC_API_KEY"]);
assert.equal(JSON.stringify(keyOnly).includes("secret-value"), false, "credential values must not be recorded");

// Launchers: run the generated shell with a fake claude that records argv.
const base = await mkdtemp(path.join(os.tmpdir(), "yorishiro-claude-runtime-"));
try {
  const artifactDir = path.join(base, "run");
  const cwd = path.join(base, "target");
  await mkdir(artifactDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const fakeClaude = path.join(base, "claude");
  const argvLog = path.join(base, "argv.json"), envLog = path.join(base, "evidence-dir.txt"), backgroundLog = path.join(base, "auto-background.txt");
  await writeFile(fakeClaude, `#!/bin/sh\nprintf '%s' "\${YORISHIRO_EVIDENCE_DIR-unset}" > ${JSON.stringify(envLog)}\nprintf '%s' "\${CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS-unset}" > ${JSON.stringify(backgroundLog)}\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' ${JSON.stringify(argvLog)} "$@"\n`);
  await chmod(fakeClaude, 0o755);
  const skillDir = path.join(root, "skills", "development-workflow");
  const common = { cwd, artifactDir, root, workflowSkillDir: skillDir, workflowPlaybook: path.join(skillDir, "playbooks", "feature.md"), workflow: "feature", verifySkills: [], claudeBin: fakeClaude };
  const prompt = "あなたはWorker · Claudeです。\n--model を含む複数行の\"依頼\"";
  const runLauncher = async stage => {
    const files = await writeLauncher({ ...common, stage, name: models.INFO[stage].label, promptFile: path.join(artifactDir, `${stage}-prompt.md`), promptFileContent: prompt, reportPath: path.join(artifactDir, `${stage}-pending.json`), workflowBrief: path.join(artifactDir, `workflow-brief-${stage}.md`) });
    // The quality gate sets YORISHIRO_EVIDENCE_DIR for its own checks; the launcher must decide it for itself.
    const { YORISHIRO_EVIDENCE_DIR: _inherited, CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: _background, ...cleanEnv } = process.env;
    const run = spawnSync("/bin/sh", [files.launcher], { encoding: "utf8", env: cleanEnv });
    assert.equal(run.status, 0, run.stderr);
    return { files, argv: JSON.parse(await readFile(argvLog, "utf8")) };
  };
  const option = (argv, name) => argv[argv.indexOf(name) + 1];

  const worker = await runLauncher("implement");
  // The Worker writes its screenshots and observation JSON straight into the artifact.
  const workerEvidence = path.join(artifactDir, "evidence", "worker");
  assert.equal(await readFile(envLog, "utf8"), workerEvidence, "the Worker's YORISHIRO_EVIDENCE_DIR points into the artifact");
  assert.equal(existsSync(workerEvidence), true, "the directory exists before the child starts");
  assert.match(await readFile(worker.files.launcher, "utf8"), /^export CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT='3600000'$/m, "Claude Code's 30 minute idle limit for an MCP tool call is raised above the longest check");
  assert.equal(await readFile(backgroundLog, "utf8"), "0", "the Worker's claude process sees CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0");
  assert.match(await readFile(worker.files.launcher, "utf8"), /^export CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS='0'$/m, "Claude Code's move of an MCP call over 120 s to the background is turned off, so the child can wait for a long verification command");
  assert.equal(worker.argv.at(-1), prompt, "the prompt must stay the last positional argument");
  assert.equal(option(worker.argv, "--model"), "claude-sonnet-5-5");
  assert.equal(option(worker.argv, "--effort"), "high");
  assert.equal(option(worker.argv, "--name"), "Worker · Claude");
  assert.equal(option(worker.argv, "--tools"), "Read,Grep,Glob,Bash,Edit,Write");
  assert.equal(option(worker.argv, "--allowedTools"), "Bash,Edit,Write,mcp__yorishiro__submit_stage_report,mcp__yorishiro__run_verification_command");
  assert.equal(option(worker.argv, "--setting-sources"), "project");
  assert.equal(option(worker.argv, "--permission-mode"), "dontAsk");
  assert.ok(worker.argv.includes("--strict-mcp-config"));
  assert.equal(worker.argv.includes("--restricted"), false);
  assert.equal(option(worker.argv, "--mcp-config"), worker.files.mcpConfig);
  assert.deepEqual(worker.argv.slice(worker.argv.indexOf("--add-dir") + 1, worker.argv.indexOf("--add-dir") + 3), [artifactDir, skillDir]);
  assert.ok(worker.argv.indexOf("--add-dir") < worker.argv.indexOf("--model"), "variadic options must precede single-value options");

  const reviewer = await runLauncher("review");
  assert.equal(await readFile(envLog, "utf8"), "unset", "the Reviewer's evidence goes through run_verification_command, not a variable of its own");
  assert.equal(reviewer.argv.at(-1), prompt);
  assert.equal(await readFile(backgroundLog, "utf8"), "0", "the Reviewer's claude process sees CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0 (its npm run test:gate ran over 120 s)");
  assert.equal(option(reviewer.argv, "--model"), "claude-opus-5-5");
  assert.equal(option(reviewer.argv, "--effort"), "medium");
  assert.ok(reviewer.argv.includes("--restricted"), "the Reviewer must run in restricted mode");
  assert.equal(reviewer.argv.includes("--setting-sources"), false);
  assert.equal(option(reviewer.argv, "--tools"), "Read,Grep,Glob");
  assert.equal(option(reviewer.argv, "--allowedTools"), "mcp__yorishiro__submit_stage_report,mcp__yorishiro__run_verification_command");
  assert.equal(option(worker.argv, "--allowedTools").split(",").filter(name => name.startsWith("mcp__")).join(","), option(reviewer.argv, "--allowedTools").split(",").join(","), "both roles get the same MCP tools");
  assert.doesNotMatch(option(reviewer.argv, "--allowedTools"), /Bash|Edit|Write/);

  const workerMcp = JSON.parse(await readFile(worker.files.mcpConfig, "utf8"));
  const reviewerMcp = JSON.parse(await readFile(reviewer.files.mcpConfig, "utf8"));
  const server = workerMcp.mcpServers.yorishiro;
  assert.equal(server.type, "stdio");
  assert.equal(server.command, process.execPath);
  assert.equal(existsSync(server.args.at(-1)), true, "MCP server entry must exist");
  assert.equal(server.env.YORISHIRO_MCP_TOOLS, "submit_stage_report,run_verification_command", "the Worker gets the same verifier as the Reviewer");
  assert.equal(server.env.YORISHIRO_REPORT_SCHEMA, "worker");
  assert.equal(server.env.YORISHIRO_REPORT_PATH, path.join(artifactDir, "implement-pending.json"));
  assert.equal(server.env.YORISHIRO_TARGET_CWD, cwd, "the verifier snapshots the target checkout, which stays writable for the Worker");
  assert.equal(server.env.YORISHIRO_EVIDENCE_ROOT, path.join(artifactDir, "evidence"));
  assert.equal(reviewerMcp.mcpServers.yorishiro.env.YORISHIRO_MCP_TOOLS, "submit_stage_report,run_verification_command");
  assert.equal(reviewerMcp.mcpServers.yorishiro.env.YORISHIRO_REPORT_SCHEMA, "reviewer");
  assert.equal(reviewerMcp.mcpServers.yorishiro.env.YORISHIRO_TARGET_CWD, cwd);
  assert.equal(reviewerMcp.mcpServers.yorishiro.env.YORISHIRO_EVIDENCE_ROOT, path.join(artifactDir, "evidence"));
  assert.deepEqual(renderClaudeMcpConfig({ ...common, stage: "implement", name: "x", promptFile: path.join(artifactDir, "p.md"), reportPath: "/r.json", workflowBrief: "/b.md" }).mcpServers.yorishiro.env.YORISHIRO_RUNTIME, "claude");
  assert.doesNotMatch(renderLauncher({ ...common, stage: "implement", name: "x", promptFile: "/p.md", reportPath: "/r.json", workflowBrief: "/b.md" }), / -e | --no-extensions| --skill /, "Pi-only flags must not leak into Claude launchers");

  // The Worker's brief and prompt tell it to check requiredChecks with the verifier and where evidence goes. The Reviewer's do not change.
  const { writeWorkflowBrief } = await import("../extensions/development-pipeline/launcher.ts");
  const { promptFor } = await import("../extensions/development-pipeline/index.ts");
  const briefOptions = { artifactDir, cwd, workflow: "bug-fix", skillDir, playbookPath: path.join(skillDir, "playbooks", "bug-fix.md"), verifySkills: [] };
  const workerBrief = await readFile(await writeWorkflowBrief({ ...briefOptions, stage: "implement" }), "utf8");
  const reviewerBrief = await readFile(await writeWorkflowBrief({ ...briefOptions, stage: "review" }), "utf8");
  for (const [label, text] of [["brief", workerBrief], ["prompt", promptFor("implement", "依頼", artifactDir, "計画", "", 2, "", "", "{}")]]) {
    assert.match(text, /run_verification_command/, `the Worker ${label} names the verifier`);
    assert.match(text, /requiredChecks/, `the Worker ${label} ties it to the contract's requiredChecks`);
    assert.match(text, /exit 0/, `the Worker ${label} asks for exit 0`);
    assert.match(text, /手作りしない/, `the Worker ${label} forbids hand-made clones and sandboxes`);
    assert.ok(text.includes("$YORISHIRO_EVIDENCE_DIR") && text.includes(workerEvidence), `the Worker ${label} says where evidence goes`);
  }
  assert.ok(promptFor("implement", "依頼", artifactDir, "計画", "", 2, "", "", "{}").includes(path.join(workerEvidence, "attempt-2")), "the prompt names the attempt's subdirectory");
  assert.doesNotMatch(reviewerBrief, /手作りしない|Workerの道具/);
  assert.doesNotMatch(promptFor("review", "依頼", artifactDir, "計画", "", 1, "/w.json", "{}", "{}", "/g.json", "{}", 1), /手作りしない/);

  // bin/yorishiro-claude: Claude Code finds AGENTS.md itself below the harness;
  // anywhere else the launcher must hand the instructions over.
  const parentLauncher = async from => {
    const run = spawnSync(path.join(root, "bin", "yorishiro-claude"), ["--model", "m"], { cwd: from, encoding: "utf8", env: { ...process.env, YORISHIRO_CLAUDE_BIN: fakeClaude } });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(await readFile(argvLog, "utf8"));
  };
  const realRoot = await realpath(root);
  // The launcher compares `pwd -P` with the harness root, so "outside" has to
  // hold after symlinks resolve. os.tmpdir() can itself be inside the harness
  // (the quality gate's snapshot points TMPDIR at .yorishiro-tmp), so fall back
  // to the filesystem root, which exists everywhere and is never inside it.
  const insideHarness = async dir => `${await realpath(dir)}/`.startsWith(`${realRoot}/`);
  const outsideCwd = await insideHarness(cwd) ? path.parse(realRoot).root : cwd;
  assert.equal(await insideHarness(outsideCwd), false);
  assert.deepEqual(await parentLauncher(root), ["--plugin-dir", realRoot, "--model", "m"]);
  assert.deepEqual(await parentLauncher(path.join(root, "work")), ["--plugin-dir", realRoot, "--model", "m"]);
  const outside = await parentLauncher(outsideCwd);
  assert.deepEqual([outside[0], outside[1], outside[2], ...outside.slice(-2)], ["--plugin-dir", realRoot, "--append-system-prompt", "--model", "m"]);
  assert.ok(outside[3].includes(`Yorishiro ハーネス（${realRoot}）`), "the prompt names the harness root for relative paths");
  assert.ok(outside[3].includes(await readFile(path.join(root, "AGENTS.md"), "utf8").then(text => text.trim())), "AGENTS.md is appended verbatim");
  // The local notes are appended when present; otherwise the prompt says they
  // are absent so the session does not go looking for them.
  const localNotes = await readFile(path.join(root, "AGENTS.local.md"), "utf8").catch(() => null);
  if (localNotes === null) assert.ok(outside[3].includes("AGENTS.local.md はこの端末にない"), "a missing AGENTS.local.md is stated");
  else assert.ok(outside[3].includes(localNotes.trim()), "AGENTS.local.md is appended verbatim");
  // Linked onto PATH (through a relative link and a link to that link), the
  // launcher must still find the harness rather than the link's directory.
  const pathBin = path.join(base, "path-bin");
  await mkdir(pathBin, { recursive: true });
  await symlink(path.relative(await realpath(pathBin), path.join(realRoot, "bin", "yorishiro-claude")), path.join(pathBin, "yorishiro-claude-relative"));
  await symlink(path.join(pathBin, "yorishiro-claude-relative"), path.join(pathBin, "yorishiro-claude"));
  const linked = spawnSync(path.join(pathBin, "yorishiro-claude"), ["--model", "m"], { cwd: outsideCwd, encoding: "utf8", env: { ...process.env, YORISHIRO_CLAUDE_BIN: fakeClaude } });
  assert.equal(linked.status, 0, linked.stderr || String(linked.error));
  assert.deepEqual(JSON.parse(await readFile(argvLog, "utf8")), outside, "a PATH symlink behaves like the real launcher");
} finally {
  await rm(base, { recursive: true, force: true });
}

console.log("claude runtime launcher, model, identity, cleanup, and preflight tests passed");
