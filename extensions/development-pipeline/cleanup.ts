import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Result = { paneId: string; name: string; status: string; reason?: string };
export const CLEANUP_ORDER = ["Review · Sol", "Verify · Terra", "Implement · Luna"] as const;
function command(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> { return new Promise(resolve => { const p = spawn("herdr", args, { shell: false, stdio: ["ignore", "pipe", "pipe"] }); let stdout="", stderr=""; p.stdout.on("data", d => stdout += d); p.stderr.on("data", d => stderr += d); p.on("error", e => resolve({code:1,stdout,stderr:stderr+e.message})); p.on("close", code => resolve({code:code ?? 1,stdout,stderr})); }); }
function parse(s: string): any { try { return JSON.parse(s); } catch { return undefined; } }
function field(value: unknown, names: string[]): string | undefined { if (!value || typeof value !== "object") return; const r=value as Record<string,unknown>; for (const n of names) if (typeof r[n] === "string") return r[n] as string; for (const v of Object.values(r)) { const found=field(v,names); if(found) return found; } }
async function atomic(file: string, value: unknown) { const tmp=`${file}.tmp-${process.pid}`; await fs.writeFile(tmp, JSON.stringify(value,null,2)); await fs.rename(tmp,file); }
export async function canonicalRun(runDir: string, root: string) { let run: string, base: string; try { [run, base] = await Promise.all([fs.realpath(runDir), fs.realpath(root)]); } catch { throw new Error("cleanup run or artifacts root is unavailable"); } const rel=path.relative(base,run); if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("cleanup run path is outside Yorishiro artifacts"); return run; }
export async function containedRun(runDir: string, root: string) { try { await canonicalRun(runDir,root); return true; } catch { return false; } }
export async function recordCleanupFailure(runDir: string, root: string, error: string) { try { const canonical=await canonicalRun(runDir,root), file=path.join(canonical,"run.json"), metadata=JSON.parse(await fs.readFile(file,"utf8")); metadata.cleanup={...(metadata.cleanup ?? {}), finishedAt:new Date().toISOString(), status:"failed", error}; await atomic(file,metadata); } catch { /* best effort only */ } }
export async function cleanupRun(runDir: string, root: string, currentPane?: string): Promise<{ results: Result[]; summary: string }> {
  const canonical=await canonicalRun(runDir,root);
  const results: Result[]=[], runFile=path.join(canonical,"run.json"); let metadata:any; try { metadata=JSON.parse(await fs.readFile(runFile,"utf8")); } catch { throw new Error("cleanup run.json is unreadable"); }
  if (metadata.outcome !== "SUCCESS") throw new Error("cleanup is permitted only for SUCCESS runs");
  if (!currentPane) throw new Error("current pane identity is required for cleanup");
  if (![metadata.parentPaneId,metadata.workspaceId,metadata.tabId].every(v=>typeof v === "string" && v.length>0)) throw new Error("cleanup run identity is incomplete");
  metadata.cleanup={ requestedAt:new Date().toISOString(), status:"running", results:[] }; await atomic(runFile,metadata);
  const panes=(metadata.panes ?? []) as Array<{paneId?:string;name?:string}>;
  for (const name of CLEANUP_ORDER) { const candidate=panes.find(p=>p.name===name); if(!candidate?.paneId) { results.push({paneId:candidate?.paneId ?? "",name,status:"skipped",reason:"pane is not recorded"}); continue; }
    if(candidate.paneId===metadata.parentPaneId || candidate.paneId===currentPane) { results.push({paneId:candidate.paneId,name,status:"skipped",reason:"parent/current pane protected"}); continue; }
    const infoResult=await command(["pane","get",candidate.paneId]), info=parse(infoResult.stdout); if(infoResult.code || !info) { results.push({paneId:candidate.paneId,name,status:"skipped",reason:"pane unavailable"}); continue; }
    const workspace=field(info,["workspace_id","workspaceId"]), tab=field(info,["tab_id","tabId"]), actualName=field(info,["name","title","label"]), state=field(info,["agent_status","agentStatus"]);
    if(!workspace || !tab || !actualName || !state) { results.push({paneId:candidate.paneId,name,status:"skipped",reason:"live pane identity is incomplete"}); continue; }
    if(workspace!==metadata.workspaceId || tab!==metadata.tabId || actualName!==name) { results.push({paneId:candidate.paneId,name,status:"skipped",reason:"pane identity changed"}); continue; }
    if(!["idle","done"].includes(state)) { results.push({paneId:candidate.paneId,name,status:"skipped",reason:`pane is ${state}`}); continue; }
    const closed=await command(["pane","close",candidate.paneId]); if(closed.code) results.push({paneId:candidate.paneId,name,status:"failed",reason:closed.stderr||closed.stdout||"close failed"}); else results.push({paneId:candidate.paneId,name,status:"closed"});
  }
  metadata.cleanup={ requestedAt:metadata.cleanup.requestedAt, finishedAt:new Date().toISOString(), status:results.every(r=>r.status==="closed")?"completed":"partial", results }; await atomic(runFile,metadata);
  return {results,summary:results.map(r=>`${r.name}: ${r.status}${r.reason?` (${r.reason})`:""}`).join("; ")};
}
export function registerCleanupTool(pi: ExtensionAPI, root: string) { pi.registerTool({ name:"development_pipeline_cleanup", label:"Development Pipeline Cleanup", description:"Safely close idle worker panes from a successful pipeline run.", parameters:Type.Object({runDir:Type.String({description:"Pipeline artifact run directory"})}), async execute(_id,input:{runDir:string},_signal,_update,ctx) { const result=await cleanupRun(input.runDir,path.join(root,"artifacts"),process.env.HERDR_PANE_ID); return {content:[{type:"text",text:`Cleanup: ${result.summary}`}],details:result}; } }); }
