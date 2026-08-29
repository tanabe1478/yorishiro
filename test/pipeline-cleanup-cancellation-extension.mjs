import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const root = path.resolve(new URL("..", import.meta.url).pathname);
const temp = await mkdtemp(path.join(os.tmpdir(), "yorishiro-production-cleanup-"));
const log = path.join(temp, "herdr.log"), closeLog = path.join(temp, "close.log"), gate = path.join(temp, "gate"), release = path.join(temp, "release"), bin = path.join(temp, "bin");
await writeFile(log, ""); await mkdir(bin); await writeFile(path.join(bin, "herdr"), `#!/usr/bin/env node
const fs=require("node:fs"), a=process.argv.slice(2), log=process.env.FAKE_LOG;
fs.appendFileSync(log, JSON.stringify(a)+"\\n");
const id=n=>"fake:split"+n, count=()=>fs.readFileSync(log,"utf8").split("\\n").filter(Boolean).map(x=>JSON.parse(x)).filter(x=>x[0]==="pane"&&x[1]==="split").length;
if(a[0]==="status") process.stdout.write("{}\\n");
else if(a[0]==="pane"&&a[1]==="split") process.stdout.write(JSON.stringify({result:{pane:{pane_id:id(count())}}})+"\\n");
else if(a[0]==="pane"&&a[1]==="run") { const f=(a[3]||a[2]).replace(/^['"]|['"]$/g,""); const stage=f.split("/").pop().split("-")[0], body=stage==="implement"?JSON.stringify({verdict:"COMPLETED",summary:"日本語の実装報告",changedScope:"変更なし",evidence:"確認済み",completedPlanItems:[{id:"PLAN-1",evidence:"項目を確認しました"}],changedPaths:[]}):JSON.stringify({verdict:"APPROVED",summary:"日本語のレビュー報告",blockingFindings:[],nonBlockingNotes:[],plannerQuestions:[]}); fs.writeFileSync(f.replace(/-launcher\\.sh$/, "-pending.json"), body); }
else if(a[0]==="pane"&&a[1]==="rename") process.stdout.write(JSON.stringify({result:{type:"pane_info",pane:{pane_id:a[2]}}})+"\\n");
else if(a[0]==="pane"&&a[1]==="layout") { const n=count(); process.stdout.write(JSON.stringify({result:{layout:{panes:["parent",...Array.from({length:n},(_,i)=>id(i+1))].map(pane_id=>({pane_id})),splits:[{direction:"right",ratio:.55},{direction:"down",ratio:.5},{direction:"down",ratio:.5}].slice(0,n),zoomed:false}}})+"\\n"); }
else if(a[0]==="pane"&&a[1]==="get") { const n=Number(a[2].replace("fake:split","")), names=["Worker · Luna","Reviewer · Sol"]; process.stdout.write(JSON.stringify({workspace_id:process.env.HERDR_WORKSPACE_ID,tab_id:process.env.HERDR_TAB_ID,name:names[n-1],agent_status:"idle"})+"\\n"); }
else if(a[0]==="pane"&&a[1]==="process-info") process.stdout.write('{"argv0":"pi"}\\n');
else if(a[0]==="agent"&&a[1]==="wait") process.stdout.write("{}\\n");
else if(a[0]==="agent"&&a[1]==="read") process.stdout.write("transcript\\n");
else if(a[0]==="pane"&&a[1]==="close") { fs.appendFileSync(process.env.CLOSE_LOG,a[2]+"\\n"); if(process.env.CLOSE_GATE==="1") { fs.writeFileSync(process.env.GATE_FILE, "ready"); while(!fs.existsSync(process.env.RELEASE_FILE)) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); } } }
`); await chmod(path.join(bin,"herdr"),0o755);
process.env.PATH=`${bin}:${process.env.PATH}`; process.env.FAKE_LOG=log; process.env.CLOSE_LOG=closeLog; process.env.GATE_FILE=gate; process.env.RELEASE_FILE=release; process.env.HERDR_PANE_ID="parent"; process.env.HERDR_TAB_ID="tab"; process.env.HERDR_WORKSPACE_ID="ws"; process.env.HERDR_SOCKET_PATH=path.join(temp,"socket"); await writeFile(process.env.HERDR_SOCKET_PATH,""); process.env.YORISHIRO_STAGE_TIMEOUT_MS="1000"; process.env.YORISHIRO_STARTUP_GRACE_MS="50"; process.env.YORISHIRO_POLL_INTERVAL_MS="1";
const tools=[]; const {default:load}=await import("../extensions/development-pipeline/index.ts"); load({registerTool(t){tools.push(t);}}); const pipeline=tools.find(t=>t.name==="development_pipeline"); assert.ok(pipeline);
async function waitFile(f){for(;;){try{await access(f);return;}catch{await new Promise(r=>setTimeout(r,1));}}}
async function runCase(kind){ await writeFile(log,""); await writeFile(closeLog,""); await rm(gate,{force:true}); await rm(release,{force:true}); delete process.env.CLOSE_GATE; const c=new AbortController(); let confirmed=0; const ctx={cwd:root, get hasUI(){if(kind==="before"){c.abort(); return false;} return true;}, ui:{confirm:async()=>{confirmed++; if(kind==="during"){await writeFile(gate,"confirm"); await waitFile(release);} if(kind==="after") c.abort(); return true;}}}; if(kind==="inside"){process.env.CLOSE_GATE="1";}
 const promise=pipeline.execute("id",{task:"production cleanup cancellation",approvedPlan:"approved",qualityContract:{planItems:[{id:"PLAN-1",description:"実装する"}],requiredChecks:[{id:"CHECK-1",program:"/usr/bin/true",args:[]}]},cwd:root,cleanupMode:"ask"},c.signal,()=>{},ctx); if(kind==="during"){await waitFile(gate); c.abort(); await writeFile(release,"");} if(kind==="inside"){await waitFile(gate); c.abort(); await writeFile(release,"");} const result=await promise, metadata=JSON.parse(await readFile(path.join(result.details.artifactDir,"run.json"),"utf8")), calls=(await readFile(log,"utf8")).trim().split("\n").filter(Boolean).map(x=>JSON.parse(x)); assert.equal(metadata.outcome,"ABORTED"); assert.equal(result.details.outcome,"ABORTED"); assert.match(result.content[0].text,/ABORTED/); assert.equal(confirmed,kind==="before"?0:1); const closes=(await readFile(closeLog,"utf8")).trim().split("\n").filter(Boolean); if(kind!=="inside") assert.deepEqual(closes,[]); else assert.deepEqual(closes,["fake:split2"]); if(kind==="inside") assert.equal(metadata.cleanup.results[0].status,"cancelled"); else assert.ok(metadata.cleanup.results.every(x=>x.status==="skipped")); await rm(result.details.artifactDir,{recursive:true,force:true}); }
for(const kind of ["before","during","after","inside"]) await runCase(kind);
await rm(temp,{recursive:true,force:true}); console.log("registered production cleanup cancellation test passed");
