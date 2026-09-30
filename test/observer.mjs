import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
const { parseLine, detectFormat, SessionReader, findLatestSession, findSessionById, piSessionDir, claudeProjectDir } = await import("../observer/parse.ts");
const { analyze, normalizeError, shellEditTarget, DEFAULT_VERIFY, verifyKind, contextLimitFor, isProjectFile, verifyLabel } = await import("../observer/analyze.ts");
const { render } = await import("../observer/render.ts");
const { parseArgs } = await import("../observer/cli.ts");
const { buildSummary, buildPrompt, parseAdvice, shouldAdvise, backendCommand, extractBackendText, Advisor } = await import("../observer/advisor.ts");
const { gitDiffStat, herdrPaneSession, openObserverPane, countTodoAdded, todoExempt, projectChecks } = await import("../observer/probe.ts");
const { handleHook, installHooks } = await import("../observer/hook.ts");
const { discoverSessions } = await import("../observer/parse.ts");
const { SessionHub, createServer, linkSupersededSessions } = await import("../observer/server.ts");

// --- synthetic session builders (no private data) ---
const BASE = 1_700_000_000_000;
let piCounter = 0;
const piTs = () => new Date(BASE + piCounter++ * 1000).toISOString();
const piNow = () => BASE + piCounter * 1000;
const pi = {
  session: () => JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: piTs(), cwd: "/work" }),
  model: () => JSON.stringify({ type: "model_change", id: "m", timestamp: piTs(), provider: "openai-codex", modelId: "gpt-5.6-sol" }),
  user: text => JSON.stringify({ type: "message", id: "u", timestamp: piTs(), message: { role: "user", content: [{ type: "text", text }] } }),
  assistant: (text, calls = [], usage) => JSON.stringify({ type: "message", id: "a", timestamp: piTs(), message: { role: "assistant", content: [...(text ? [{ type: "text", text }] : []), ...calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args }))], usage, stopReason: "stop" } }),
  result: (id, name, text, isError = false) => JSON.stringify({ type: "message", id: "r", timestamp: piTs(), message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError } }),
  compaction: () => JSON.stringify({ type: "compaction", id: "c", timestamp: piTs(), summary: "..." }),
};
let claudeCounter = 0;
const claudeTs = () => new Date(BASE + claudeCounter++ * 1000).toISOString();
const claude = {
  system: () => JSON.stringify({ parentUuid: null, isSidechain: false, type: "system", subtype: "informational", content: "x", timestamp: claudeTs(), uuid: "0", sessionId: "c1", cwd: "/work" }),
  user: text => JSON.stringify({ parentUuid: "0", isSidechain: false, type: "user", message: { role: "user", content: text }, timestamp: claudeTs(), uuid: "1" }),
  assistant: (text, calls = [], usage, sidechain = false) => JSON.stringify({ parentUuid: "1", isSidechain: sidechain, type: "assistant", message: { model: "claude-opus-5[1m]", role: "assistant", content: [...(text ? [{ type: "text", text }] : []), ...calls.map(([id, name, input]) => ({ type: "tool_use", id, name, input }))], usage, stop_reason: calls.length ? "tool_use" : "end_turn" }, timestamp: claudeTs(), uuid: "2" }),
  result: (id, text, is_error = false, meta, sidechain = false) => JSON.stringify({ parentUuid: "2", isSidechain: sidechain, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error }] }, toolUseResult: meta, timestamp: claudeTs(), uuid: "3" }),
  continued: () => JSON.stringify({ parentUuid: "3", isSidechain: false, type: "user", message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context. Summary: ..." }, isCompactSummary: true, timestamp: claudeTs(), uuid: "4" }),
};
const parseAll = (format, lines) => lines.flatMap(line => parseLine(format, line));

// --- format detection ---
assert.equal(detectFormat(pi.session()), "pi");
assert.equal(detectFormat(claude.system()), "claude");
assert.equal(detectFormat("not json"), undefined);

// --- pi parser ---
{
  const events = parseAll("pi", [pi.session(), pi.model(), pi.user("fix auth"), pi.assistant("", [["t1", "read", { path: "/work/src/auth.ts" }], ["t2", "bash", { command: "npm test" }]], { input: 1000, cacheRead: 5000, cacheWrite: 200, output: 50 }), pi.result("t1", "read", "content"), pi.result("t2", "bash", "FAIL invalid token", true), pi.compaction(), pi.assistant("done", [], undefined)]);
  assert.deepEqual(events.map(e => e.kind), ["session", "model", "user", "assistant", "tool_call", "tool_call", "tool_result", "tool_result", "compaction", "assistant"]);
  assert.equal(events[0].cwd, "/work");
  assert.equal(events[1].model, "openai-codex/gpt-5.6-sol");
  assert.equal(events[3].usage.context, 6200);
  assert.deepEqual([events[3].usage.freshInput, events[3].usage.cacheRead, events[3].usage.cacheWrite, events[3].usage.thinking], [1000, 5000, 200, 0]);
  assert.deepEqual([events[4].category, events[4].target], ["read", "/work/src/auth.ts"]);
  assert.deepEqual([events[5].category, events[5].target], ["exec", "npm test"]);
  assert.equal(events[7].isError, true);
  assert.equal(events[7].tool, "bash");
}

// --- claude parser ---
{
  const events = parseAll("claude", [claude.system(), JSON.stringify({ type: "mode", mode: "normal" }), claude.user("fix auth"), claude.assistant("", [["u1", "Edit", { file_path: "/work/src/auth.ts", old_string: "a", new_string: "b" }], ["u2", "Bash", { command: "npm test", description: "run tests" }]], { input_tokens: 10, cache_read_input_tokens: 30000, cache_creation_input_tokens: 500, output_tokens: 20, output_tokens_details: { thinking_tokens: 7 } }), claude.result("u1", "ok"), claude.result("u2", "", true, { stdout: "", stderr: "Exit code 1\nFAIL", interrupted: false }), claude.assistant("", [["u3", "Agent", { description: "explore", prompt: "..." }]], undefined, true), claude.result("u3", "found", false, undefined, true), claude.continued(), claude.assistant("done")]);
  assert.deepEqual(events.map(e => e.kind), ["session", "user", "model", "assistant", "tool_call", "tool_call", "tool_result", "tool_result", "tool_call", "tool_result", "compaction", "model", "assistant"]);
  assert.deepEqual([events[0].cwd, events[0].id], ["/work", "c1"], "the first transcript record yields a session header");
  assert.equal(events[2].model, "claude-opus-5[1m]");
  assert.equal(events[3].usage.context, 30510);
  assert.deepEqual([events[3].usage.cacheWrite, events[3].usage.thinking], [500, 7]);
  assert.deepEqual([events[4].category, events[4].target], ["edit", "/work/src/auth.ts"]);
  assert.equal(events[7].isError, true);
  assert.match(events[7].text, /FAIL/, "empty tool_result content must fall back to toolUseResult stdout/stderr");
  assert.equal(events[8].sidechain, true, "subagent tool calls are tagged as sidechain");
  assert.equal(events[9].sidechain, true);
  assert.equal(analyze(events, { now: BASE + 60_000 }).contextLimit, 1_000_000, "[1m] model implies a 1M context limit");
}

// --- incremental reader with partial lines and truncation ---
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "observer-"));
  const file = path.join(dir, "s.jsonl");
  const first = pi.session() + "\n" + pi.user("hi") + "\n";
  const second = pi.assistant("ok");
  await fs.writeFile(file, first + second.slice(0, 20));
  const reader = new SessionReader(file);
  assert.equal((await reader.poll()).length, 2, "partial trailing line is held back");
  await fs.appendFile(file, second.slice(20) + "\n");
  assert.equal((await reader.poll()).length, 1, "completed line is emitted on the next poll");
  assert.equal(reader.format, "pi");
  assert.equal(reader.events.length, 3);
  await fs.writeFile(file, pi.session() + "\n");
  await reader.poll();
  assert.equal(reader.events.length, 1, "truncated file restarts from scratch");
  await fs.rm(dir, { recursive: true, force: true });
}

