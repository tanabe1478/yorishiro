import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// index.ts reads YORISHIRO_RUNTIME when it is imported.
delete process.env.YORISHIRO_RUNTIME;
const { buildOutputExcerpt, pickDiagnosticLine, buildOutputLog } = await import("../extensions/development-pipeline/index.ts");
const { run, verificationEnvironment, copyGradleProperties, darwinSandboxProfile, darwinUserTempDir, sandboxCommand, MAX_OUTPUT } = await import("../extensions/development-pipeline/verifier-tools.ts");

const bytes = (text) => Buffer.byteLength(text, "utf8");
const MARK = "[... 中略 ...]";
const filler = (lines, prefix = "filler") => Array.from({ length: lines }, (_, i) => `${prefix}-${i} xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`).join("\n");

// 4KiB 以下はそのまま。
{
  const short = "> test:gate\nok 1\n";
  assert.equal(buildOutputExcerpt(short), short);
}

// 先頭だけが残っている（tail なし）長い出力: 先頭1KiB + 印 + 末尾3KiB。
{
  const head = filler(400);
  assert.ok(bytes(head) > 4096);
  const excerpt = buildOutputExcerpt(head);
  const [first, last] = excerpt.split(`\n${MARK}\n`);
  assert.equal(first, head.slice(0, 1024));
  assert.equal(last, head.slice(head.length - 3072));
  assert.ok(bytes(excerpt) <= 4096 + bytes(`\n${MARK}\n`));
}

// 末尾にエラーがある長い出力: tail 側の末尾3KiBが抜粋に入り、主な出力はそのエラー行になる。
{
  const head = filler(2000, "pass");
  const tail = `${filler(2000, "pass-late")}\nnot ok 7 - something\n  AssertionError [ERR_ASSERTION]: expected 1 to equal 2\n    at file.mjs:3:1\nℹ fail 1\n`;
  const excerpt = buildOutputExcerpt(head, tail);
  assert.ok(excerpt.startsWith(head.slice(0, 1024)));
  assert.ok(excerpt.includes(MARK));
  const shown = excerpt.split(`\n${MARK}\n`)[1];
  assert.ok(tail.endsWith(shown) && bytes(shown) > 3072 - 4 && bytes(shown) <= 3072);
  assert.ok(excerpt.includes("AssertionError [ERR_ASSERTION]: expected 1 to equal 2"));
  assert.equal(pickDiagnosticLine(head, tail, true), "AssertionError [ERR_ASSERTION]: expected 1 to equal 2");
  // 成功したチェックは従来どおり先頭の非空行。
  assert.equal(pickDiagnosticLine(`\n> test:gate\n${head}`, tail, false), "> test:gate");
}

// エラー行らしい行が無ければ最後の非空行。
{
  const tail = `${filler(100)}\nsome last words\n\n`;
  assert.equal(pickDiagnosticLine("> test:gate\n", tail, true), "some last words");
  assert.equal(pickDiagnosticLine("> test:gate\nonly head\n\n", "", true), "only head");
  assert.equal(pickDiagnosticLine("", "", true), undefined);
}

// スタックフレーム（at ...）は主な出力にしない。小文字の assert を含む "at assertScenario" が選ばれた失敗の再現。
{
  const tail = [
    "AssertionError [ERR_ASSERTION]: production return outcome does not match the scenario contract",
    "+ actual - expected",
    "+ 'NEEDS_PLANNER'",
    "- 'SUCCESS'",
    "    at assertScenario (file:///x/test/support/pipeline-v3-harness.mjs:57:12)",
    "    at runScenario (file:///x/test/pipeline-v3-integration.mjs:37:1951)",
    "  generatedMessage: false,",
    "  code: 'ERR_ASSERTION',",
    "Node.js v24.19.0",
    "",
  ].join("\n");
  assert.equal(pickDiagnosticLine("> test:pipeline-v3-integration\n", tail, true), "AssertionError [ERR_ASSERTION]: production return outcome does not match the scenario contract");
  // Error 行が無ければ、スタックフレームを除いた最後の失敗らしい行。
  assert.equal(pickDiagnosticLine("", "assertion failed in scenario\n    at assertScenario (x.mjs:5:1)\n", true), "assertion failed in scenario");
}

