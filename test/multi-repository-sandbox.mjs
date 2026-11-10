import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installFakePi } from "./support/fake-pi.mjs";

// Starts the verification sandbox (and, below, a whole pipeline run with a fake Herdr), so it cannot run inside the
// quality gate's own sandbox: it is listed in test/gate-exclusions.json and runs under `npm test`.
// The run is a Pi-runtime one with its own artifacts: do not inherit a session's root or runtime.
delete process.env.YORISHIRO_ROOT;
delete process.env.YORISHIRO_RUNTIME;
delete process.env.YORISHIRO_EVIDENCE_ROOT;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = name => path.join(root, "extensions", "development-pipeline", name);
const { runSandboxedVerification } = await import(ext("verifier-tools.ts"));
const verifierTools = (await import(ext("verifier-tools.ts"))).default;
const { runQualityGate, default: loadPipeline } = await import(ext("index.ts"));

const git = (args, cwd) => new Promise((resolve, reject) => { const p = spawn("git", args, { cwd, stdio: "ignore" }); p.once("error", reject); p.once("close", code => code ? reject(new Error(`git ${args.join(" ")}=${code}`)) : resolve()); });
async function repository(workspace, name, files = {}) {
  const target = path.join(workspace, name);
  await mkdir(path.join(target, "src"), { recursive: true });
  await git(["init", "-q"], target); await git(["config", "user.email", "test@example.invalid"], target); await git(["config", "user.name", "test"], target);
  await writeFile(path.join(target, "src", "index.ts"), `export const name = ${JSON.stringify(name)};\n`);
  await writeFile(path.join(target, "data.txt"), `${name}-data\n`);
  for (const [file, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(target, file)), { recursive: true }); await writeFile(path.join(target, file), content); }
  await git(["add", "."], target); await git(["commit", "-qm", "base"], target);
  return target;
}
// The repositories cannot live under the temporary directory (the sandbox preflight rejects that), so use the ignored artifacts/ directory.
// The workspace is a uniquely named directory inside a container, so that the run's artifacts (artifacts/<basename of cwd>/) are elsewhere.
const workspace = async () => { const container = await realpath(await mkdtemp(path.join(root, "artifacts", ".multi-repo-"))), ws = path.join(container, `multi-ws-${path.basename(container).slice(-6)}`); await mkdir(ws); return ws; };
const removeWorkspace = ws => rm(path.dirname(ws), { recursive: true, force: true });
const node = process.execPath;
const script = source => ["-e", source];
const ok = result => assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);