// --- session discovery ---
{
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "observer-home-"));
  const cwd = "/Users/me/Documents/repositories/demo.app";
  assert.equal(piSessionDir(cwd, home), path.join(home, ".pi/agent/sessions/--Users-me-Documents-repositories-demo.app--"));
  assert.equal(claudeProjectDir(cwd, home), path.join(home, ".claude/projects/-Users-me-Documents-repositories-demo-app"));
  assert.equal(await findLatestSession(cwd, undefined, home), undefined);
  await fs.mkdir(piSessionDir(cwd, home), { recursive: true });
  await fs.mkdir(claudeProjectDir(cwd, home), { recursive: true });
  const older = path.join(piSessionDir(cwd, home), "2026-01-01T00-00-00-000Z_abc.jsonl"), newer = path.join(claudeProjectDir(cwd, home), "b.jsonl");
  await fs.writeFile(older, "{}\n"); await fs.writeFile(newer, "{}\n");
  const past = new Date(Date.now() - 60_000); await fs.utimes(older, past, past);
  assert.deepEqual(await findLatestSession(cwd, undefined, home), { file: newer, format: "claude" });
  assert.deepEqual(await findLatestSession(cwd, "pi", home), { file: older, format: "pi" });
  assert.deepEqual(await findSessionById("abc", undefined, home), { file: older, format: "pi" });
  assert.deepEqual(await findSessionById("b", undefined, home), { file: newer, format: "claude" });
  assert.equal(await findSessionById("nope", undefined, home), undefined);
  await fs.rm(home, { recursive: true, force: true });
}

// --- helpers ---
assert.equal(normalizeError("\nExit code 2\n  line 42: boom\nmore"), "Exit code # | line #: boom");
assert.equal(shellEditTarget("cat README.md 2>/dev/null; ls"), undefined);
assert.equal(shellEditTarget("cat > /work/a.ts <<'EOF'\nx\nEOF"), "/work/a.ts");
assert.equal(shellEditTarget("mkdir -p x && cat > x/b.ts <<EOF\nEOF\necho ok"), "x/b.ts");
assert.equal(shellEditTarget("sed -i '' 's/a/b/' src/c.ts"), "src/c.ts");
assert.equal(shellEditTarget("echo hi | tee -a log.txt"), "log.txt");
assert.equal(shellEditTarget("grep foo bar > /dev/null"), undefined);
assert.equal(shellEditTarget("python3 - <<'PY'\ns = 'cat > inner.ts'\nopen('x').write(s)\nPY\necho done"), undefined, "heredoc bodies are not scanned for writes");
assert.equal(shellEditTarget("cat > out.ts <<'EOF'\ncat > inner.ts\nEOF"), "out.ts", "the heredoc command line itself still counts");
assert.ok(DEFAULT_VERIFY.test("npm run test:observer"));
assert.ok(!DEFAULT_VERIFY.test("command -v playwright || true"), "mentioning playwright is not running its tests");
assert.ok(DEFAULT_VERIFY.test("npx playwright test"));
assert.ok(DEFAULT_VERIFY.test("node --experimental-strip-types ./test/x.mjs"));
assert.ok(!DEFAULT_VERIFY.test("git status"));
assert.equal(verifyKind("npm run lint"), "lint");
assert.equal(verifyKind("npx tsc --noEmit"), "typecheck");
assert.equal(verifyKind("npm run build"), "build");
assert.equal(verifyKind("npm test"), "test");
assert.equal(contextLimitFor("claude-fable-5-1"), 200_000);
assert.equal(contextLimitFor("claude-fable-5-1[1m]"), 1_000_000);
assert.equal(contextLimitFor("openai-codex/gpt-5.6-sol"), 400_000);
assert.equal(contextLimitFor(undefined), 200_000);
assert.equal(verifyLabel("python3 - <<'PY'\nx\nPY\nnode --experimental-strip-types test/observer.mjs && echo ok", DEFAULT_VERIFY), "node --experimental-strip-types test/observer.mjs");
assert.equal(isProjectFile("$f"), false);
assert.equal(isProjectFile("${S}/pid"), false);
assert.equal(isProjectFile("/private/tmp/x/a.ts"), false);
assert.equal(isProjectFile("/repo/src/a.ts", "/repo"), true);
assert.equal(isProjectFile("/repository-other/a.ts", "/repo"), false);
assert.equal(isProjectFile("src/a.ts", "/repo"), true);
assert.equal(todoExempt("README.md"), true);
assert.equal(todoExempt("test/observer.mjs"), true);
assert.equal(todoExempt("src/a.test.ts"), true);
assert.equal(todoExempt("src/a.ts"), false);
assert.equal(countTodoAdded("+++ b/README.md\n+TODO in docs\n+++ b/src/a.ts\n+// TODO real\n+ok\n-// TODO removed\n+++ b/test/x.mjs\n+// FIXME fixture"), 1);

