export type WorkerVerdict = "COMPLETED" | "BLOCKED";
export type FindingRoute = "worker" | "planner";
export type ReviewerVerdict = "APPROVED" | "APPROVED_WITH_NOTES" | "CHANGES_REQUESTED" | "NEEDS_PLANNER";
import type { QualityContract } from "./quality-contract.ts";
import { isRepositoryRelativePath } from "./quality-contract.ts";

export type WorkerPlanItem = { id: string; evidence: string };
export type WorkerReport = { verdict: WorkerVerdict; summary: string; changedScope: string; evidence: string; completedPlanItems: WorkerPlanItem[]; changedPaths: string[] };
export type FindingDiscovery = "initial" | "repair_regression" | "previously_missed";
export type FindingSeverity = "critical" | "high" | "medium" | "low";
export type BlockingFinding = { id: string; severity: "critical" | "high"; target: string; reproduction: string; userImpact: string; expectedOutcome: string; route: FindingRoute; discovery: FindingDiscovery; missedReason?: string };
export type NonBlockingNote = { id: string; severity: "medium" | "low"; target: string; note: string };
export type ReviewerReport = { verdict: ReviewerVerdict; summary: string; blockingFindings: BlockingFinding[]; nonBlockingNotes: NonBlockingNote[]; plannerQuestions: string[] };
export type Validation = { valid: true } | { valid: false; error: string };

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const japanese = (value: unknown): value is string => text(value) && /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(value);
export function isCanonicalFindingId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value); }
function fail(error: string): Validation { return { valid: false, error }; }
function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exact(value: Record<string, unknown>, keys: readonly string[]) { const actual=Reflect.ownKeys(value); return actual.length === keys.length && keys.every(key=>Object.prototype.hasOwnProperty.call(value,key)) && actual.every(key=>typeof key === "string" && keys.includes(key)); }
function exactFieldDiagnostic(value: unknown, keys: readonly string[], label: string): string {
  const actual = value && typeof value === "object" && !Array.isArray(value) ? Reflect.ownKeys(value as object).map(String) : [];
  const missing = keys.filter(key => !actual.includes(key));
  const unexpected = actual.filter(key => !keys.includes(key));
  return `${label} has exact fields; expected=[${keys.join(", ")}]; missing=[${missing.join(", ")}]; unexpected=[${unexpected.join(", ")}]`;
}
function exactFailure(value: unknown, keys: readonly string[], label: string): string | undefined {
  if (!plain(value)) return exactFieldDiagnostic(value, keys, label);
  return exact(value, keys) ? undefined : exactFieldDiagnostic(value, keys, label);
}

export function validateWorkerReport(value: unknown, contract?: QualityContract): Validation {
  const fields=["verdict","summary","changedScope","evidence","completedPlanItems","changedPaths"] as const;
  const fieldError=exactFailure(value,fields,"worker report"); if (fieldError) return fail(fieldError);
  const r=value as Record<string, unknown>, items=r.completedPlanItems, paths=r.changedPaths;
  if (r.verdict !== "COMPLETED" && r.verdict !== "BLOCKED") return fail("worker verdict is invalid");
  if (!japanese(r.summary) || !japanese(r.changedScope) || !japanese(r.evidence)) return fail("worker summary, changedScope, and evidence must be Japanese and nonempty");
  if (!Array.isArray(items)) return fail("completedPlanItems must be an array");
  for (const item of items) {
    const itemFieldError=exactFailure(item,["id","evidence"],"completedPlanItems item");
    if (itemFieldError) return fail(itemFieldError);
    if (!text((item as Record<string,unknown>).id) || !japanese((item as Record<string,unknown>).evidence)) return fail("completedPlanItems must contain exact canonical IDs and Japanese evidence");
  }
  const planIds=(items as Record<string,unknown>[]).map(item=>item.id as string);
  if (new Set(planIds).size !== planIds.length) return fail("completedPlanItems IDs must be unique");
  if (!Array.isArray(paths) || !paths.every(isRepositoryRelativePath) || new Set(paths).size !== paths.length) return fail("changedPaths must be unique repository-relative paths");
  if (contract) {
    const contractIds=new Set(contract.planItems.map(item=>item.id));
    if (planIds.some(item=>!contractIds.has(item))) return fail("completedPlanItems contains an unknown quality contract ID");
    if (r.verdict === "COMPLETED" && planIds.length !== contractIds.size) return fail("COMPLETED completedPlanItems IDs must exactly match the quality contract");
  }
  return {valid:true};
}

