export type WorkerVerdict = "COMPLETED" | "BLOCKED";
export type FindingRoute = "worker" | "planner";
export type ReviewerVerdict = "APPROVED" | "CHANGES_REQUESTED" | "NEEDS_PLANNER";
export type Priority = string;
export type WorkerReport = { verdict: WorkerVerdict; summary: string; changedScope: string; evidence: string };
export type Finding = { id: string; priority: Priority; target: string; problem: string; expectedOutcome: string; route: FindingRoute };
export type ReviewerReport = { verdict: ReviewerVerdict; summary: string; findings: Finding[]; plannerQuestions: string[] };
export type Validation = { valid: true } | { valid: false; error: string };
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
export function isCanonicalFindingId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value); }
function fail(error: string): Validation { return { valid: false, error }; }
function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exact(value: Record<string, unknown>, keys: readonly string[]) { const actual=Reflect.ownKeys(value); return actual.length === keys.length && keys.every(key=>Object.prototype.hasOwnProperty.call(value,key)) && actual.every(key=>typeof key === "string" && keys.includes(key)); }
export function validateWorkerReport(value: unknown): Validation {
  if (!plain(value) || !exact(value,["verdict","summary","changedScope","evidence"])) return fail("worker report must be a plain object with exact fields");
  const r=value as Record<string, unknown>;
  if (r.verdict !== "COMPLETED" && r.verdict !== "BLOCKED") return fail("worker verdict is invalid");
  if (!text(r.summary) || !text(r.changedScope) || !text(r.evidence)) return fail("worker summary, changedScope, and evidence are required");
  return {valid:true};
}
export function validateReviewerReport(value: unknown): Validation {
  if (!plain(value) || !exact(value,["verdict","summary","findings","plannerQuestions"])) return fail("reviewer report must be a plain object with exact fields");
  const r=value as Record<string, unknown>, findings=r.findings, questions=r.plannerQuestions;
  if (!["APPROVED","CHANGES_REQUESTED","NEEDS_PLANNER"].includes(String(r.verdict))) return fail("reviewer verdict is invalid");
  if (!text(r.summary) || !Array.isArray(findings) || !Array.isArray(questions) || !questions.every(text)) return fail("reviewer summary, findings, and plannerQuestions are required");
  const ids=new Set<string>();
  for (const item of findings) { if (!plain(item) || !exact(item,["id","priority","target","problem","expectedOutcome","route"])) return fail("review finding must have exact fields"); const f=item as Record<string,unknown>; if (!isCanonicalFindingId(f.id) || ids.has(f.id)) return fail("finding IDs must be canonical, unique, and nonempty"); ids.add(f.id); if (!text(f.priority)||!text(f.target)||!text(f.problem)||!text(f.expectedOutcome)||!( ["worker","planner"] as unknown[]).includes(f.route)) return fail("review finding fields are required"); }
  if (r.verdict === "APPROVED" && (findings.length || questions.length)) return fail("APPROVED cannot contain findings or plannerQuestions");
  if (r.verdict === "CHANGES_REQUESTED" && (!findings.length || questions.length || findings.some((f:any)=>f.route !== "worker"))) return fail("CHANGES_REQUESTED requires worker findings and no plannerQuestions");
  if (r.verdict === "NEEDS_PLANNER" && !(findings.some((f:any)=>f.route === "planner") || questions.length)) return fail("NEEDS_PLANNER requires planner escalation");
  return {valid:true};
}
export function workerHandoffFromReviewer(value: unknown): { findings: Array<Pick<Finding,"id"|"priority"|"target"|"problem"|"expectedOutcome"|"route">> } {
  const checked=validateReviewerReport(value); if (!checked.valid) throw new Error(checked.error);
  const r=value as ReviewerReport;
  if (r.verdict !== "CHANGES_REQUESTED") throw new Error("only CHANGES_REQUESTED may produce worker actions");
  return {findings:r.findings.map(f=>({id:f.id,priority:f.priority.trim(),target:f.target.trim(),problem:f.problem.trim(),expectedOutcome:f.expectedOutcome.trim(),route:"worker" as const}))};
}
export const sanitizeWorkerHandoff = workerHandoffFromReviewer;
