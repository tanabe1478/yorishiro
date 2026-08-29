export type WorkerVerdict = "COMPLETED" | "BLOCKED";
export type FindingRoute = "worker" | "planner";
export type ReviewerVerdict = "APPROVED" | "APPROVED_WITH_NOTES" | "CHANGES_REQUESTED" | "NEEDS_PLANNER";
export type WorkerReport = { verdict: WorkerVerdict; summary: string; changedScope: string; evidence: string };
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

export function validateWorkerReport(value: unknown): Validation {
  if (!plain(value) || !exact(value,["verdict","summary","changedScope","evidence"])) return fail("worker report must be a plain object with exact fields");
  const r=value as Record<string, unknown>;
  if (r.verdict !== "COMPLETED" && r.verdict !== "BLOCKED") return fail("worker verdict is invalid");
  if (!text(r.summary) || !text(r.changedScope) || !text(r.evidence)) return fail("worker summary, changedScope, and evidence are required");
  return {valid:true};
}

function validateBlocking(item: unknown, ids: Set<string>): Validation {
  if (!plain(item)) return fail("blocking finding must be a plain object");
  const f=item as Record<string, unknown>, discovery=f.discovery;
  const keys=discovery === "previously_missed" ? ["id","severity","target","reproduction","userImpact","expectedOutcome","route","discovery","missedReason"] : ["id","severity","target","reproduction","userImpact","expectedOutcome","route","discovery"];
  if (!exact(f,keys)) return fail("blocking finding has exact fields");
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
  if (!plain(item) || !exact(item,["id","severity","target","note"])) return fail("non-blocking note has exact fields");
  const n=item as Record<string, unknown>;
  if (!isCanonicalFindingId(n.id) || ids.has(n.id)) return fail("note IDs must be canonical, unique, and nonempty");
  if (n.severity !== "medium" && n.severity !== "low") return fail("note severity is invalid");
  if (!text(n.target)) return fail("note target is required");
  if (!japanese(n.note)) return fail("note must be Japanese");
  ids.add(n.id as string);
  return {valid:true};
}
export function validateReviewerReport(value: unknown): Validation {
  if (!plain(value) || !exact(value,["verdict","summary","blockingFindings","nonBlockingNotes","plannerQuestions"])) return fail("reviewer report must have exact fields");
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