// ---- runSandboxedVerification: a copy of exactly the listed repositories, at their relative paths
{
  const ws = await workspace();
  try {
    const api = await repository(ws, "api"), backend = await repository(ws, "backend");
    await mkdir(path.join(ws, "docs")); await writeFile(path.join(ws, "docs", "note.txt"), "not a repository\n");
    await writeFile(path.join(backend, "untracked.txt"), "uncommitted work\n");
    const options = { repositories: ["api", "backend"] };

    const crossRead = await runSandboxedVerification(node, script("const fs=require('fs');process.stdout.write(process.cwd()+'\\n'+fs.readFileSync('../backend/data.txt','utf8')+fs.readFileSync('../backend/untracked.txt','utf8')+'docs:'+fs.existsSync('../docs'))"), ws, 30000, undefined, { ...options, workdir: "api" });
    ok(crossRead);
    const [cwdLine, ...rest] = crossRead.stdout.split("\n");
    assert.ok(cwdLine.endsWith(`${path.sep}workspace${path.sep}api`) || cwdLine.endsWith("/workspace/api"), `the program starts in the api copy: ${cwdLine}`);
    assert.notEqual(await realpath(cwdLine).catch(() => cwdLine), api, "and not in the source checkout");
    assert.equal(rest.join("\n"), "backend-data\nuncommitted work\ndocs:false", "../backend resolves (with uncommitted work); a directory that is not a listed repository is not copied");

    const atRoot = await runSandboxedVerification(node, script("process.stdout.write(JSON.stringify(require('fs').readdirSync('.').filter(name=>!name.startsWith('.'))))"), ws, 30000, undefined, options);
    ok(atRoot);
    assert.deepEqual(JSON.parse(atRoot.stdout), ["api", "backend"], "without a cwd the program starts at the workspace root, which holds only the repositories");

    const nested = await runSandboxedVerification(node, script("process.stdout.write(require('path').basename(process.cwd()))"), ws, 30000, undefined, { ...options, workdir: "backend/src" });
    ok(nested); assert.equal(nested.stdout, "src", "a directory inside a repository is a valid cwd");

    // writes go to the whole snapshot, never to the source
    const sourceMarker = path.join(backend, "out.txt"), sourceFromApi = path.join(api, "marker.txt");
    const writes = await runSandboxedVerification(node, script(`require('fs').writeFileSync('../backend/out.txt','x');require('fs').writeFileSync('../root-file.txt','y');`), ws, 30000, undefined, { ...options, workdir: "api" });
    ok(writes);
    await assert.rejects(() => stat(sourceMarker), "a write into the other repository's copy does not reach its source");
    await assert.rejects(() => stat(path.join(ws, "root-file.txt")), "nor does a write at the snapshot root reach the source workspace");
    const blocked = await runSandboxedVerification(node, script(`require('fs').writeFileSync(${JSON.stringify(sourceFromApi)},'forbidden')`), ws, 30000, undefined, { ...options, workdir: "backend" });
    assert.notEqual(blocked.code, 0, "the sandbox blocks writes to the source checkout");
    await assert.rejects(() => stat(sourceFromApi));

    // refusals
    await assert.rejects(() => runSandboxedVerification(node, [], ws, 5000, undefined, { ...options, workdir: "docs" }), /one of repositories or inside one/);
    await assert.rejects(() => runSandboxedVerification(node, [], ws, 5000, undefined, { ...options, workdir: "../api" }), /one of repositories or inside one/);
    await assert.rejects(() => runSandboxedVerification(node, [], ws, 5000, undefined, { ...options, workdir: "api/missing" }), /does not exist in the verification workspace/);
    await assert.rejects(() => runSandboxedVerification(node, [], api, 5000, undefined, { workdir: "src" }), /only allowed when the run has repositories/);

    // the preflight runs for each repository: repositories under the temporary directory are refused
    const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "yorishiro-multi-tmp-")));
    try {
      await repository(temporary, "api");
      await assert.rejects(() => runSandboxedVerification(node, [], temporary, 5000, undefined, { repositories: ["api"] }), /does not support repositories under \/tmp/);
    } finally { await rm(temporary, { recursive: true, force: true }); }

    // ---- the verification tool (what the Worker and the Reviewer call) with the launcher's environment
    const tools = []; verifierTools({ registerTool: tool => tools.push(tool) });
    const tool = tools.find(item => item.name === "run_verification_command");
    assert.ok((tool.parameters.properties ?? tool.parameters).cwd, "the tool takes a cwd (the test loader stubs TypeBox, so the property map may be the parameters themselves)");
    const run = (input, env) => {
      const saved = { cwd: process.env.YORISHIRO_TARGET_CWD, repositories: process.env.YORISHIRO_TARGET_REPOSITORIES };
      process.env.YORISHIRO_TARGET_CWD = ws;
      if (env === undefined) delete process.env.YORISHIRO_TARGET_REPOSITORIES; else process.env.YORISHIRO_TARGET_REPOSITORIES = env;
      return tool.execute("t", input, new AbortController().signal).finally(() => { for (const [key, value] of [["YORISHIRO_TARGET_CWD", saved.cwd], ["YORISHIRO_TARGET_REPOSITORIES", saved.repositories]]) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
    };
    const reposEnv = JSON.stringify(["api", "backend"]);
    const viaTool = await run({ program: node, args: script("process.stdout.write(require('path').basename(process.cwd())+':'+require('fs').readFileSync('../api/data.txt','utf8'))"), cwd: "backend" }, reposEnv);
    assert.match(viaTool.content[0].text, /^backend:api-data\n/, "cwd selects the repository and ../api resolves");
    assert.match(viaTool.content[0].text, /\[verification EXIT exit=0\]/);
    assert.equal(viaTool.details.exitCode, 0);
    const rootTool = await run({ program: node, args: script("process.stdout.write(JSON.stringify(require('fs').readdirSync('.').filter(name=>!name.startsWith('.'))))") }, reposEnv);
    assert.match(rootTool.content[0].text, /^\["api","backend"\]/, "without cwd the tool runs at the workspace root");
    await assert.rejects(() => run({ program: node, args: [], cwd: "docs" }, reposEnv), /one of repositories or inside one/);
    await assert.rejects(() => run({ program: node, args: [], cwd: "backend" }, undefined), /only allowed when the run has repositories/);
    await assert.rejects(() => run({ program: node, args: [] }, "not json"), /not valid JSON/);
    await assert.rejects(() => run({ program: node, args: [] }, JSON.stringify(["../x"])), /YORISHIRO_TARGET_REPOSITORIES is invalid/);

    // ---- the quality gate: a check with a cwd runs there, the others at the workspace root
    const artifactDir = await mkdtemp(path.join(await realpath(os.tmpdir()), "yorishiro-multi-gate-"));
    try {
      const contract = { planItems: [{ id: "P", description: "x" }], requiredChecks: [
        { id: "in-api", program: node, args: script("const fs=require('fs');if(!process.cwd().endsWith('/api'))process.exit(2);process.stdout.write(fs.readFileSync('../backend/data.txt','utf8'))"), timeoutMs: 30000, cwd: "api" },
        { id: "at-root", program: node, args: script("const fs=require('fs');const names=fs.readdirSync('.');if(!names.includes('api')||!names.includes('backend'))process.exit(3)"), timeoutMs: 30000 },
      ] };
      const passed = await runQualityGate(contract, ws, 1, artifactDir, undefined, ["api", "backend"]);
      assert.equal(passed.status, "passed", JSON.stringify(passed.checks.map(check => check.summary)));
      assert.equal(passed.checks[0].cwd, "api", "the gate result records the check's cwd");
      assert.equal("cwd" in passed.checks[1], false);
      assert.match(passed.checks[0].outputExcerpt, /backend-data/);
      const wrong = await runQualityGate({ ...contract, requiredChecks: [{ id: "wrong-dir", program: node, args: script("process.exit(process.cwd().endsWith('/backend')?7:0)"), timeoutMs: 30000, cwd: "backend" }] }, ws, 2, artifactDir, undefined, ["api", "backend"]);
      assert.equal(wrong.status, "failed");
      assert.equal(wrong.checks[0].exitCode, 7, "the check really ran in backend");
      const missing = await runQualityGate({ ...contract, requiredChecks: [{ id: "bad-dir", program: node, args: [], timeoutMs: 30000, cwd: "api/nope" }] }, ws, 3, artifactDir, undefined, ["api", "backend"]);
      assert.equal(missing.status, "failed");
      assert.match(missing.checks[0].outputExcerpt, /does not exist in the verification workspace/);
    } finally { await rm(artifactDir, { recursive: true, force: true }); }
  } finally { await removeWorkspace(ws); }
}