// npm が末尾に出す "npm error ..." / "npm ERR! ..." は主な出力にしない。
{
  const tail = "AssertionError [ERR_ASSERTION]: 3 !== 0\nnpm error code 1\nnpm error command failed\nnpm error command sh -c node ./test/x.mjs\n";
  assert.equal(pickDiagnosticLine("", tail, true), "AssertionError [ERR_ASSERTION]: 3 !== 0");
  assert.equal(pickDiagnosticLine("", "Error: ENAMETOOLONG\nnpm ERR! code 1\nnpm ERR! command failed\n", true), "Error: ENAMETOOLONG");
  // 候補が npm の行しかなければ、それでも最後の行を返す。
  assert.equal(pickDiagnosticLine("", "npm error command failed\n", true), "npm error command failed");
}

// 長すぎる行は300バイト以内に切り、UTF-8を壊さない。
{
  const line = pickDiagnosticLine("", `Error: ${"あ".repeat(500)}`, true);
  assert.ok(bytes(line) <= 300);
  assert.ok(!line.includes("�"));
}

// マルチバイト文字: 切り位置が文字の途中に来るようにずらしても � が出ない。
for (const unit of ["あ", "🙂", "é"]) {
  for (let pad = 0; pad < 4; pad++) {
    const body = unit.repeat(3000);
    const head = `${"a".repeat(pad)}${body}`;
    const tail = `${body}${"b".repeat(pad)}`;
    for (const excerpt of [buildOutputExcerpt(head), buildOutputExcerpt(head, tail)]) {
      assert.ok(!excerpt.includes("�"), `unit=${unit} pad=${pad}`);
      assert.ok(bytes(excerpt) <= 4096 + bytes(`\n${MARK}\n`));
    }
  }
}