// --- detectors ---
function scenario(steps, options = {}) {
  const lines = [pi.session(), pi.user("task")];
  let n = 0;
  for (const step of steps) {
    if (step.user) { lines.push(pi.user(step.user)); continue; }
    if (step.assistant !== undefined) { lines.push(pi.assistant(step.assistant, [], step.usage)); continue; }
    const id = `c${n++}`;
    lines.push(pi.assistant("", [[id, step.tool, step.args]]));
    lines.push(pi.result(id, step.tool, step.result ?? "ok", Boolean(step.error)));
  }
  return analyze(parseAll("pi", lines), { now: piNow(), ...options });
}
const ids = snapshot => snapshot.findings.map(f => f.id);

let s = scenario([{ tool: "read", args: { path: "/w/a.ts" } }, { tool: "edit", args: { path: "/w/a.ts" } }, { tool: "bash", args: { command: "npm test" } }]);
assert.equal(s.level, "green"); assert.deepEqual(ids(s), []); assert.equal(s.phase, "verify"); assert.deepEqual(s.tests, { runs: 1, failures: 0 });

s = scenario(Array.from({ length: 3 }, () => ({ tool: "bash", args: { command: "npm test" }, result: "FAIL expected 1 got 2", error: true })));
assert.ok(ids(s).includes("error-loop")); assert.ok(ids(s).includes("verify-failing")); assert.equal(s.level, "red");

s = scenario([{ tool: "bash", args: { command: "npm test" }, error: true, result: "FAIL a" }, { tool: "bash", args: { command: "npm test" }, error: true, result: "FAIL b" }]);
assert.ok(ids(s).includes("verify-failing")); assert.ok(!ids(s).includes("error-loop")); assert.equal(s.level, "yellow");

s = scenario([{ tool: "read", args: { path: "/w/a.ts" } }, { tool: "read", args: { path: "/w/a.ts" } }, { tool: "read", args: { path: "/w/a.ts" } }]);
assert.deepEqual(ids(s), ["repeat-read"]); assert.equal(s.level, "yellow");

s = scenario([{ tool: "edit", args: { path: "/w/a.ts" } }, ...Array.from({ length: 12 }, () => ({ tool: "read", args: { path: `/w/${Math.random()}.ts` } }))]);
assert.ok(ids(s).includes("unverified")); assert.ok(ids(s).includes("phase-deviation")); assert.equal(s.level, "yellow"); assert.equal(s.phase, "explore");
s = scenario([{ tool: "edit", args: { path: "/w/a.ts" } }, ...Array.from({ length: 25 }, () => ({ tool: "grep", args: { pattern: `${Math.random()}` } }))]);
assert.equal(s.findings.find(f => f.id === "unverified").level, "red");
s = scenario([{ tool: "edit", args: { path: "/w/a.ts" } }, ...Array.from({ length: 5 }, () => ({ tool: "read", args: { path: `/w/${Math.random()}.ts` } }))]);
assert.deepEqual(ids(s), ["phase-deviation"], "five reads after an edit is a deviation before the unverified counter trips");
s = scenario([{ tool: "edit", args: { path: "/w/a.ts" } }, ...Array.from({ length: 4 }, () => ({ tool: "read", args: { path: `/w/${Math.random()}.ts` } })), { tool: "edit", args: { path: "/w/b.ts" } }]);
assert.deepEqual(ids(s), [], "an edit resets the deviation run");

s = scenario([{ tool: "edit", args: { path: "/w/a.ts" } }, { assistant: "実装できました" }]);
assert.deepEqual(ids(s), ["unverified-stop"]); assert.equal(s.phase, "waiting"); assert.equal(s.audit.turnEnded, true);
s = scenario([{ tool: "edit", args: { path: "/w/a.ts" } }, { tool: "bash", args: { command: "npm test" } }, { assistant: "実装できました" }]);
assert.deepEqual(ids(s), [], "without knowledge of project checks, missing lint/typecheck is not reported"); assert.deepEqual(s.audit.ran, { test: true, lint: false, typecheck: false, build: false });
assert.deepEqual([s.lastVerification.ok, s.lastVerification.command, s.lastVerification.kind], [true, "npm test", "test"]);
s = scenario([{ tool: "edit", args: { path: "/w/a.ts" } }, { tool: "bash", args: { command: "npm test" } }, { assistant: "実装できました" }], { availableChecks: ["test", "lint"] });
assert.deepEqual(ids(s), ["audit-partial"]); assert.equal(s.level, "green"); assert.match(s.findings[0].message, /lintは実行されていません/); assert.doesNotMatch(s.findings[0].message, /typecheck/);
s = scenario([{ tool: "edit", args: { path: "/w/a.ts" } }, { tool: "bash", args: { command: "npm test && npm run lint && npx tsc --noEmit" } }, { tool: "bash", args: { command: "npm run lint" } }, { tool: "bash", args: { command: "npx tsc --noEmit" } }, { assistant: "done" }]);
assert.deepEqual(ids(s), []); assert.deepEqual(s.audit.ran, { test: false, lint: true, typecheck: true, build: false }, "a combined command is classified by its first matching kind");
s = scenario([{ tool: "edit", args: { path: "/w/a.ts" } }, { tool: "bash", args: { command: "npm test" }, error: true, result: "FAIL" }, { assistant: "done" }]);
assert.equal(s.audit.ran.test, false, "a failing verification does not count as verified"); assert.equal(s.lastVerification.ok, false);

s = scenario([...Array.from({ length: 8 }, (_, i) => ({ tool: "edit", args: { path: `/w/${i}.ts` } })), { tool: "bash", args: { command: "npm test" } }]);
assert.deepEqual(ids(s), ["scope"]);
s = scenario([...Array.from({ length: 8 }, (_, i) => ({ tool: "edit", args: { path: `/w/${i}.ts` } })), { tool: "bash", args: { command: "npm test" } }, { user: "next" }, { tool: "edit", args: { path: "/w/z.ts" } }, { tool: "bash", args: { command: "npm test" } }]);
assert.deepEqual(ids(s), [], "scope counts only edits in the current turn");

s = scenario([{ assistant: "thinking", usage: { input: 1000, cacheRead: 160_000, output: 10 } }, { tool: "read", args: { path: "/w/a.ts" } }]);
assert.deepEqual(ids(s), ["context"]); assert.equal(s.context, 161_000); assert.equal(s.findings[0].level, "yellow");
s = scenario([{ assistant: "thinking", usage: { input: 1000, cacheRead: 185_000, output: 10 } }, { tool: "read", args: { path: "/w/a.ts" } }]);
assert.equal(s.findings[0].level, "red");
s = scenario([{ assistant: "thinking", usage: { input: 1000, cacheRead: 185_000, output: 10 } }, { tool: "read", args: { path: "/w/a.ts" } }], { contextLimit: 1_000_000 });
assert.deepEqual(ids(s), [], "--context-limit overrides the model-derived limit");
s = scenario([{ assistant: "thinking", usage: { input: 1000, cacheRead: 283_000, output: 10 } }, { tool: "read", args: { path: "/w/a.ts" } }]);
assert.equal(s.contextLimit, 1_000_000, "context above the assumed window implies the 1M window"); assert.deepEqual(ids(s), []);
{
  const ev = parseAll("claude", [JSON.stringify({ parentUuid: "x", isSidechain: false, type: "attachment", attachment: { type: "model", identity: { modelId: "claude-opus-5[1m]", marketingName: "Opus 5 (1M context)" } }, timestamp: claudeTs(), uuid: "m" })]);
  assert.deepEqual(ev.map(e => e.kind), ["model"]); assert.equal(ev[0].model, "claude-opus-5[1m]");
}