// ---- development_pipeline end to end (fake Herdr, fake Pi): a run with repositories
const fakeHerdr = String.raw`#!/usr/bin/env node
const fs=require("node:fs"),path=require("node:path"),{spawnSync}=require("node:child_process");
const a=process.argv.slice(2),stateFile=process.env.CORE_STATE;
const read=()=>JSON.parse(fs.readFileSync(stateFile,"utf8")),save=x=>fs.writeFileSync(stateFile,JSON.stringify(x));
const out=x=>process.stdout.write((typeof x==="string"?x:JSON.stringify(x))+"\n");
const unquote=x=>String(x).replace(/^['"]|['"]$/g,"");
const settle=launch=>{
  const s=read();s.attempt[launch.stage]=(s.attempt[launch.stage]||0)+1;save(s);
  const child=spawnSync(process.execPath,["--experimental-strip-types","--experimental-loader",process.env.CORE_LOADER,"--input-type=module","-e",process.env.CORE_SCRIPT],{cwd:process.env.CORE_ROOT,timeout:120000,encoding:"utf8",env:{...process.env,CORE_STAGE:launch.stage,CORE_TARGET_CWD:launch.targetCwd||"",CORE_TARGET_REPOSITORIES:launch.targetRepositories||"",YORISHIRO_REPORT_PATH:launch.reportPath,YORISHIRO_REPORT_STAGE:launch.stage,YORISHIRO_REPORT_SCHEMA:launch.schema,YORISHIRO_REPORT_ROOT:path.dirname(launch.reportPath)}});
  if(child.status!==0){process.stderr.write("fake child failed: "+child.stderr+child.stdout);process.exit(1);}
};
if(a[0]==="status")out({});
else if(a[0]==="pane"&&a[1]==="split"){const s=read();s.splits+=1;s.splitPanes.push("fake:"+s.splits);save(s);out({result:{pane:{pane_id:"fake:"+s.splits,terminal_id:"term-fake-"+s.splits}}});}
else if(a[0]==="pane"&&a[1]==="run"){const text=fs.readFileSync(unquote(a.find(x=>String(x).includes("launcher.sh"))),"utf8"),get=k=>{const m=text.match(new RegExp("export "+k+"='([^']*)'"));return m===null?undefined:m[1];};const launch={stage:get("YORISHIRO_REPORT_STAGE"),schema:get("YORISHIRO_REPORT_SCHEMA"),reportPath:get("YORISHIRO_REPORT_PATH"),targetCwd:get("YORISHIRO_TARGET_CWD"),targetRepositories:get("YORISHIRO_TARGET_REPOSITORIES")};const s=read();s.panes[a[2]]=launch;s.launches.push(launch);save(s);settle(launch);}
else if(a[0]==="pane"&&a[1]==="send-keys"){const s=read();if(a[3]==="enter"&&s.panes[a[2]])settle(s.panes[a[2]]);out({});}
else if(a[0]==="pane"&&a[1]==="layout"){const s=read();out({result:{layout:{panes:["parent",...s.splitPanes].map(pane_id=>({pane_id})),splits:[{direction:"right",ratio:.55},{direction:"down",ratio:.5}].slice(0,s.splits),zoomed:false}}});}
else if(a[0]==="pane"&&a[1]==="get")out({agent_status:"idle"});
else if(a[0]==="pane"&&a[1]==="process-info")out({argv0:"pi"});
else if(a[0]==="pane"&&a[1]==="rename")out({result:{type:"pane_info",pane:{pane_id:a[2]}}});
else if(a[0]==="agent"&&a[1]==="read")out("transcript");
else if(a[0]==="agent"&&a[1]==="wait")out({});
`;
// What the fake child does: the Worker edits both repositories and reports workspace-relative paths; the Reviewer
// runs a verification command through the same tool the real one uses, with the environment its launcher exported.
const fakeChild = String.raw`
const fs=await import("node:fs"),path=await import("node:path");
const ws=process.env.CORE_WS,mode=process.env.CORE_MODE,stage=process.env.CORE_STAGE;
const reporter=[];(await import(process.env.CORE_REPORTER)).default({registerTool:x=>reporter.push(x)});
let report;
if(stage==="implement"){
  fs.writeFileSync(path.join(ws,"api/src/index.ts"),"export const name = 'api changed';\n");
  fs.writeFileSync(path.join(ws,"backend/src/index.ts"),"export const name = 'backend changed';\n");
  const paths=["api/src/index.ts","backend/src/index.ts"];
  if(mode==="prefix"){fs.mkdirSync(path.join(ws,"backend/docs"),{recursive:true});fs.writeFileSync(path.join(ws,"backend/docs/note.md"),"outside\n");paths.push("backend/docs/note.md");}
  report={verdict:"COMPLETED",summary:"日本語の実装報告",changedScope:"二つのリポジトリを変更しました",evidence:"テストを実行しました",completedPlanItems:[{id:"PLAN-1",evidence:"確認しました"}],changedPaths:paths};
}else{
  const verifier=[];(await import(process.env.CORE_VERIFIER)).default({registerTool:x=>verifier.push(x)});
  process.env.YORISHIRO_TARGET_CWD=process.env.CORE_TARGET_CWD;
  if(process.env.CORE_TARGET_REPOSITORIES)process.env.YORISHIRO_TARGET_REPOSITORIES=process.env.CORE_TARGET_REPOSITORIES;
  const result=await verifier[0].execute("verify",{program:process.execPath,args:["-e","process.stdout.write(require('fs').readFileSync('../api/src/index.ts','utf8'))"],cwd:"backend",timeoutMs:30000},new AbortController().signal);
  const text=result.content[0].text;
  if(!text.includes("export const name = 'api changed'")||!text.includes("[verification EXIT exit=0]"))throw new Error("reviewer verification failed: "+text);
  report={verdict:"APPROVED",summary:"日本語のレビュー報告",blockingFindings:[],nonBlockingNotes:[],plannerQuestions:[]};
}
await reporter[0].execute("fake",report);process.exit(0);
`;

