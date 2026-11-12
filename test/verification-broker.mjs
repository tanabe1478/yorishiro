import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// run_verification_command asks the orchestrator, which runs the command. This test uses a stand-in for
// runSandboxedVerification (the broker takes it as an option), so it runs inside the quality gate's own sandbox too.
// The real function, with the real environment of the orchestrator, is test/verification-broker-sandbox.mjs.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = name => path.join(root, "extensions", "development-pipeline", name);
const { startVerificationBroker, evidenceOwnerForStage } = await import(ext("verification-broker.ts"));
const requests = await import(ext("verification-requests.ts"));
const { default: loadVerifier } = await import(ext("verifier-tools.ts"));
const { MAX_CHECK_TIMEOUT_MS } = await import(ext("quality-contract.ts"));

const tools = []; loadVerifier({ registerTool: tool => tools.push(tool) });
const tool = tools.find(item => item.name === "run_verification_command");
const base = await mkdtemp(path.join(os.tmpdir(), "yorishiro-verification-broker-"));
const savedEnv = { ...process.env };
Object.assign(process.env, { YORISHIRO_VERIFICATION_POLL_MS: "10", YORISHIRO_VERIFICATION_RESPONSE_MARGIN_MS: "300", YORISHIRO_VERIFICATION_CANCEL_GRACE_MS: "300" });
let counter = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const outcome = (stdout = "", extra = {}) => ({ code: 0, stdout, stderr: "", truncated: false, cancelled: false, timedOut: false, ...extra });

/** A broker with a stand-in runner that records its calls. */
async function broker({ stage = "review", repositories, run } = {}) {
  const dir = path.join(base, `run-${++counter}`);
  const calls = [];
  const instance = await startVerificationBroker({
    requestDir: requests.verificationRequestDir(dir, stage), evidenceRoot: path.join(dir, "evidence"), stage, cwd: path.join(base, "target"), ...(repositories ? { repositories } : {}), pollMs: 10,
    run: async (program, args, cwd, timeoutMs, signal, options) => { calls.push({ program, args, cwd, timeoutMs, options }); return run ? run({ program, args, cwd, timeoutMs, signal, options }) : outcome(`ran ${program}`, { evidenceDir: options.evidenceDir }); },
  });
  return { ...instance, dir, calls };
}
const call = (instance, input, signal = new AbortController().signal) => {
  process.env.YORISHIRO_VERIFICATION_REQUEST_DIR = instance.requestDir;
  return tool.execute("t", input, signal);
};
/** Write a request file the way the tool does, but with any content, and wait for the orchestrator's answer. */
async function rawRequest(instance, id, content) {
  await writeFile(requests.requestFile(instance.requestDir, id), typeof content === "string" ? content : JSON.stringify(content));
  for (let i = 0; i < 300; i++) { await sleep(10); if (existsSync(requests.resultFile(instance.requestDir, id))) return JSON.parse(await readFile(requests.resultFile(instance.requestDir, id), "utf8")); }
  throw new Error(`no answer for ${id}`);
}