s = scenario([{ tool: "bash", args: { command: "cat > /w/gen.ts <<'EOF'\nx\nEOF" } }, { assistant: "done" }]);
assert.deepEqual(ids(s), ["unverified-stop"], "heredoc writes count as edits"); assert.deepEqual(s.editedFiles, ["/w/gen.ts"]);
s = scenario([{ tool: "edit", args: { path: "/w/a.ts" } }, { tool: "bash", args: { command: "cat > $S/pid <<EOF\nEOF" } }, { tool: "edit", args: { path: "/elsewhere/b.ts" } }], { cwd: "/w" });
assert.deepEqual(s.editedFiles, ["/w/a.ts"], "shell variables and out-of-project paths are dropped from the file list");

s = scenario([{ tool: "read", args: { path: "/w/a.ts" } }], { diff: { files: 3, added: 250, deleted: 80, untracked: 1, todoAdded: 0 } });
assert.deepEqual(ids(s), ["diff-size"]); assert.equal(s.findings[0].level, "yellow");
s = scenario([{ tool: "read", args: { path: "/w/a.ts" } }], { diff: { files: 3, added: 900, deleted: 200, untracked: 0, todoAdded: 2 } });
assert.deepEqual(ids(s), ["diff-size", "todo-added"]); assert.equal(s.level, "red");

s = scenario([{ tool: "read", args: { path: "/w/a.ts" } }], { now: piNow() + 11 * 60_000 });
assert.deepEqual(ids(s), ["stalled"]);
s = scenario([{ assistant: "done" }], { now: piNow() + 11 * 60_000 });
assert.deepEqual(ids(s), [], "waiting for the user is not a stall");

// heredoc bodies, doc edits and verification
s = scenario([{ tool: "edit", args: { path: "/w/a.ts" } }, { tool: "bash", args: { command: "python3 - <<'PY'\nfor m in ['websocket','playwright']:\n  print(m)\nPY" } }, { assistant: "done" }]);
assert.deepEqual(ids(s), ["unverified-stop"], "a test-like word inside a heredoc body is not a verification"); assert.equal(s.lastVerification, undefined);
s = scenario([{ tool: "edit", args: { path: "/w/README.md" } }, { tool: "edit", args: { path: "docs/design.md" } }, ...Array.from({ length: 30 }, () => ({ tool: "read", args: { path: `/w/${Math.random()}.ts` } })), { assistant: "書きました" }]);
assert.deepEqual(ids(s), [], "documentation-only edits never demand a test run"); assert.equal(s.editedFiles.length, 2);
s = scenario([{ tool: "edit", args: { path: "/w/README.md" } }, { tool: "edit", args: { path: "/w/src/a.ts" } }, { assistant: "done" }]);
assert.deepEqual(ids(s), ["unverified-stop"]); assert.equal(s.audit.editsSinceVerify, 1, "only the code edit counts");

// cache misses in OpenAI-style accounting (no cacheWrite; the miss is billed as fresh input) and after a model switch
{
  const lines = [pi.session(), pi.model(), pi.user("task"), pi.assistant("a", [], { input: 1000, cacheRead: 200_000, cacheWrite: 0, output: 100, reasoning: 0, cost: { total: 0.09 } }), JSON.stringify({ type: "model_change", id: "m2", timestamp: piTs(), provider: "openai-codex", modelId: "gpt-6.1-sol" }), pi.assistant("b", [], { input: 171_000, cacheRead: 0, cacheWrite: 0, output: 100, reasoning: 0, cost: { total: 0.345, input: 0.33, cacheRead: 0, cacheWrite: 0, output: 0.015 } }), pi.assistant("c", [], { input: 2000, cacheRead: 171_000, cacheWrite: 0, output: 100, reasoning: 0, cost: { total: 0.06 } })];
  const snap = analyze(parseAll("pi", lines), { now: piNow() });
  assert.equal(snap.cost.turns[0].misses.length, 1); assert.equal(snap.cost.turns[0].misses[0].cause, "model"); assert.equal(snap.cost.turns[0].misses[0].tokens, 171_000);
  assert.equal(snap.cost.cacheMisses, 1); assert.equal(snap.model, "openai-codex/gpt-6.1-sol");
  const finding = snap.findings.find(f => f.id === "cache-miss");
  assert.match(finding.message, /モデルを切り替えたため/); assert.match(finding.message, /約171kトークン/); assert.match(finding.message, /\$0\.33/, "extra cost is missed tokens at the paid rate, as pi computes it");
  // a small prefix change is noise, and a compaction legitimately changes the prompt
  const quiet = analyze(parseAll("pi", [pi.session(), pi.user("t"), pi.assistant("a", [], { input: 500, cacheRead: 50_000, cacheWrite: 0, output: 10, reasoning: 0 }), pi.assistant("b", [], { input: 800, cacheRead: 49_700, cacheWrite: 0, output: 10, reasoning: 0 })]), { now: piNow() });
  assert.equal(quiet.cost.cacheMisses, 0, "300 tokens below the noise floor");
  const compacted = analyze(parseAll("pi", [pi.session(), pi.user("t"), pi.assistant("a", [], { input: 500, cacheRead: 150_000, cacheWrite: 0, output: 10, reasoning: 0 }), pi.compaction(), pi.assistant("b", [], { input: 20_000, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0 })]), { now: piNow() });
  assert.equal(compacted.cost.cacheMisses, 0, "the first request after compaction is new content, not a miss");
  const noCache = analyze(parseAll("pi", [pi.session(), pi.user("t"), pi.assistant("a", [], { input: 50_000, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0 }), pi.assistant("b", [], { input: 51_000, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0 })]), { now: piNow() });
  assert.equal(noCache.cost.cacheMisses, 0, "a provider that never reports caching is not counted");
  // Claude Code: the changing tail of the prompt is re-created each call; that is churn, not a miss, and the ephemeral bucket tells the TTL
  const cc = (read, write, ttl1h = true) => claude.assistant("", [], { input_tokens: 5, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 20, cache_creation: { ephemeral_1h_input_tokens: ttl1h ? write : 0, ephemeral_5m_input_tokens: ttl1h ? 0 : write } });
  const churny = analyze(parseAll("claude", [claude.system(), claude.user("t"), cc(0, 200_000), cc(197_000, 6_000), cc(203_000, 4_000), cc(0, 210_000)]), { now: BASE + 60_000 });
  assert.equal(churny.cost.cacheMisses, 1, "only the full rewrite counts as a miss"); assert.equal(churny.cost.churnTokens, 3_005, "small rewrites accumulate as churn (the third call is under the noise floor)");
  assert.equal(churny.cost.cacheTtlMs, 3_600_000, "Claude Code subscription cache lifetime is read from the usage record");
  assert.equal(churny.cost.turns[0].misses[0].cause, "unknown");
  const fiveMin = analyze(parseAll("claude", [claude.system(), claude.user("t"), cc(0, 200_000, false)]), { now: BASE + 60_000 });
  assert.equal(fiveMin.cost.cacheTtlMs, 300_000);
  const piDefault = analyze(parseAll("pi", [pi.session(), pi.user("t"), pi.assistant("a", [], { input: 10, cacheRead: 100, cacheWrite: 0, output: 1, reasoning: 0 })]), { now: piNow() });
  assert.equal(piDefault.cost.cacheTtlMs, 300_000, "pi sessions default to the 5 minute API lifetime");
  const cycling = analyze(parseAll("pi", [pi.session(), pi.model(), JSON.stringify({ type: "model_change", id: "m3", timestamp: piTs(), provider: "openai-codex", modelId: "gpt-5.6-terra" }), pi.user("task"), pi.assistant("a", [], { input: 30_000, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0 })]), { now: piNow() });
  assert.deepEqual(ids(cycling), [], "model cycling before the first call is not a miss, and neither is the first call itself");
}