/** The outcome text plus each stage's recorded errors, so a failed assertion says why the run stopped. */
const why = async result => `${result.content[0].text}\n${JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(await readFile(path.join(result.details.artifactDir, "run.json"), "utf8")).stages).map(([stage, data]) => [stage, data.attempts.map(attempt => attempt.error)])))}`;

async function runPipeline(mode, overrides = {}) {
  const ws = await workspace();
  const scratch = await mkdtemp(path.join(os.tmpdir(), `yorishiro-multi-${mode}-`));
  const bin = path.join(scratch, "bin"), state = path.join(scratch, "state.json"), socket = path.join(scratch, "socket");
  await mkdir(bin); await writeFile(socket, "");
  await writeFile(state, JSON.stringify({ attempt: {}, panes: {}, launches: [], splits: 0, splitPanes: [] }));
  // send-text is answered by a shell wrapper that records the prompt: this environment kills a node script given a long argument (SIGKILL, exit 137), and a repair prompt is long.
  await writeFile(path.join(bin, "herdr-node"), fakeHerdr); await chmod(path.join(bin, "herdr-node"), 0o755);
  await writeFile(path.join(bin, "herdr"), `#!/bin/sh\nif [ "$1" = pane ] && [ "$2" = send-text ]; then printf '%s\\t%s\\n' "$3" "$(printf %s "$4" | base64 | tr -d '\\n')" >> "$CORE_PROMPTS"; exit 0; fi\nexec ${JSON.stringify(path.join(bin, "herdr-node"))} "$@"\n`); await chmod(path.join(bin, "herdr"), 0o755); await installFakePi(bin);
  const oldPath = process.env.PATH, saved = { ...process.env };
  Object.assign(process.env, { PATH: `${bin}:${oldPath}`, CORE_STATE: state, CORE_PROMPTS: path.join(scratch, "prompts.raw"), CORE_ROOT: root, CORE_WS: ws, CORE_MODE: mode, CORE_LOADER: path.join(root, "test/typebox-loader.mjs"), CORE_REPORTER: ext("stage-reporter.ts"), CORE_VERIFIER: ext("verifier-tools.ts"), CORE_SCRIPT: fakeChild, HERDR_PANE_ID: "parent", HERDR_TAB_ID: "tab", HERDR_WORKSPACE_ID: "ws", HERDR_SOCKET_PATH: socket, YORISHIRO_STAGE_TIMEOUT_MS: "60000", YORISHIRO_STARTUP_GRACE_MS: "10", YORISHIRO_POLL_INTERVAL_MS: "1" });
  let artifactDir;
  try {
    await repository(ws, "api", { ".pi/skills/verify-api/SKILL.md": "---\nname: verify-api\ndescription: demo\n---\n# Demo\n" });
    await repository(ws, "backend");
    await mkdir(path.join(ws, "docs")); await writeFile(path.join(ws, "docs", "note.txt"), "outside every repository\n");
    const tools = []; loadPipeline({ registerTool: tool => tools.push(tool) });
    const contract = { planItems: [{ id: "PLAN-1", description: "二つのリポジトリを実装する" }], requiredChecks: [{ id: "in-backend", program: node, args: script("const fs=require('fs');if(!process.cwd().endsWith('/backend'))process.exit(2);if(!fs.readFileSync('../api/src/index.ts','utf8').includes('api changed'))process.exit(3)"), timeoutMs: 30000, cwd: "backend" }], allowedPathPrefixes: ["api/src", "backend/src"] };
    const input = { task: "複数リポジトリのテスト", approvedPlan: "日本語の承認済み計画", qualityContract: contract, cwd: ws, repositories: ["api", "backend"], cleanupMode: "never", planReviewMode: "skip", diffReviewMode: "skip", maxReviewCycles: 1, ...overrides };
    const execute = () => tools.find(tool => tool.name === "development_pipeline").execute(`multi-${mode}`, input, new AbortController().signal, () => {}, { cwd: ws, hasUI: false, ui: { confirm: async () => false } });
    return { ws, scratch, input, execute, state, readState: async () => JSON.parse(await readFile(state, "utf8")), setArtifact: dir => { artifactDir = dir; }, getArtifact: () => artifactDir, restore: async () => { process.env.PATH = oldPath; for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }, cleanup: async () => { if (artifactDir) await rm(artifactDir, { recursive: true, force: true }); await rm(path.join(root, "artifacts", path.basename(ws)), { recursive: true, force: true }); await removeWorkspace(ws); await rm(scratch, { recursive: true, force: true }); } };
  } catch (error) { await removeWorkspace(ws); throw error; }
}

