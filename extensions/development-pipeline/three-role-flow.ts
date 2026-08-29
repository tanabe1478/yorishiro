import type { ReviewerReport } from "./role-contracts.ts";
export type ReviewTransition = "SUCCESS" | "NEEDS_PLANNER" | "WORKER_REPAIR" | "CHANGES_REQUIRED";
export type ReviewBudgetOptions = { maxReviewCycles?: number; maxRepairCycles?: number };
export type ReviewTransitionResult = { outcome: ReviewTransition; repeatedIds: string[]; plannerReason?: string; reviewIds: string[]; budget: number };
/** maxReviewCycles wins when supplied; maxRepairCycles is the legacy fallback; default is 2 and the hard cap is 3. */
export function resolveReviewBudget(options: ReviewBudgetOptions = {}): number {
  const requested=options.maxReviewCycles ?? options.maxRepairCycles ?? 2;
  if (typeof requested !== "number" || !Number.isFinite(requested)) throw new RangeError("review budget must be finite");
  return Math.max(0, Math.min(3, Math.trunc(requested)));
}
export function transitionAfterReview(review: ReviewerReport, previousReviewIds: readonly string[] = [], cycle = 0, options: ReviewBudgetOptions = {}): ReviewTransitionResult {
  if (typeof cycle !== "number" || !Number.isFinite(cycle) || !Number.isInteger(cycle) || cycle < 0) throw new RangeError("review cycle must be a finite non-negative integer");
  const budget=resolveReviewBudget(options);
  const reviewIds=review.blockingFindings.map(f=>f.id);
  const previous=new Set(previousReviewIds), repeatedIds=reviewIds.filter(id=>previous.has(id));
  const newInitialIds=cycle > 0 ? review.blockingFindings.filter(f=>f.discovery === "initial" && !previous.has(f.id)).map(f=>f.id) : [];
  let outcome: ReviewTransition, plannerReason: string | undefined;
  if (review.verdict === "APPROVED" || review.verdict === "APPROVED_WITH_NOTES") outcome="SUCCESS";
  else if (review.verdict === "NEEDS_PLANNER") { outcome="NEEDS_PLANNER"; plannerReason="Plannerの判断が必要です。"; }
  else if (repeatedIds.length) { outcome="NEEDS_PLANNER"; plannerReason="同一の指摘が再発したためPlannerの判断が必要です。"; }
  else if (newInitialIds.length) { outcome="NEEDS_PLANNER"; plannerReason="修正後レビューで新規指摘が発生したためPlannerの判断が必要です。"; }
  else outcome=cycle < budget ? "WORKER_REPAIR" : "CHANGES_REQUIRED";
  return { outcome, repeatedIds, ...(plannerReason ? { plannerReason } : {}), reviewIds, budget };
}
export const boundedReviewTransition = transitionAfterReview;
