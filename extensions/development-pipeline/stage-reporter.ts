import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateReviewerReport, validateWorkerReport } from "./role-contracts.ts";

const VERDICTS: Record<string, string[]> = { plan: ["READY", "BLOCKED"], implement: ["COMPLETED", "BLOCKED"], verify: ["PASS", "FAIL"], review: ["APPROVED", "CHANGES_REQUESTED"] };
export let atomicWriteBeforeRenameHook: (() => void | Promise<void>) | undefined;
export function setAtomicWriteBeforeRenameHook(hook: (() => void | Promise<void>) | undefined) { atomicWriteBeforeRenameHook=hook; }
async function atomicWrite(file: string, content: string) { const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${randomUUID()}`); let handle: Awaited<ReturnType<typeof fs.open>> | undefined; try { handle=await fs.open(tmp,"wx",0o600); await handle.writeFile(content,{encoding:"utf8"}); await handle.close(); handle=undefined; await atomicWriteBeforeRenameHook?.(); await fs.rename(tmp,file); } finally { await handle?.close().catch(()=>{}); await fs.rm(tmp,{force:true}).catch(()=>{}); } }
async function canonicalTarget(file: string): Promise<string> {
  if (!path.isAbsolute(file)) throw new Error("Scoped report path is invalid");
  const rootInput=process.env.YORISHIRO_REPORT_ROOT ?? path.dirname(file), root=await fs.realpath(rootInput).catch(()=>{throw new Error("Scoped report root is unavailable")});
  const parent=await fs.realpath(path.dirname(file)).catch(()=>{throw new Error("Scoped report parent is unavailable")});
  const relative=path.relative(root,parent); if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Scoped report path is invalid");
  const target=path.join(parent,path.basename(file));
  try { const stat=await fs.lstat(target); if (!stat.isFile()) throw new Error("Scoped report target is not a regular file"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return target;
}
function json(value: unknown) { return JSON.stringify(value, null, 2); }
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "submit_stage_report", label: "Submit Stage Report", description: "Write the final scoped pipeline report. This is the only durable write available to read-only stages.",
    parameters: Type.Object({ verdict: Type.String({ description: "The exact verdict for this stage" }), summary: Type.String({ description: "Concise summary" }), evidence: Type.Optional(Type.String({ description: "Concise evidence and limitations" })), changedScope: Type.Optional(Type.String({ description: "Worker changed-scope summary" })), findings: Type.Optional(Type.Array(Type.Object({ id: Type.String(), priority: Type.String(), target: Type.String(), problem: Type.String(), expectedOutcome: Type.String(), route: Type.String() }))), plannerQuestions: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, input: any) {
      const file = process.env.YORISHIRO_REPORT_PATH, stage = process.env.YORISHIRO_REPORT_STAGE, schema = process.env.YORISHIRO_REPORT_SCHEMA ?? "legacy";
      if (!file || !stage) throw new Error("Scoped stage reporting is not configured");
      const target=await canonicalTarget(file);
      if (schema === "worker") {
        const checked=validateWorkerReport(input); if (!checked.valid) throw new Error(checked.error); const report=input;
        const text=`# worker report\n\n## Summary\n${report.summary.trim()}\n\n## Changed scope\n${report.changedScope.trim()}\n\n## Evidence\n${report.evidence.trim()}\n\nVERDICT: ${report.verdict}\n`; await atomicWrite(target,text); return {content:[{type:"text",text:"Submitted worker report."}],details:{file,schema}};
      }
      if (schema === "reviewer") {
        const checked=validateReviewerReport(input); if (!checked.valid) throw new Error(checked.error); const report=input;
        const text=`# reviewer report\n\n## Summary\n${report.summary.trim()}\n\n## Findings\n${json(report.findings)}\n\n## Planner questions\n${json(report.plannerQuestions)}\n\nVERDICT: ${report.verdict}\n`; await atomicWrite(target,text); return {content:[{type:"text",text:"Submitted reviewer report."}],details:{file,schema}};
      }
      if (!VERDICTS[stage] || !VERDICTS[stage].includes(input.verdict)) throw new Error(`Invalid ${stage} verdict`);
      const report=`# ${stage} report\n\n## Summary\n${input.summary.trim()}\n\n## Evidence\n${input.evidence.trim()}\n\nVERDICT: ${input.verdict}\n`; await atomicWrite(target,report); return {content:[{type:"text",text:`Submitted ${stage} report.`}],details:{file}};
    },
  });
}