const names = { api: null, backend: null };
const { repositoryArtifactName } = await import(ext("repositories.ts"));
for (const key of Object.keys(names)) names[key] = repositoryArtifactName(key);

{ // success: both repositories change, a check runs inside backend, the Reviewer verifies across repositories
  const run = await runPipeline("happy");
  try {
    const result = await run.execute();
    run.setArtifact(result.details.artifactDir);
    const artifact = result.details.artifactDir;
    assert.equal(result.details.outcome, "SUCCESS", await why(result));
    const metadata = JSON.parse(await readFile(path.join(artifact, "run.json"), "utf8"));
    assert.deepEqual(metadata.repositories, ["api", "backend"], "run.json records the repositories");
    assert.equal(metadata.targetPath, run.ws);
    assert.deepEqual(metadata.workflow.targetVerifySkills, ["api/.pi/skills/verify-api"], "verify skills are discovered per repository");
    const request = await readFile(path.join(artifact, "request.md"), "utf8");
    assert.match(request, /リポジトリ（ワークスペース相対）:\n- api\n- backend/);
    const contractArtifact = JSON.parse(await readFile(path.join(artifact, "quality-contract.json"), "utf8"));
    assert.equal(contractArtifact.requiredChecks[0].cwd, "backend", "the contract artifact keeps the check's cwd");

    const diffs = await readdir(path.join(artifact, "diffs"));
    for (const stage of ["baseline", "implement-1", "review-1"]) for (const key of ["api", "backend"]) for (const kind of ["status.txt", "diff.patch"]) assert.ok(diffs.includes(`${stage}-${names[key]}-${kind}`), `${stage}-${names[key]}-${kind} exists`);
    assert.equal(diffs.includes("baseline-status.txt"), false, "no single status file in a multi-repository run");
    const apiPatch = await readFile(path.join(artifact, "diffs", `implement-1-${names.api}-diff.patch`), "utf8"), backendPatch = await readFile(path.join(artifact, "diffs", `implement-1-${names.backend}-diff.patch`), "utf8");
    assert.match(apiPatch, /api changed/); assert.doesNotMatch(apiPatch, /backend changed/);
    assert.match(backendPatch, /backend changed/); assert.doesNotMatch(backendPatch, /api changed/);
    assert.deepEqual(JSON.parse(await readFile(path.join(artifact, "diffs", "baseline-fingerprint.json"), "utf8")), {});
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(artifact, "diffs", "implement-1-fingerprint.json"), "utf8"))).sort(), ["api/src/index.ts", "backend/src/index.ts"], "the fingerprint holds workspace-relative paths of both repositories");

    const report = JSON.parse(await readFile(path.join(artifact, "implement-1.json"), "utf8"));
    assert.deepEqual(report.changedPaths, ["api/src/index.ts", "backend/src/index.ts"], "the accepted Worker report uses workspace-relative changedPaths");
    const gate = JSON.parse(await readFile(path.join(artifact, "quality-gate-1.json"), "utf8"));
    assert.equal(gate.status, "passed", JSON.stringify(gate.checks.map(check => check.summary)));
    assert.equal(gate.checks[0].cwd, "backend");

    for (const stage of ["implement", "review"]) {
      const brief = await readFile(path.join(artifact, `workflow-brief-${stage}.md`), "utf8");
      assert.match(brief, /## 対象リポジトリ/); assert.ok(brief.includes(`- backend（${path.join(run.ws, "backend")}）`));
      assert.ok(brief.includes(path.join(run.ws, "api", ".pi", "skills", "verify-api", "SKILL.md")), "the repository's verify skill is in the brief");
    }
    const prompt = await readFile(path.join(artifact, "implement-prompt.md"), "utf8");
    assert.match(prompt, /複数リポジトリのrunです。.*api、backend/);
    assert.match(prompt, /"cwd": "backend"/, "the quality contract JSON in the prompt carries the check's cwd");
    const reviewPrompt = await readFile(path.join(artifact, "review-prompt.md"), "utf8");
    assert.ok(reviewPrompt.includes(path.join(artifact, "diffs", `implement-1-${names.api}-diff.patch`)) && reviewPrompt.includes(path.join(artifact, "diffs", `baseline-${names.backend}-status.txt`)));
    const state = await run.readState();
    const reviewLaunch = state.launches.find(launch => launch.stage === "review"), workerLaunch = state.launches.find(launch => launch.stage === "implement");
    assert.equal(reviewLaunch.targetRepositories, '["api","backend"]', "the Reviewer's launcher exports the repositories to its verifier");
    assert.equal(reviewLaunch.targetCwd, run.ws);
    assert.equal(workerLaunch.targetRepositories, undefined);
    assert.equal(metadata.humanReview.diff.decision, "skipped");
    assert.equal(await readFile(path.join(run.ws, "api", "src", "index.ts"), "utf8"), "export const name = 'api changed';\n", "the Worker's edits are in the real checkouts");
    await assert.rejects(() => stat(path.join(run.ws, "root-file.txt")));
  } finally { await run.restore(); await run.cleanup(); }
}