// cost signals
{
  const lines = [pi.session(), JSON.stringify({ type: "thinking_level_change", id: "t", timestamp: piTs(), thinkingLevel: "xhigh" }), pi.user("task"), pi.assistant("a", [], { input: 30_000, cacheRead: 0, cacheWrite: 0, output: 200, reasoning: 100, cost: { total: 0.1 } }), pi.assistant("b", [], { input: 100, cacheRead: 30_000, cacheWrite: 1_000, output: 100, reasoning: 0, cost: { total: 0.02 } })];
  // second turn after a 90 minute gap: the first call rewrites the context (cache miss)
  piCounter += 90 * 60;
  lines.push(pi.user("next"), pi.assistant("c", [], { input: 100, cacheRead: 0, cacheWrite: 31_000, output: 300, reasoning: 250, cost: { total: 0.2 } }));
  const snap = analyze(parseAll("pi", lines), { now: piNow() });
  assert.equal(snap.cost.turns.length, 2);
  assert.equal(snap.cost.turns[0].modelCalls, 2); assert.equal(snap.cost.turns[0].cacheMiss, false, "the very first call of a session is not a miss");
  assert.equal(snap.cost.turns[1].cacheMiss, true); assert.equal(Math.round(snap.cost.turns[1].idleBeforeMs / 60000), 90); assert.equal(snap.cost.turns[1].misses[0].cause, "idle");
  assert.equal(snap.cost.totals.cost.toFixed(2), "0.32"); assert.equal(snap.cost.totals.thinking, 350); assert.equal(snap.cost.thinkingLevel, "xhigh");
  assert.ok(ids(snap).includes("cache-miss")); assert.match(snap.findings.find(f => f.id === "cache-miss").message, /90分の中断/);
  const short = analyze(parseAll("pi", lines), { now: piNow(), cacheTtlMs: 120 * 60 * 1000 });
  assert.equal(short.cost.turns[1].misses[0].cause, "unknown", "a rewrite after a gap shorter than the cache lifetime is still a miss, with no idle attribution");
  assert.match(short.findings.find(f => f.id === "cache-miss").message, /^キャッシュが効かず/);
  const chatty = [pi.session(), pi.user("t1"), pi.assistant("x", [], { input: 1000, cacheRead: 0, cacheWrite: 0, output: 5000, reasoning: 4000 }), pi.user("t2"), pi.assistant("y", [], { input: 100, cacheRead: 1000, cacheWrite: 0, output: 6000, reasoning: 5000 })];
  const heavy = analyze(parseAll("pi", chatty), { now: piNow() });
  assert.ok(ids(heavy).includes("output-heavy")); assert.ok(heavy.cost.outputShare > 0.9);
  const busy = [pi.session(), pi.user("t")];
  for (let i = 0; i < 25; i++) busy.push(pi.assistant("", [[`b${i}`, "read", { path: `/w/${i}.ts` }]], { input: 10, cacheRead: 1000, cacheWrite: 0, output: 10, reasoning: 0 }), pi.result(`b${i}`, "read", "ok"));
  const many = analyze(parseAll("pi", busy), { now: piNow() });
  assert.ok(ids(many).includes("turn-cost")); assert.equal(many.cost.turns[0].modelCalls, 25); assert.equal(many.cost.turns[0].toolCalls, 25);
}

// sidechain (subagent) activity must not trigger main-session findings
{
  const lines = [claude.system(), claude.user("task")];
  for (let i = 0; i < 3; i++) { lines.push(claude.assistant("", [[`s${i}`, "Bash", { command: "npm test" }]], undefined, true)); lines.push(claude.result(`s${i}`, "FAIL x", true, undefined, true)); }
  const snap = analyze(parseAll("claude", lines), { now: BASE + 60_000 });
  assert.deepEqual(ids(snap), []); assert.equal(snap.toolCalls, 0);
}