function validateBlocking(item: unknown, ids: Set<string>): Validation {
  const discovery=plain(item) ? (item as Record<string,unknown>).discovery : undefined;
  const keys=discovery === "previously_missed" ? ["id","severity","target","reproduction","userImpact","expectedOutcome","route","discovery","missedReason"] : ["id","severity","target","reproduction","userImpact","expectedOutcome","route","discovery"];
  const fieldError=exactFailure(item,keys,"blocking finding"); if (fieldError) return fail(fieldError);
  const f=item as Record<string, unknown>;
  if (!isCanonicalFindingId(f.id) || ids.has(f.id)) return fail("finding IDs must be canonical, unique, and nonempty");
  if (f.severity !== "critical" && f.severity !== "high") return fail("blocking severity is invalid");
  if (!text(f.target)) return fail("blocking target is required");
  if (!japanese(f.reproduction) || !japanese(f.userImpact) || !japanese(f.expectedOutcome)) return fail("blocking human fields must be Japanese");
  if (f.route !== "worker" && f.route !== "planner") return fail("finding route is invalid");
  if (!["initial","repair_regression","previously_missed"].includes(String(discovery))) return fail("finding discovery is invalid");
  if (discovery === "previously_missed" && !japanese(f.missedReason)) return fail("missedReason is required in Japanese");
  ids.add(f.id as string);
  return {valid:true};
}
function validateNote(item: unknown, ids: Set<string>): Validation {
  const keys=["id","severity","target","note"] as const;
  const fieldError=exactFailure(item,keys,"non-blocking note"); if (fieldError) return fail(fieldError);
  const n=item as Record<string, unknown>;
  if (!isCanonicalFindingId(n.id) || ids.has(n.id)) return fail("note IDs must be canonical, unique, and nonempty");
  if (n.severity !== "medium" && n.severity !== "low") return fail("note severity is invalid");
  if (!text(n.target)) return fail("note target is required");
  if (!japanese(n.note)) return fail("note must be Japanese");
  ids.add(n.id as string);
  return {valid:true};
}
export function validateReviewerReport(value: unknown): Validation {
  const fields=["verdict","summary","blockingFindings","nonBlockingNotes","plannerQuestions"] as const;
  const fieldError=exactFailure(value,fields,"reviewer report"); if (fieldError) return fail(fieldError);
  const r=value as Record<string, unknown>, blocking=r.blockingFindings, notes=r.nonBlockingNotes, questions=r.plannerQuestions;
  if (!["APPROVED","APPROVED_WITH_NOTES","CHANGES_REQUESTED","NEEDS_PLANNER"].includes(String(r.verdict))) return fail("reviewer verdict is invalid");
  if (!japanese(r.summary) || !Array.isArray(blocking) || !Array.isArray(notes) || !Array.isArray(questions) || !questions.every(japanese)) return fail("reviewer human fields are required in Japanese");
  const ids=new Set<string>();
  for (const item of blocking) { const checked=validateBlocking(item,ids); if (!checked.valid) return checked; }
  for (const item of notes) { const checked=validateNote(item,ids); if (!checked.valid) return checked; }
  const verdict=r.verdict as ReviewerVerdict;
  if (verdict === "APPROVED" && (blocking.length || notes.length || questions.length)) return fail("APPROVED cannot contain findings, notes, or plannerQuestions");
  if (verdict === "APPROVED_WITH_NOTES" && (!notes.length || blocking.length || questions.length)) return fail("APPROVED_WITH_NOTES requires notes only");
  if (verdict === "CHANGES_REQUESTED" && (!blocking.length || questions.length || blocking.some((f:any)=>f.route !== "worker"))) return fail("CHANGES_REQUESTED requires worker findings and no plannerQuestions");
  if (verdict === "NEEDS_PLANNER" && !(blocking.some((f:any)=>f.route === "planner") || questions.length)) return fail("NEEDS_PLANNER requires planner escalation");
  return {valid:true};
}
export function workerHandoffFromReviewer(value: unknown): { findings: BlockingFinding[] } {
  const checked=validateReviewerReport(value); if (!checked.valid) throw new Error(checked.error);
  const r=value as ReviewerReport;
  if (r.verdict !== "CHANGES_REQUESTED") throw new Error("only CHANGES_REQUESTED may produce worker actions");
  return {findings:r.blockingFindings.map(f=>({ ...f, route:"worker" as const }))};
}
export const sanitizeWorkerHandoff = workerHandoffFromReviewer;