{ // a change outside allowedPathPrefixes in the second repository is a prefix violation, reported with its workspace-relative path
  const run = await runPipeline("prefix");
  try {
    const result = await run.execute();
    run.setArtifact(result.details.artifactDir);
    assert.equal(result.details.outcome, "NEEDS_PLANNER", await why(result));
    assert.match(result.content[0].text, /backend\/docs\/note\.md/);
    const metadata = JSON.parse(await readFile(path.join(result.details.artifactDir, "run.json"), "utf8"));
    assert.ok(metadata.qualityContractViolations.every(entry => entry.signature === "prefix:allowedPathPrefixes" && entry.actualPaths.includes("backend/docs/note.md") && entry.outsidePaths.includes("backend/docs/note.md")));
    const finding = JSON.parse(await readFile(path.join(result.details.artifactDir, "quality-repair-1.json"), "utf8"));
    assert.deepEqual(finding.outsidePaths, ["backend/docs/note.md"], "only the path outside the prefixes is named, not the allowed ones");
    assert.equal((await run.readState()).launches.some(launch => launch.stage === "review"), false, "the Reviewer is not started");
    const sent = (await readFile(path.join(run.scratch, "prompts.raw"), "utf8")).trim().split("\n").map(line => Buffer.from(line.split("\t")[1], "base64").toString("utf8"));
    assert.equal(sent.length, 1, "the repair finding was sent to the same pane once");
    assert.match(sent[0], /WORKER_EVIDENCE_MISMATCH/); assert.match(sent[0], /backend\/docs\/note\.md/); assert.match(sent[0], /複数リポジトリのrunです/);
  } finally { await run.restore(); await run.cleanup(); }
}