// --- advisor ---
{
  const red = scenario(Array.from({ length: 3 }, () => ({ tool: "bash", args: { command: "npm test" }, result: "FAIL expected 1 got 2", error: true })));
  const summary = buildSummary(red);
  assert.equal(summary.goal, "task"); assert.deepEqual(summary.cumulativeTests, { runs: 3, failures: 3 }); assert.equal(summary.lastVerification.passed, false); assert.equal(summary.editsSinceLastVerification, 0); assert.ok(summary.deterministicFindings.some(f => f.id === "error-loop"));
  assert.match(buildPrompt(summary), /verdict: one of "CONTINUE"/);
  const advice = parseAdvice('Sure:\n{"verdict":"replan","reason":"同じ失敗","suggestion":"仮説を整理して","progress":"40","requirementCovered":"no","reportMatchesActions":"maybe","costVerdict":"wasted_turns","costReason":"3回","costSuggestion":"effort を上げる"}', "m", 5);
  assert.deepEqual(advice, { verdict: "REPLAN", reason: "同じ失敗", suggestion: "仮説を整理して", progress: 40, requirementCovered: "no", reportMatchesActions: "unknown", costVerdict: "WASTED_TURNS", costReason: "3回", costSuggestion: "effort を上げる", model: "m", at: 5 });
  assert.equal(parseAdvice('{"verdict":"CONTINUE","costVerdict":"bogus"}').costVerdict, undefined);
  assert.match(buildPrompt(summary), /cheapest turn/); assert.ok(summary.cost.recentTurns.length >= 1); assert.equal(typeof summary.cost.outputShareOfWeightedCost, "number");
  assert.equal(parseAdvice('{"verdict":"WHATEVER"}'), undefined);
  assert.equal(parseAdvice("no json"), undefined);
  assert.equal(extractBackendText("claude", JSON.stringify({ type: "result", result: '{"verdict":"CONTINUE"}' })), '{"verdict":"CONTINUE"}');
  assert.equal(extractBackendText("pi", "raw"), "raw");
  assert.equal(backendCommand("pi", "m", "p").input, "p", "pi receives the prompt on stdin");
  assert.ok(!backendCommand("pi", "m", "p").args.includes("p"));
  assert.equal(backendCommand("claude", "m", "p").input, "p");
  const green = scenario([{ tool: "read", args: { path: "/w/a.ts" } }]);
  assert.equal(shouldAdvise(undefined, green, "g", undefined, 0, 30_000), false, "green and not turn-ended: no call");
  assert.equal(shouldAdvise(undefined, red, "r", undefined, 0, 30_000), true);
  assert.equal(shouldAdvise("r", red, "r", undefined, 0, 30_000), false, "unchanged signature: no call");
  assert.equal(shouldAdvise("r0", red, "r", 0, 10_000, 30_000), false, "rate limited");
  const ended = scenario([{ tool: "edit", args: { path: "/w/a.ts" } }, { tool: "bash", args: { command: "npm test" } }, { assistant: "done" }]);
  assert.equal(shouldAdvise(undefined, ended, "e", undefined, 0, 30_000), true, "turn end triggers a call even when green");
  const calls = [];
  const runner = async (program, args, options) => { calls.push({ program, args, options }); return { code: 0, stdout: '{"verdict":"VERIFY","reason":"r","suggestion":"s","progress":50}', stderr: "" }; };
  const advisor = new Advisor({ backend: "pi", runner, minIntervalMs: 1000 });
  const first = await advisor.maybeAdvise(red, "sig1", 0);
  assert.equal(first.verdict, "VERIFY"); assert.equal(calls.length, 1); assert.equal(advisor.latest.forSignature, "sig1"); assert.equal(calls[0].program, "pi"); assert.equal(advisor.latest.model, "google-vertex/gemini-3.8-flash");
  assert.equal(await advisor.maybeAdvise(red, "sig1", 5), undefined, "same signature is not re-asked");
  assert.equal(await advisor.maybeAdvise(red, "sig2", 10), undefined, "rate limit holds");
  assert.equal((await advisor.maybeAdvise(red, "sig2", 2000)).verdict, "VERIFY");
  const failing = new Advisor({ backend: "claude", runner: async () => ({ code: 1, stdout: "", stderr: "boom" }) });
  assert.equal(await failing.maybeAdvise(red, "x", 0), undefined); assert.match(failing.error, /exited 1/);
  assert.equal(new Advisor({ backend: "none" }).enabled, false);
}

// --- probes with a fake runner ---
{
  const fakeGit = async (program, args) => {
    if (args[0] === "diff" && args[1] === "--numstat") return { code: 0, stdout: "10\t2\ta.ts\n-\t-\tbin.png\n3\t0\tb.ts\n", stderr: "" };
    if (args[0] === "status") return { code: 0, stdout: "?? new.ts\n M a.ts\n?? other.md\n", stderr: "" };
    if (args[0] === "diff" && args[1] === "-U0") return { code: 0, stdout: "+++ b/a.ts\n+// TODO later\n+ok\n-// TODO removed\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
  assert.deepEqual(await gitDiffStat("/repo", fakeGit), { files: 3, added: 13, deleted: 2, untracked: 2, todoAdded: 1 });
  const proj = await fs.mkdtemp(path.join(os.tmpdir(), "observer-proj-"));
  assert.deepEqual(await projectChecks(proj), []);
  await fs.writeFile(path.join(proj, "package.json"), JSON.stringify({ scripts: { test: "x", "lint": "eslint ." }, devDependencies: { typescript: "5" } }));
  assert.deepEqual((await projectChecks(proj)).sort(), ["lint", "test", "typecheck"]);
  await fs.rm(proj, { recursive: true, force: true });
  assert.equal(await gitDiffStat("/repo", async () => ({ code: 128, stdout: "", stderr: "not a git repo" })), undefined);
  const paneJson = JSON.stringify({ id: "x", result: { pane: { pane_id: "w1:p2", agent: "claude", agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "abc" }, cwd: "/repo", foreground_cwd: "/repo/sub" } } });
  const herdr = async (program, args) => ({ code: 0, stdout: args[1] === "current" || args[1] === "get" ? paneJson : "", stderr: "" });
  assert.deepEqual(await herdrPaneSession("current", herdr), { paneId: "w1:p2", agent: "claude", kind: "id", value: "abc", cwd: "/repo/sub" });
  assert.equal(await herdrPaneSession("w9:p9", async () => ({ code: 1, stdout: "", stderr: "no" })), undefined);
  const dry = await openObserverPane("cmd", { dryRun: true });
  assert.deepEqual(dry.commands[0], ["herdr", "pane", "split", "--current", "--direction", "down", "--ratio", "0.3", "--no-focus"]);
  const seen = [];
  const splitRunner = async (program, args) => { seen.push(args); return { code: 0, stdout: args[1] === "split" ? JSON.stringify({ result: { pane: { pane_id: "w1:p3" } } }) : "", stderr: "" }; };
  const opened = await openObserverPane("cmd", { ratio: 0.25, runner: splitRunner });
  assert.equal(opened.paneId, "w1:p3"); assert.deepEqual(seen[1], ["pane", "run", "w1:p3", "cmd"]);
}

// --- hooks ---
{
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "observer-state-"));
  const notes = [];
  const notify = (title, body) => notes.push([title, body]);
  const start = await handleHook({ hook_event_name: "SessionStart", session_id: "sid", transcript_path: "/t.jsonl", cwd: "/repo", source: "startup" }, { stateDir, notify, env: { HERDR_PANE_ID: "w1:p1" } });
  assert.equal(JSON.parse(await fs.readFile(start.recorded, "utf8")).pane, "w1:p1");
  const note = await handleHook({ hook_event_name: "Notification", session_id: "sid", message: "permission needed" }, { stateDir, notify });
  assert.equal(note.notified, true); assert.deepEqual(notes.at(-1), ["Claude Code", "permission needed"]);
  assert.deepEqual(await handleHook({ hook_event_name: "Stop", session_id: "sub", agent_id: "agent-1" }, { stateDir, notify }), { event: "Stop" }, "subagent hooks are ignored");
  const transcript = path.join(stateDir, "t.jsonl");
  await fs.writeFile(transcript, [claude.system(), claude.user("task"), claude.assistant("", [["e1", "Edit", { file_path: "/repo/a.ts" }]]), claude.result("e1", "ok"), claude.assistant("実装できました")].join("\n") + "\n");
  const stop = await handleHook({ hook_event_name: "Stop", session_id: "sid", transcript_path: transcript, cwd: "/repo" }, { stateDir, notify, runner: async () => ({ code: 128, stdout: "", stderr: "" }), now: () => BASE + 60_000 });
  assert.equal(stop.snapshot.level, "yellow"); assert.ok(stop.notified); assert.match(notes.at(-1)[0], /終了時監査 yellow/);
  assert.deepEqual(JSON.parse(await fs.readFile(stop.recorded, "utf8")).findings.map(f => f.id), ["unverified-stop"]);
  const settings = path.join(stateDir, "settings.json");
  await fs.writeFile(settings, JSON.stringify({ model: "x", hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "afplay a.aiff" }] }] } }));
  const installed = await installHooks(settings, "/bin/yorishiro-observe", new Date(BASE));
  assert.equal(installed.changed, true); assert.ok(installed.backup);
  const merged = JSON.parse(await fs.readFile(settings, "utf8"));
  assert.equal(merged.model, "x"); assert.equal(merged.hooks.Stop.length, 2, "existing hooks are kept"); assert.equal(merged.hooks.Stop[1].hooks[0].command, "/bin/yorishiro-observe hook");
  assert.equal(merged.hooks.SessionStart[0].matcher, "*"); assert.equal(merged.hooks.Notification.length, 1);
  assert.deepEqual(await installHooks(settings, "/bin/yorishiro-observe"), { changed: false }, "second install is a no-op");
  await fs.rm(stateDir, { recursive: true, force: true });
}

