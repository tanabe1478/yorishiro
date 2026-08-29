import type { ReviewerReport } from "./role-contracts.ts";
export type ReviewTransition = "SUCCESS" | "NEEDS_PLANNER" | "WORKER_REPAIR" | "CHANGES_REQUIRED";
export type ReviewBudgetOptions = { maxReviewCycles?: number; maxRepairCycles?: number };
/** maxReviewCycles wins when supplied; maxRepairCycles is the legacy fallback; default is 2 and the hard cap is 3. */
export function resolveReviewBudget(options: ReviewBudgetOptions = {}): number {
  const requested=options.maxReviewCycles ?? options.maxRepairCycles ?? 2;
  if (typeof requested !== "number" || !Number.isFinite(requested)) throw new RangeError("review budget must be finite");
  return Math.max(0, Math.min(3, Math.trunc(requested)));
}
export function transitionAfterReview(review: ReviewerReport, previousReviewIds: readonly string[] = [], cycle = 0, options: ReviewBudgetOptions = {}) {
  const repeatedIds=review.findings.map(f=>f.id).filter(id=>previousReviewIds.includes(id));
  if (review.verdict === "APPROVED") return {outcome:"SUCCESS" as const, repeatedIds};
  if (review.verdict === "NEEDS_PLANNER" || repeatedIds.length) return {outcome:"NEEDS_PLANNER" as const, repeatedIds};
  return {outcome:cycle < resolveReviewBudget(options) ? "WORKER_REPAIR" as const : "CHANGES_REQUIRED" as const, repeatedIds};
}
export const boundedReviewTransition = transitionAfterReview;