{ // bad input is refused before a run directory, a pane, or any artifact exists
  const cases = [
    ["not an array", { repositories: "api" }, /Invalid repositories: repositories must be a nonempty array/],
    ["absolute path", { repositories: ["/tmp/api", "backend"] }, /Invalid repositories: .*relative paths/],
    ["parent path", { repositories: ["api", "../x"] }, /Invalid repositories: .*relative paths/],
    ["duplicate", { repositories: ["api", "api"] }, /Invalid repositories: .*duplicates/],
    ["nested", { repositories: ["api", "api/src"] }, /Invalid repositories: .*nested/],
    ["not a git root", { repositories: ["api", "docs"] }, /Invalid repositories: docs is not/],
    ["a subdirectory of a repository", { repositories: ["api/src"] }, /Invalid repositories: api\/src is not the root of a git work tree/],
    ["missing", { repositories: ["api", "nope"] }, /Invalid repositories: nope does not exist/],
    ["check cwd outside the repositories", { repositories: ["api"], qualityContract: { planItems: [{ id: "P", description: "x" }], requiredChecks: [{ id: "c", program: "true", args: [], cwd: "backend" }] } }, /Invalid qualityContract: .*one of repositories or inside one/],
  ];
  const noCwd = { planItems: [{ id: "P", description: "x" }], requiredChecks: [{ id: "c", program: "true", args: [] }] };
  for (const [name, overrides, expected] of cases) {
    const run = await runPipeline("happy", { qualityContract: noCwd, ...overrides });
    try {
      await assert.rejects(() => run.execute(), expected, name);
      await assert.rejects(() => stat(path.join(root, "artifacts", path.basename(run.ws))), `${name}: no artifact directory was created`);
      assert.equal((await run.readState()).splits, 0, `${name}: no pane was started`);
    } finally { await run.restore(); await run.cleanup(); }
  }
  // a check cwd without repositories
  const run = await runPipeline("happy", { repositories: undefined, qualityContract: { planItems: [{ id: "P", description: "x" }], requiredChecks: [{ id: "c", program: "true", args: [], cwd: "api" }] } });
  try {
    await assert.rejects(() => run.execute(), /Invalid qualityContract: requiredChecks cwd is only allowed when the run has repositories/);
    await assert.rejects(() => stat(path.join(root, "artifacts", path.basename(run.ws))));
  } finally { await run.restore(); await run.cleanup(); }
}
console.log("multi-repository sandbox and pipeline tests passed");