// --- render and args ---
{
  s = scenario([{ tool: "edit", args: { path: "/w/a.ts" } }, { assistant: "done" }]);
  const text = render(s, { file: "/x.jsonl", format: "pi", now: BASE, advice: { verdict: "REPLAN", reason: "r", suggestion: "s", progress: 30, requirementCovered: "no", reportMatchesActions: "unknown", model: "m", at: BASE } });
  assert.match(text, /^● 黄/, "verdict comes first"); assert.match(text, /Cost: fresh/);
  const withCost = render(s, { file: "/x.jsonl", format: "pi", now: BASE, advice: { verdict: "CONTINUE", reason: "", suggestion: "", costVerdict: "EFFORT_TOO_HIGH", costReason: "xhigh で rename", costSuggestion: "medium に下げる", model: "m", at: BASE } });
  assert.match(withCost, /コスト: EFFORT_TOO_HIGH — effort 高すぎ   xhigh で rename/); assert.match(withCost, /運転の変え方: medium に下げる/); assert.match(text, /REPLAN — 計画を見直させる/); assert.match(text, /進捗 30%/); assert.match(text, /> s/); assert.match(text, /変更ファイル:/);
  const small = render(s, { file: "/x.jsonl", format: "pi", now: BASE, rows: 12, columns: 100 });
  assert.ok(small.split("\n").length <= 12, "output fits the pane height"); assert.match(small, /^● 黄/); assert.doesNotMatch(small, /直近の動き/, "trailing lists are cut first");
  assert.ok(render(s, { file: "/x.jsonl", format: "pi", now: BASE, columns: 40 }).split("\n").every(line => line.length <= 40), "long lines are wrapped to the column width");
  const args = parseArgs(["--claude", "--once", "--json", "--interval", "250", "--verify", "^make", "--pane", "current", "--advisor", "none", "--context-limit", "1000000", "/tmp/s.jsonl"], {});
  assert.deepEqual([args.format, args.once, args.json, args.interval, args.file, args.pane, args.advisor, args.contextLimit], ["claude", true, true, 250, "/tmp/s.jsonl", "current", "none", 1_000_000]);
  assert.ok(args.verify.test("make check"));
  assert.equal(parseArgs([], {}).advisor, "pi");
  assert.equal(parseArgs([], { YORISHIRO_OBSERVER_ADVISOR: "none" }).advisor, "none");
  assert.equal(parseArgs(["hook"], {}).command, "hook");
  assert.equal(parseArgs(["--open-pane", "0.4", "--dry-run"], {}).openPane, 0.4);
  assert.equal(parseArgs(["--open-pane", "--notify"], {}).openPane, 0.3);
  assert.throws(() => parseArgs(["--bogus"], {}), /unknown option/);
  assert.throws(() => parseArgs(["--advisor", "gpt"], {}), /--advisor must be/);
}
// --- slash commands and /clear succession ---
{
  const cmd = text => JSON.stringify({ parentUuid: "0", isSidechain: false, type: "user", message: { role: "user", content: text }, timestamp: claudeTs(), uuid: "c" });
  const ev = parseAll("claude", [cmd("<command-name>/clear</command-name>\n<command-message>clear</command-message>"), cmd("<local-command-caveat>Caveat: ...</local-command-caveat>"), cmd("<command-name>/model</command-name>\n<command-args>opus</command-args>")]);
  assert.deepEqual(ev.map(e => [e.kind, e.name]), [["command", "clear"], ["command", "model"]]);
  const fresh = analyze(parseAll("claude", [claude.system(), cmd("<command-name>/clear</command-name>")]), { now: BASE + 60_000 });
  assert.equal(fresh.startedBy, "clear"); assert.equal(fresh.turns, 0); assert.equal(fresh.phase, "idle");
  const freshWithDiff = analyze(parseAll("claude", [claude.system(), cmd("<command-name>/clear</command-name>")]), { now: BASE + 60_000, diff: { files: 9, added: 2000, deleted: 10, untracked: 0, todoAdded: 3 } });
  assert.deepEqual(freshWithDiff.findings, [], "a session without any prompt gets no findings, even with a dirty working tree"); assert.equal(freshWithDiff.level, "green");
  const notFresh = analyze(parseAll("claude", [claude.system(), claude.user("hi"), claude.assistant("ok"), cmd("<command-name>/clear</command-name>")]), { now: BASE + 60_000 });
  assert.equal(notFresh.startedBy, undefined, "/clear typed later in a session does not mark it as clear-started"); assert.equal(notFresh.turns, 1);
  const view = (id, cwd, snapshot, mtime) => ({ id, file: id, format: "claude", cwd, mtime, snapshot, signature: "" });
  const old = analyze(parseAll("claude", [claude.system(), claude.user("work"), claude.assistant("", [["e1", "Edit", { file_path: "/work/a.ts" }]]), claude.result("e1", "ok"), claude.assistant("done")]), { now: BASE + 60_000 });
  const other = analyze(parseAll("claude", [claude.system(), claude.user("parallel"), claude.assistant("ok")]), { now: BASE + 60_000 });
  const linked = linkSupersededSessions([view("old", "/work", old, 1), view("new", "/work", fresh, 3), view("elsewhere", "/other", other, 2)]);
  const byId = Object.fromEntries(linked.map(v => [v.id, v]));
  assert.equal(byId.old.snapshot.supersededBy, "new"); assert.equal(byId.old.snapshot.phase, "ended"); assert.deepEqual(byId.old.snapshot.findings, []);
  assert.equal(byId.elsewhere.snapshot.supersededBy, undefined, "sessions in other projects are untouched");
  assert.equal(byId.new.snapshot.supersededBy, undefined);
  // pi: a fresh session shortly after another one in the same project replaces it; a fresh session hours later does not
  const piOld = analyze(parseAll("pi", [pi.session(), pi.user("work"), pi.assistant("done")]), { now: piNow() });
  const piFresh = analyze(parseAll("pi", [pi.session()]), { now: piNow() });
  const piViews = linkSupersededSessions([{ ...view("po", "/work", piOld, 1), format: "pi" }, { ...view("pn", "/work", piFresh, 2), format: "pi" }]);
  assert.equal(piViews.find(v => v.id === "po").snapshot.supersededBy, "pn"); assert.equal(piViews.find(v => v.id === "pn").snapshot.startedBy, "new");
  piCounter += 30 * 60;
  const piLater = analyze(parseAll("pi", [pi.session()]), { now: piNow() });
  const piViews2 = linkSupersededSessions([{ ...view("po", "/work", piOld, 1), format: "pi" }, { ...view("pl", "/work", piLater, 2), format: "pi" }]);
  assert.equal(piViews2.find(v => v.id === "po").snapshot.supersededBy, undefined, "30 minutes later is a new piece of work, not a replacement");
  assert.equal(piViews2.find(v => v.id === "pl").snapshot.startedBy, undefined);
}