// ログ: tail が無ければ先頭そのまま。間を省いたときは1行の印、重なる可能性があるときはその旨。
{
  assert.equal(buildOutputLog("abc\n"), "abc\n");
  const omitted = buildOutputLog("HEAD", "TAIL\n", 1_000_000).split("\n");
  assert.equal(omitted[0], "HEAD");
  assert.match(omitted[1], /^\[\.\.\. 先頭と末尾の間の出力を省略（出力全体 1000000 bytes/);
  assert.equal(omitted[2], "TAIL");
  assert.match(buildOutputLog("HEAD\n", "TAIL", 6).split("\n")[1], /重なる場合がある/);
}

// run(): 64KiB を大きく超える出力の最後にエラー行を出して exit 1 で終わると、tail にそのエラー行が入る。
{
  const script = `process.stdout.write(${JSON.stringify("x".repeat(99) + "\n")}.repeat(3000)); setTimeout(() => { process.stderr.write("AssertionError: tail-marker\\n"); process.exitCode = 1; }, 200)`;
  const result = await run(process.execPath, ["-e", script], process.cwd(), 10000);
  assert.equal(result.code, 1);
  assert.equal(result.truncated, true);
  assert.ok(!(result.stdout + result.stderr).includes("tail-marker"), "head must keep its old meaning (first 64KiB only)");
  assert.ok(bytes(result.stdout) <= MAX_OUTPUT);
  assert.ok(result.tail.trimEnd().endsWith("AssertionError: tail-marker"));
  assert.ok(bytes(result.tail) <= MAX_OUTPUT);
  assert.equal(result.totalBytes, 3000 * 100 + bytes("AssertionError: tail-marker\n"));
}

// run(): 64KiB 以内なら tail は空、マルチバイトの途中から始まらない。
{
  const small = await run(process.execPath, ["-e", `process.stdout.write("ok")`], process.cwd(), 5000);
  assert.equal(small.tail, "");
  const wide = await run(process.execPath, ["-e", `process.stdout.write("あ".repeat(40000))`], process.cwd(), 10000);
  assert.ok(wide.tail.length > 0 && !wide.tail.includes("�"));
  assert.ok(/^あ+$/.test(wide.tail));
}

// 検証コマンドの環境: orchestrator の YORISHIRO_* / HERDR_* は子に渡さず、自分で設定する YORISHIRO_EVIDENCE_DIR だけ残す。
{
  const workspace = { temp: "/w/.yorishiro-tmp", cache: "/w/.yorishiro-cache", evidence: "/w/.yorishiro-evidence" };
  const base = { PATH: "/usr/bin", HOME: "/home/x", npm_config_registry: "https://registry.npmjs.org", YORISHIRO_ROOT: "/real/checkout", YORISHIRO_RUNTIME: "claude", YORISHIRO_ROLE: "worker", YORISHIRO_TARGET_CWD: "/real/checkout", YORISHIRO_EVIDENCE_DIR: "/stale", HERDR_PANE_ID: "p1", HERDR_SOCKET_PATH: "/s", NOT_YORISHIRO_X: "kept", XYORISHIRO_Y: "kept", unset: undefined };
  const env = verificationEnvironment(workspace, base);
  assert.deepEqual(Object.keys(env).filter(name => /^(YORISHIRO_|HERDR_)/.test(name)), ["YORISHIRO_EVIDENCE_DIR"]);
  assert.equal(env.YORISHIRO_EVIDENCE_DIR, workspace.evidence, "the stale value is replaced by the snapshot's directory");
  assert.deepEqual([env.PATH, env.HOME, env.npm_config_registry, env.NOT_YORISHIRO_X, env.XYORISHIRO_Y], ["/usr/bin", "/home/x", "https://registry.npmjs.org", "kept", "kept"]);
  assert.deepEqual([env.TMPDIR, env.TMP, env.TEMP], [workspace.temp, workspace.temp, workspace.temp]);
  assert.equal(env.npm_config_cache, "/w/.yorishiro-cache/npm");
  assert.equal(env.XDG_CACHE_HOME, "/w/.yorishiro-cache/xdg");
  assert.ok(!("unset" in env));
  assert.deepEqual(base.YORISHIRO_ROOT, "/real/checkout", "the caller's environment is not modified");
  // 既定の base は process.env。
  process.env.YORISHIRO_ROOT = "/inherited"; process.env.HERDR_PANE_ID = "inherited";
  try { const fromProcess = verificationEnvironment(workspace); assert.equal(fromProcess.YORISHIRO_ROOT, undefined); assert.equal(fromProcess.HERDR_PANE_ID, undefined); assert.equal(fromProcess.PATH, process.env.PATH); }
  finally { delete process.env.YORISHIRO_ROOT; delete process.env.HERDR_PANE_ID; }
}

// JVM 向けの既定: JAVA_TOOL_OPTIONS、GRADLE_USER_HOME、GRADLE_RO_DEP_CACHE、gradle.properties の複製。
{
  const workspace = { temp: "/w/.yorishiro-tmp", cache: "/w/.yorishiro-cache", evidence: "/w/.yorishiro-evidence" };
  const gradleHome = await mkdtemp(path.join(os.tmpdir(), "yorishiro-gradle-env-"));
  try {
    // 元の Gradle ホームに caches がなければ GRADLE_RO_DEP_CACHE は付かない。GRADLE_USER_HOME と java.io.tmpdir は常に付く。
    const bare = verificationEnvironment(workspace, { PATH: "/usr/bin", GRADLE_USER_HOME: gradleHome });
    assert.equal(bare.JAVA_TOOL_OPTIONS, "-Djava.io.tmpdir=/w/.yorishiro-tmp");
    assert.equal(bare.GRADLE_USER_HOME, "/w/.yorishiro-cache/gradle", "the caller's Gradle home is replaced by one in the snapshot");
    assert.equal("GRADLE_RO_DEP_CACHE" in bare, false);
    // JAVA_TOOL_OPTIONS は呼び出し元の値を残して追記する。
    assert.equal(verificationEnvironment(workspace, { GRADLE_USER_HOME: gradleHome, JAVA_TOOL_OPTIONS: "-Xmx1g -Dfoo=bar" }).JAVA_TOOL_OPTIONS, "-Xmx1g -Dfoo=bar -Djava.io.tmpdir=/w/.yorishiro-tmp");
    assert.equal(verificationEnvironment({ ...workspace, temp: "/w x/tmp" }, { GRADLE_USER_HOME: gradleHome }).JAVA_TOOL_OPTIONS, '-Djava.io.tmpdir="/w x/tmp"', "a temp path with spaces is quoted");
    // caches があれば、その caches を GRADLE_RO_DEP_CACHE にする。
    await mkdir(path.join(gradleHome, "caches"));
    assert.equal(verificationEnvironment(workspace, { GRADLE_USER_HOME: gradleHome }).GRADLE_RO_DEP_CACHE, path.join(gradleHome, "caches"));
    // 呼び出し元の GRADLE_RO_DEP_CACHE が優先。
    assert.equal(verificationEnvironment(workspace, { GRADLE_USER_HOME: gradleHome, GRADLE_RO_DEP_CACHE: "/custom/ro" }).GRADLE_RO_DEP_CACHE, "/custom/ro");
    // GRADLE_USER_HOME がなければ HOME/.gradle を見る。
    const home = await mkdtemp(path.join(os.tmpdir(), "yorishiro-gradle-home-"));
    try {
      assert.equal("GRADLE_RO_DEP_CACHE" in verificationEnvironment(workspace, { HOME: home }), false);
      await mkdir(path.join(home, ".gradle", "caches"), { recursive: true });
      assert.equal(verificationEnvironment(workspace, { HOME: home }).GRADLE_RO_DEP_CACHE, path.join(home, ".gradle", "caches"));
    } finally { await rm(home, { recursive: true, force: true }); }
    // caches がファイルなら付けない。
    const fileCaches = await mkdtemp(path.join(os.tmpdir(), "yorishiro-gradle-file-"));
    try { await writeFile(path.join(fileCaches, "caches"), "x"); assert.equal("GRADLE_RO_DEP_CACHE" in verificationEnvironment(workspace, { GRADLE_USER_HOME: fileCaches }), false); }
    finally { await rm(fileCaches, { recursive: true, force: true }); }

    // gradle.properties の複製: 内容は同じ、権限は 600、元の権限が広くても狭める。なければ何もしない。
    const cache = await mkdtemp(path.join(os.tmpdir(), "yorishiro-gradle-cache-"));
    try {
      assert.equal(await copyGradleProperties(cache, { GRADLE_USER_HOME: gradleHome }), false, "no gradle.properties, nothing copied");
      await assert.rejects(stat(path.join(cache, "gradle")), "no Gradle home is created without a source");
      await writeFile(path.join(gradleHome, "gradle.properties"), "org.gradle.java.installations.paths=/jdk\n");
      await chmod(path.join(gradleHome, "gradle.properties"), 0o644);
      assert.equal(await copyGradleProperties(cache, { GRADLE_USER_HOME: gradleHome }), true);
      const copied = path.join(cache, "gradle", "gradle.properties");
      assert.equal(await readFile(copied, "utf8"), "org.gradle.java.installations.paths=/jdk\n");
      assert.equal((await stat(copied)).mode & 0o777, 0o600);
      assert.equal((await stat(path.join(gradleHome, "gradle.properties"))).mode & 0o777, 0o644, "the original is untouched");
      // 既存のファイルが広い権限でも、600 で書き直す。
      await chmod(copied, 0o666);
      assert.equal(await copyGradleProperties(cache, { GRADLE_USER_HOME: gradleHome }), true);
      assert.equal((await stat(copied)).mode & 0o777, 0o600);
    } finally { await rm(cache, { recursive: true, force: true }); }
  } finally { await rm(gradleHome, { recursive: true, force: true }); }
}

// timeoutMs の上限 1800000 は契約の検証・development_pipeline と run_verification_command の TypeBox スキーマで同じ値を使う。
// このテストは typebox を空のスタブに差し替えるため、スキーマの値そのものは見られない。ソースが定数を参照していることを確かめる
// （claude-mcp.mjs のスキーマの値は test:claude-mcp が実際の MCP サーバーで確かめる）。既定（120000）は変えない。
{
  const { MAX_CHECK_TIMEOUT_MS } = await import("../extensions/development-pipeline/quality-contract.ts");
  assert.equal(MAX_CHECK_TIMEOUT_MS, 1800000);
  const source = async name => readFile(new URL(`../extensions/development-pipeline/${name}`, import.meta.url), "utf8");
  const tools = await source("verifier-tools.ts"), pipeline = await source("index.ts");
  assert.match(tools, /timeoutMs: Type\.Optional\(Type\.Integer\(\{ minimum: 1000, maximum: MAX_CHECK_TIMEOUT_MS \}\)\)/);
  assert.match(tools, /input\.timeoutMs \?\? 120000/, "the run_verification_command default stays 120000");
  assert.match(pipeline, /timeoutMs: Type\.Optional\(Type\.Integer\(\{ minimum: 1, maximum: MAX_CHECK_TIMEOUT_MS \}\)\)/);
  assert.match(pipeline, /check\.timeoutMs \?\? 120000/, "the requiredChecks default stays 120000");
  for (const text of [tools, pipeline]) assert.doesNotMatch(text, /maximum: 300000/);
}

// macOS の sandbox プロファイル: DARWIN_USER_TEMP_DIR の realpath への書き込みを許す。取得できなければ足さない。
{
  const without = darwinSandboxProfile("/snap");
  assert.equal(without, '(version 1) (allow default) (deny file-write*) (allow file-write* (subpath "/snap")) (allow file-write* (literal "/dev/null"))');
  const withTemp = darwinSandboxProfile("/snap", "/private/var/folders/ab/cd/T");
  assert.equal(withTemp, `${without} (allow file-write* (subpath "/private/var/folders/ab/cd/T"))`);
  if (process.platform === "darwin") {
    const userTemp = darwinUserTempDir();
    assert.ok(userTemp && path.isAbsolute(userTemp), "getconf DARWIN_USER_TEMP_DIR is available on macOS");
    const command = sandboxCommand("/bin/echo", ["hi"], "/snap");
    assert.deepEqual([command[0], command[1]], ["/usr/bin/sandbox-exec", "-p"]);
    assert.ok(command[2].includes(`(allow file-write* (subpath ${JSON.stringify(userTemp)}))`), "the sandbox command's profile allows the user temp directory");
    assert.deepEqual(command.slice(3), ["--", "/bin/echo", "hi"]);
  }
}

// run(): replaceEnv なら env だけを子の環境にし、process.env を足し戻さない。
{
  process.env.YORISHIRO_ROOT = "/inherited";
  try {
    const script = `process.stdout.write(JSON.stringify({ root: process.env.YORISHIRO_ROOT ?? null, kept: process.env.KEPT ?? null }))`;
    const merged = await run(process.execPath, ["-e", script], process.cwd(), 10000, undefined, { KEPT: "1" });
    assert.deepEqual(JSON.parse(merged.stdout), { root: "/inherited", kept: "1" }, "without replaceEnv, env is added to process.env");
    const replaced = await run(process.execPath, ["-e", script], process.cwd(), 10000, undefined, { KEPT: "1" }, true);
    assert.deepEqual(JSON.parse(replaced.stdout), { root: null, kept: "1" });
  } finally { delete process.env.YORISHIRO_ROOT; }
}

console.log("quality gate output excerpt tests passed");
