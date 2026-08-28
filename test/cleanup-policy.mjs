import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, symlink, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const { containedRun, cleanupRun, recordCleanupFailure, CLEANUP_ORDER } = await import("../extensions/development-pipeline/cleanup.ts");
const { shouldCleanup } = await import("../extensions/development-pipeline/cleanup-policy.ts");
const base = await mkdtemp(path.join(os.tmpdir(), "yorishiro-cleanup-"));
const root = path.join(base, "artifacts"); await mkdir(root); const outside = path.join(base, "outside"); await mkdir(outside);
const escaped = path.join(root, "link"); await symlink(outside, escaped);
assert.equal(await containedRun(path.join(root, "missing"), root), false);
assert.equal(await containedRun(escaped, root), false, "symlink escape must be rejected");
assert.equal([...CLEANUP_ORDER].join(","), "Review · Sol,Verify · Terra,Implement · Luna");
assert.equal(shouldCleanup("SUCCESS", "on-success", false, false), true);
assert.equal(shouldCleanup("SUCCESS", "never", true, true), false);
assert.equal(shouldCleanup("SUCCESS", "ask", false, true), false);
assert.equal(shouldCleanup("SUCCESS", "ask", true, false), false);
assert.equal(shouldCleanup("ABORTED", "on-success", true, true), false);
const bin = path.join(base, "bin"); await mkdir(bin); const log = path.join(base, "close.log");
await writeFile(path.join(bin, "herdr"), `#!/bin/sh
if [ "$1" = pane ] && [ "$2" = get ]; then
 case "$3" in
  review) echo '{"workspace_id":"ws","tab_id":"tab","name":"Review · Sol","agent_status":"idle"}' ;;
  verify) echo '{"workspace_id":"ws","tab_id":"tab","name":"Verify · Terra","agent_status":"idle"}' ;;
  implement) echo '{"workspace_id":"ws","tab_id":"tab","name":"Implement · Luna","agent_status":"working"}' ;;
  changed) echo '{"workspace_id":"other","tab_id":"tab","name":"Review · Sol","agent_status":"idle"}' ;;
  missinglive) echo '{"tab_id":"tab","name":"Review · Sol","agent_status":"idle"}' ;;
 esac
 exit 0
fi
if [ "$1" = pane ] && [ "$2" = close ]; then echo "$3" >> "\${CLOSE_LOG}"; [ "$3" = verify ] && exit 1; exit 0; fi
exit 1
`); await chmod(path.join(bin, "herdr"), 0o755); process.env.PATH = `${bin}:${process.env.PATH}`; process.env.CLOSE_LOG = log;
async function makeRun(name, outcome, panes) { const dir=path.join(root,name); await mkdir(dir); await writeFile(path.join(dir,"run.json"),JSON.stringify({outcome,parentPaneId:"parent",workspaceId:"ws",tabId:"tab",panes})); return dir; }
const badRun = await makeRun("bad", "ABORTED", []); await assert.rejects(() => cleanupRun(badRun, root), /SUCCESS/);
const run = await makeRun("good", "SUCCESS", [{paneId:"review",name:"Review · Sol"},{paneId:"verify",name:"Verify · Terra"},{paneId:"implement",name:"Implement · Luna"}]);
const result=await cleanupRun(run,root,"verify"); assert.deepEqual(result.results.map(r=>r.status),["closed","skipped","skipped"]); assert.match(result.summary,/Review · Sol: closed/); assert.match(result.summary,/parent\/current pane protected|working/);
const run2=await makeRun("partial", "SUCCESS", [{paneId:"review",name:"Review · Sol"},{paneId:"verify",name:"Verify · Terra"}]); const partial=await cleanupRun(run2,root,"other"); assert.equal(partial.results[0].status,"closed"); assert.equal(partial.results[1].status,"failed"); assert.match(partial.summary,/Implement · Luna: skipped/); assert.match(await readFile(log,"utf8"),/^review\nreview\nverify\n/m);
const run3=await makeRun("changed", "SUCCESS", [{paneId:"changed",name:"Review · Sol"}]); const changed=await cleanupRun(run3,root,"other"); assert.equal(changed.results[0].status,"skipped"); assert.match(changed.summary,/identity changed/);
const run4=await makeRun("missing-live", "SUCCESS", [{paneId:"missinglive",name:"Review · Sol"}]); const missingLive=await cleanupRun(run4,root,"other"); assert.equal(missingLive.results[0].status,"skipped"); assert.match(missingLive.summary,/identity is incomplete/);
const missingRun=await makeRun("missing-run", "SUCCESS", []); const missingMetadata=JSON.parse(await readFile(path.join(missingRun,"run.json"),"utf8")); delete missingMetadata.workspaceId; await writeFile(path.join(missingRun,"run.json"),JSON.stringify(missingMetadata)); await assert.rejects(() => cleanupRun(missingRun,root,"current"),/run identity is incomplete/);
await recordCleanupFailure(run3,root,"simulated confirmation failure"); assert.equal(JSON.parse(await readFile(path.join(run3,"run.json"),"utf8")).cleanup.status,"failed");
await rm(base,{recursive:true,force:true}); console.log("cleanup policy and safety test passed");