// --- dashboard server: discovery, hub, HTTP API, SSE ---
{
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "observer-web-"));
  const cwd = "/work";
  await fs.mkdir(piSessionDir(cwd, home), { recursive: true }); await fs.mkdir(claudeProjectDir(cwd, home), { recursive: true });
  const piFile = path.join(piSessionDir(cwd, home), "2026-01-01T00-00-00-000Z_p1.jsonl");
  await fs.writeFile(piFile, [pi.session(), pi.user("task"), pi.assistant("", [["q1", "edit", { path: "/work/a.ts" }]]), pi.result("q1", "edit", "ok"), pi.assistant("done")].join("\n") + "\n");
  const claudeFile = path.join(claudeProjectDir(cwd, home), "c1.jsonl");
  await fs.writeFile(claudeFile, [claude.system(), claude.user("hi"), claude.assistant("ok")].join("\n") + "\n");
  const old = path.join(claudeProjectDir(cwd, home), "old.jsonl"); await fs.writeFile(old, "{}\n"); const past = new Date(Date.now() - 48 * 3600e3); await fs.utimes(old, past, past);
  const found = await discoverSessions(24 * 3600e3, home);
  assert.deepEqual(found.map(f => f.id).sort(), ["c1", "p1"], "recent sessions from both stores, stale ones excluded");
  const runner = async (program, args) => program === "herdr" ? { code: 0, stdout: JSON.stringify({ result: { panes: [{ pane_id: "w1:p1", agent_session: { value: "c1" } }] } }), stderr: "" } : { code: 128, stdout: "", stderr: "" };
  const hub = new SessionHub({ port: 0, host: "127.0.0.1", withinMs: 24 * 3600e3, advisor: "none", notify: false, pollMs: 1000, home, runner });
  await hub.tick();
  const views = hub.views();
  assert.equal(views.length, 2);
  const c = views.find(v => v.id === "c1"), p = views.find(v => v.id === "p1");
  assert.equal(c.cwd, "/work", "claude cwd comes from the first transcript record"); assert.equal(c.pane, "w1:p1", "herdr pane mapping is attached");
  assert.equal(p.snapshot.level, "yellow"); assert.deepEqual(p.snapshot.findings.map(f => f.id), ["unverified-stop"]);
  // stale sessions must not trigger classifier calls on startup
  let advised = 0;
  const staleHub = new SessionHub({ port: 0, host: "127.0.0.1", withinMs: 24 * 3600e3, advisor: "pi", notify: false, pollMs: 1000, home, runner: async (program, args) => { if (program === "pi") { advised++; return { code: 0, stdout: '{"verdict":"VERIFY"}', stderr: "" }; } return runner(program, args); } });
  await staleHub.tick(); await new Promise(r => setTimeout(r, 50));
  assert.equal(advised, 0, "fixture timestamps are old, so no classifier call");
  let pushed = 0; const unsubscribe = hub.subscribe(() => pushed++);
  await fs.appendFile(piFile, pi.user("more") + "\n"); await hub.tick();
  assert.ok(pushed >= 1, "listeners are notified when a session changes"); unsubscribe();
  const server = createServer(hub, { port: 0, host: "127.0.0.1", withinMs: 0, advisor: "none", notify: false, pollMs: 1000 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = await (await fetch(`${base}/api/sessions`)).json();
  assert.equal(api.sessions.length, 2); assert.equal(api.advisor, null);
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<!doctype html>/); assert.match(html, /\/api\/events/);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  const controller = new AbortController();
  const sse = await fetch(`${base}/api/events`, { signal: controller.signal });
  const reader = sse.body.getReader(); const chunk = new TextDecoder().decode((await reader.read()).value);
  assert.match(chunk, /^data: \{"generatedAt"/); controller.abort();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(home, { recursive: true, force: true });
}
console.log("observer tests passed");