try {
  // ---- the stage decides where evidence goes
  assert.equal(evidenceOwnerForStage("implement"), "worker-verification");
  assert.equal(evidenceOwnerForStage("review"), "reviewer");
  for (const [stage, owner] of [["implement", "worker-verification"], ["review", "reviewer"]]) {
    const b = await broker({ stage });
    try {
      const result = await call(b, { program: "/bin/echo", args: ["x"] });
      assert.match(result.content[0].text, /^ran \/bin\/echo/);
      const [file] = (await readdir(b.requestDir)).filter(name => name.endsWith(".result.json"));
      const answer = JSON.parse(await readFile(path.join(b.requestDir, file), "utf8"));
      assert.equal(answer.owner, owner);
      assert.equal(path.dirname(answer.evidenceDir), path.join(b.dir, "evidence", owner), `${stage} evidence goes under ${owner}/`);
      assert.equal(b.calls[0].options.evidenceDir, answer.evidenceDir);
      // The request cannot pick the owner: an unknown field is refused, and the request has no owner field.
      const forged = await rawRequest(b, "forged-1", { program: "/bin/echo", args: [], owner: "reviewer" });
      assert.equal(forged.status, "rejected"); assert.match(forged.error, /unknown field: owner/);
      assert.equal(b.calls.length, 1, "the refused request was not run");
    } finally { await b.stop(); }
  }

  // ---- the same rules as before, applied before anything runs
  {
    const b = await broker({ repositories: ["api", "backend"] });
    try {
      const bad = [
        ["timeoutMs over the maximum", { program: "/bin/echo", args: [], timeoutMs: MAX_CHECK_TIMEOUT_MS + 1 }, /timeoutMs must be an integer from 1000 to 1800000/],
        ["timeoutMs under the minimum", { program: "/bin/echo", args: [], timeoutMs: 999 }, /timeoutMs/],
        ["timeoutMs not an integer", { program: "/bin/echo", args: [], timeoutMs: 1500.5 }, /timeoutMs/],
        ["timeoutMs a string", { program: "/bin/echo", args: [], timeoutMs: "5000" }, /timeoutMs/],
        ["cwd outside the repositories", { program: "/bin/echo", args: [], cwd: "docs" }, /one of repositories or inside one: docs/],
        ["cwd going up", { program: "/bin/echo", args: [], cwd: "../api" }, /one of repositories or inside one/],
        ["cwd absolute", { program: "/bin/echo", args: [], cwd: "/etc" }, /one of repositories or inside one/],
        ["cwd not a string", { program: "/bin/echo", args: [], cwd: 7 }, /cwd must be a string/],
        ["program not a string", { program: 7, args: [] }, /program must be a non-empty string/],
        ["program empty", { program: "", args: [] }, /program must be a non-empty string/],
        ["args not an array", { program: "/bin/echo", args: "x" }, /args must be an array of strings/],
        ["args with a non-string", { program: "/bin/echo", args: ["a", 1] }, /args must be an array of strings/],
        ["not an object", ["/bin/echo"], /must be a JSON object/],
        ["not JSON", "{nope", /not valid JSON/],
      ];
      for (const [index, [name, content, expected]] of bad.entries()) {
        const answer = await rawRequest(b, `bad-${index}`, content);
        assert.equal(answer.status, "rejected", name);
        assert.match(answer.error, expected, name);
      }
      assert.equal(b.calls.length, 0, "no refused request reached the runner");
      // valid ones: cwd inside a repository, the boundary values of timeoutMs
      for (const [index, content] of [{ program: "/bin/echo", args: [], cwd: "backend/src" }, { program: "/bin/echo", args: [], timeoutMs: 1000 }, { program: "/bin/echo", args: [], timeoutMs: MAX_CHECK_TIMEOUT_MS }].entries()) assert.equal((await rawRequest(b, `good-${index}`, content)).status, "completed");
      assert.deepEqual(b.calls.map(item => [item.timeoutMs, item.options.workdir, item.options.repositories]), [[120000, "backend/src", ["api", "backend"]], [1000, undefined, ["api", "backend"]], [MAX_CHECK_TIMEOUT_MS, undefined, ["api", "backend"]]], "the default timeout, the cwd and the run's repositories reach the runner");
      // a request that is not a small regular file
      await writeFile(requests.requestFile(b.requestDir, "huge"), "x".repeat(requests.MAX_REQUEST_BYTES + 1));
      for (let i = 0; i < 300 && !existsSync(requests.resultFile(b.requestDir, "huge")); i++) await sleep(10);
      assert.match(JSON.parse(await readFile(requests.resultFile(b.requestDir, "huge"), "utf8")).error, /regular file of at most 1 MiB/);
    } finally { await b.stop(); }
    // without repositories a cwd is refused
    const single = await broker();
    try { assert.match((await rawRequest(single, "c-1", { program: "/bin/echo", args: [], cwd: "api" })).error, /only allowed when the run has repositories/); assert.equal(single.calls.length, 0); }
    finally { await single.stop(); }
    // the tool refuses what it can see itself, without writing a request
    const toolBroker = await broker();
    try {
      await assert.rejects(() => call(toolBroker, { program: "/bin/echo", args: [], timeoutMs: MAX_CHECK_TIMEOUT_MS + 1 }), /timeoutMs must be an integer/);
      await assert.rejects(() => call(toolBroker, { program: "/bin/echo", args: [7] }), /args must be an array of strings/);
      assert.equal((await readdir(toolBroker.requestDir)).some(name => name.endsWith(".request.json")), false, "nothing was written");
    } finally { await toolBroker.stop(); }
  }

  // ---- the tool does not run anything itself and does not fall back to doing so
  {
    delete process.env.YORISHIRO_VERIFICATION_REQUEST_DIR;
    await assert.rejects(() => tool.execute("t", { program: "/usr/bin/touch", args: [path.join(base, "must-not-exist")] }, new AbortController().signal), /YORISHIRO_VERIFICATION_REQUEST_DIR is not set/);
    assert.equal(existsSync(path.join(base, "must-not-exist")), false, "without the variable the command is not run in this process");
    process.env.YORISHIRO_VERIFICATION_REQUEST_DIR = "relative/dir";
    await assert.rejects(() => tool.execute("t", { program: "/bin/echo", args: [] }, new AbortController().signal), /absolute path/);
    // a directory nobody watches (the stage is over, or no pipeline)
    const empty = path.join(base, "nobody"); await mkdir(empty);
    process.env.YORISHIRO_VERIFICATION_REQUEST_DIR = empty;
    await assert.rejects(() => tool.execute("t", { program: "/usr/bin/touch", args: [path.join(base, "must-not-exist")] }, new AbortController().signal), /not accepting verification requests/);
    assert.equal(existsSync(path.join(base, "must-not-exist")), false);
  }

  // ---- the output keeps its shape; failures of the runner are errors of the tool
  {
    const b = await broker({ run: ({ program }) => { if (program === "boom") throw new Error("preflight said no"); return outcome("out", { code: program === "fail" ? 3 : 0, stderr: "err", evidenceDir: path.join(base, "e"), evidence: { status: "empty", files: [], skipped: [], bytes: 0, truncated: false, visited: 1, skippedCount: 0 } }); } });
    try {
      const ok = await call(b, { program: "ok", args: [] });
      // The directory is the orchestrator's choice (evidence/<owner>/<request id>), whatever the runner reports.
      assert.match(ok.content[0].text, new RegExp(`^outerr\\n\\[evidence 0 files; skipped=0; truncated=no; dir=${path.join(b.dir, "evidence", "reviewer").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[0-9]+-[0-9]+-[0-9]+\\]\\n\\[verification EXIT exit=0\\]$`));
      assert.deepEqual([ok.details.exitCode, ok.details.sandboxed, ok.details.timedOut, ok.details.cancelled, ok.details.evidenceIncomplete], [0, true, false, false, false]);
      assert.match((await call(b, { program: "fail", args: [] })).content[0].text, /\[verification EXIT exit=3\]$/);
      await assert.rejects(() => call(b, { program: "boom", args: [] }), /preflight said no/);
    } finally { await b.stop(); }
  }

  // ---- requests run one at a time, in the order they were made, and every one is answered
  {
    let active = 0, maxActive = 0;
    const b = await broker({ run: async ({ program }) => { active++; maxActive = Math.max(maxActive, active); await sleep(program === "slow" ? 150 : 10); active--; return outcome(program); } });
    try {
      const results = await Promise.all([call(b, { program: "slow", args: [] }), call(b, { program: "a", args: [] }), call(b, { program: "b", args: [] })]);
      assert.deepEqual(results.map(result => result.content[0].text.split("\n")[0]), ["slow", "a", "b"]);
      assert.equal(maxActive, 1, "no two commands (and so no two snapshots) at the same time");
      assert.deepEqual(b.calls.map(item => item.program), ["slow", "a", "b"], "in the order the requests were made");
    } finally { await b.stop(); }
  }

  // ---- a request that waits behind a running one is answered when it is cancelled or runs out of time, and is not run afterwards
  {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const b = await broker({ run: async ({ program, signal }) => {
      if (program === "first") { await Promise.race([gate, new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }))]); return outcome("first done"); }
      return outcome(program);
    } });
    try {
      const first = call(b, { program: "first", args: [], timeoutMs: 30000 });
      for (let i = 0; i < 200 && b.calls.length < 1; i++) await sleep(10);
      assert.equal(b.calls.length, 1, "the first command is running");
      // cancelled while waiting: answered at once, with the first still running
      const controller = new AbortController();
      const waitingCancelled = call(b, { program: "cancelled-while-waiting", args: [], timeoutMs: 30000 }, controller.signal);
      await sleep(100);
      const startedCancel = Date.now(); controller.abort();
      const cancelled = await waitingCancelled;
      assert.equal(cancelled.details.cancelled, true);
      assert.match(cancelled.content[0].text, /\[verification CANCELLED exit=1\]$/);
      assert.match(cancelled.content[0].text, /cancelled before it started/, "the orchestrator answered, not the caller's own give-up");
      assert.ok(Date.now() - startedCancel < 250, `answered while the first command was still running (${Date.now() - startedCancel} ms)`);
      // out of time while waiting: the caller returns timed out after timeoutMs + margin (1000 + 300 ms here), and its request is cancelled
      const waitingTimedOut = await call(b, { program: "timed-out-while-waiting", args: [], timeoutMs: 1000 });
      assert.equal(waitingTimedOut.details.timedOut, true);
      assert.match(waitingTimedOut.content[0].text, /\[verification TIMEOUT exit=1\]$/);
      const timedOutCancel = (await readdir(b.requestDir)).filter(name => name.endsWith(".cancel"));
      assert.equal(timedOutCancel.length, 2, "both waiting requests were cancelled");
      // the first is untouched, and what comes after still runs
      const third = call(b, { program: "after", args: [], timeoutMs: 30000 });
      await sleep(100);
      assert.equal(b.calls.length, 1, "nothing else started while the first runs");
      release();
      assert.match((await first).content[0].text, /^first done/);
      assert.match((await third).content[0].text, /^after/);
      assert.deepEqual(b.calls.map(item => item.program), ["first", "after"], "the cancelled and timed-out requests were never run");
      for (const name of (await readdir(b.requestDir)).filter(name => name.endsWith(".request.json"))) {
        assert.equal(existsSync(path.join(b.requestDir, name.replace(".request.json", ".result.json"))), true, `${name} was answered`);
      }
    } finally { release(); await b.stop(); }
  }

  // ---- stop() with a request waiting: the running one is aborted, the waiting one is answered and never run
  {
    const b = await broker({ run: ({ signal }) => new Promise(resolve => { const done = () => resolve(outcome("", { code: 143, cancelled: true })); if (signal.aborted) done(); else signal.addEventListener("abort", done, { once: true }); }) });
    const running = call(b, { program: "running", args: [], timeoutMs: 30000 });
    for (let i = 0; i < 200 && b.calls.length < 1; i++) await sleep(10);
    const waiting = call(b, { program: "waiting", args: [], timeoutMs: 30000 });
    waiting.catch(() => {});
    await sleep(100);
    await b.stop();
    assert.match((await running).content[0].text, /\[verification CANCELLED exit=143\]$/);
    await assert.rejects(() => waiting, /stage ended before the request was run|stopped accepting|not accepting/);
    assert.deepEqual(b.calls.map(item => item.program), ["running"], "the waiting request was never started");
  }

  // ---- cancellation: the cancel marker reaches the runner's signal
  {
    let observed;
    const b = await broker({ run: ({ signal }) => new Promise(resolve => { observed = signal; const done = () => resolve(outcome("", { code: 143, cancelled: true })); if (signal.aborted) done(); else signal.addEventListener("abort", done, { once: true }); }) });
    try {
      const controller = new AbortController();
      const pending = call(b, { program: "sleep", args: ["30"], timeoutMs: 30000 }, controller.signal);
      for (let i = 0; i < 200 && !observed; i++) await sleep(10);
      assert.ok(observed && !observed.aborted, "the command is running");
      controller.abort();
      const result = await pending;
      assert.match(result.content[0].text, /\[verification CANCELLED exit=143\]$/);
      assert.equal(result.details.cancelled, true); assert.equal(result.details.timedOut, false);
      assert.equal(observed.aborted, true, "the orchestrator stopped the running command");
      assert.equal((await readdir(b.requestDir)).filter(name => name.endsWith(".cancel")).length, 1, "the cancel marker is the signal");
      // already aborted before the call: the request is cancelled from the start
      const early = new AbortController(); early.abort();
      const earlyResult = await call(b, { program: "sleep", args: ["30"], timeoutMs: 30000 }, early.signal);
      assert.equal(earlyResult.details.cancelled, true);
    } finally { await b.stop(); }
  }

  // ---- no answer: a timed-out result after timeoutMs plus the margin; a cancel nobody confirms ends after the grace
  {
    const dir = path.join(base, "silent"); await mkdir(dir);
    await writeFile(path.join(dir, requests.BROKER_MARKER), "{}"); // a marker, but nobody answers
    process.env.YORISHIRO_VERIFICATION_REQUEST_DIR = dir;
    const started = Date.now();
    const timed = await tool.execute("t", { program: "/bin/echo", args: [], timeoutMs: 1000 }, new AbortController().signal);
    const elapsed = Date.now() - started;
    assert.match(timed.content[0].text, /\[verification TIMEOUT exit=1\]$/);
    assert.match(timed.content[0].text, /did not answer within 1300 ms/);
    assert.equal(timed.details.timedOut, true);
    assert.ok(elapsed >= 1250 && elapsed < 5000, `waited timeoutMs + margin (${elapsed} ms)`);
    assert.equal((await readdir(dir)).filter(name => name.endsWith(".cancel")).length, 1, "the timed-out request is cancelled");
    const controller = new AbortController(); setTimeout(() => controller.abort(), 50);
    const cancelStarted = Date.now();
    const cancelled = await tool.execute("t", { program: "/bin/echo", args: [], timeoutMs: 30000 }, controller.signal);
    assert.match(cancelled.content[0].text, /\[verification CANCELLED exit=1\]$/);
    assert.equal(cancelled.details.cancelled, true);
    assert.ok(Date.now() - cancelStarted < 3000, "gave up after the cancel grace, not after timeoutMs");
  }

  // ---- stop(): what runs is aborted, what was not started is answered, requests of an earlier stage are not run
  {
    const dir = path.join(base, "stop-run");
    const requestDir = requests.verificationRequestDir(dir, "review");
    await mkdir(requestDir, { recursive: true });
    await writeFile(requests.requestFile(requestDir, "left-over"), JSON.stringify({ program: "/bin/echo", args: [] }));
    let observed; const calls = [];
    const instance = await startVerificationBroker({ requestDir, evidenceRoot: path.join(dir, "evidence"), stage: "review", cwd: base, pollMs: 10, run: (program, args, cwd, timeoutMs, signal) => { calls.push(program); return new Promise(resolve => { observed = signal; const done = () => resolve(outcome("", { cancelled: true, code: 143 })); if (signal.aborted) done(); else signal.addEventListener("abort", done, { once: true }); }); } });
    assert.equal(JSON.parse(await readFile(requests.resultFile(requestDir, "left-over"), "utf8")).status, "failed", "a request left by an earlier stage is answered, not run");
    assert.equal(calls.length, 0);
    assert.equal(existsSync(path.join(requestDir, requests.BROKER_MARKER)), true, "broker.json is present while accepting");
    process.env.YORISHIRO_VERIFICATION_REQUEST_DIR = requestDir;
    const pending = tool.execute("t", { program: "/bin/sleep", args: ["30"], timeoutMs: 30000 }, new AbortController().signal);
    for (let i = 0; i < 200 && !observed; i++) await sleep(10);
    await instance.stop();
    assert.equal(observed.aborted, true, "stop aborts the running command");
    assert.match((await pending).content[0].text, /\[verification CANCELLED/);
    assert.equal(existsSync(path.join(requestDir, requests.BROKER_MARKER)), false, "broker.json is withdrawn");
    await assert.rejects(() => tool.execute("t", { program: "/bin/echo", args: [] }, new AbortController().signal), /not accepting verification requests/);
    await instance.stop(); // a second stop is harmless
  }

  // ---- nothing from the environment is written to the request directory
  {
    process.env.VERIFICATION_TEST_SECRET = "s3cret-value-that-must-not-be-written";
    const b = await broker();
    try {
      await call(b, { program: "/bin/echo", args: ["hello"] });
      const files = await readdir(b.requestDir);
      assert.ok(files.length >= 3, "marker, request and result exist");
      for (const file of files) assert.equal((await readFile(path.join(b.requestDir, file), "utf8")).includes("s3cret-value-that-must-not-be-written"), false, `${file} holds no environment value`);
      const request = JSON.parse(await readFile(path.join(b.requestDir, files.find(name => name.endsWith(".request.json"))), "utf8"));
      assert.deepEqual(Object.keys(request).sort(), ["args", "program", "timeoutMs"], "a request is only what the tool was asked to run");
    } finally { await b.stop(); delete process.env.VERIFICATION_TEST_SECRET; }
  }

  // ---- the real MCP server process, as Claude Code starts it: its own environment never reaches the command
  {
    const b = await broker({ run: () => outcome(`orchestrator sees ${process.env.VERIFICATION_ENV_PROBE}`) });
    process.env.VERIFICATION_ENV_PROBE = "orchestrator-value";
    const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", ext("claude-mcp.mjs")], { env: { ...savedEnv, YORISHIRO_MCP_TOOLS: "run_verification_command", YORISHIRO_VERIFICATION_REQUEST_DIR: b.requestDir, VERIFICATION_ENV_PROBE: "child-pane-value", YORISHIRO_VERIFICATION_POLL_MS: "10" }, stdio: ["pipe", "pipe", "pipe"] });
    try {
      const reply = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("no reply from the MCP server")), 30_000); createInterface({ input: child.stdout }).on("line", line => { const message = JSON.parse(line); if (message.id === 2) { clearTimeout(timer); resolve(message); } }); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_verification_command", arguments: { program: "printenv", args: ["VERIFICATION_ENV_PROBE"] } } })}\n`);
      const message = await reply;
      assert.equal(message.result.isError, undefined, JSON.stringify(message));
      assert.match(message.result.content[0].text, /^orchestrator sees orchestrator-value\n/, "the command's environment is the orchestrator's, not the MCP server's");
    } finally { child.stdin.end(); await new Promise(resolve => child.once("close", resolve)); await b.stop(); delete process.env.VERIFICATION_ENV_PROBE; }
  }
} finally {
  delete process.env.YORISHIRO_VERIFICATION_REQUEST_DIR;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await rm(base, { recursive: true, force: true });
}
console.log("verification broker tests passed");
