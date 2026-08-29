import assert from "node:assert/strict";
const { resolveReviewBudget, transitionAfterReview } = await import("../extensions/development-pipeline/three-role-flow.ts");
const f = (id, discovery = "initial", route = "worker") => ({ id, severity: "high", target: "src/a.ts", reproduction: "再現手順", userImpact: "影響があります", expectedOutcome: "修正します", route, discovery });
const base = { summary: "日本語のレビュー要約", blockingFindings: [], nonBlockingNotes: [], plannerQuestions: [] };
const expected = (outcome, repeatedIds, reviewIds, budget, plannerReason) => ({ outcome, repeatedIds, ...(plannerReason ? { plannerReason } : {}), reviewIds, budget });
assert.deepEqual(transitionAfterReview({ ...base, verdict: "APPROVED" }), expected("SUCCESS", [], [], 2));
assert.deepEqual(transitionAfterReview({ ...base, verdict: "APPROVED_WITH_NOTES", nonBlockingNotes: [{ id: "N1", severity: "low", target: "src/a.ts", note: "改善できます" }] }), expected("SUCCESS", [], [], 2));
assert.deepEqual(transitionAfterReview({ ...base, verdict: "NEEDS_PLANNER", blockingFindings: [f("P", "initial", "planner")] }), expected("NEEDS_PLANNER", [], ["P"], 2, "Plannerの判断が必要です。"));
assert.deepEqual(transitionAfterReview({ ...base, verdict: "CHANGES_REQUESTED", blockingFindings: [f("R1")] }, ["R1"], 0), expected("NEEDS_PLANNER", ["R1"], ["R1"], 2, "同一の指摘が再発したためPlannerの判断が必要です。"));
assert.deepEqual(transitionAfterReview({ ...base, verdict: "CHANGES_REQUESTED", blockingFindings: [f("R2", "repair_regression")] }, [], 0), expected("WORKER_REPAIR", [], ["R2"], 2));
assert.deepEqual(transitionAfterReview({ ...base, verdict: "CHANGES_REQUESTED", blockingFindings: [f("R2", "repair_regression")] }, [], 2), expected("CHANGES_REQUIRED", [], ["R2"], 2));
assert.deepEqual(transitionAfterReview({ ...base, verdict: "CHANGES_REQUESTED", blockingFindings: [f("N2", "initial")] }, [], 1), expected("NEEDS_PLANNER", [], ["N2"], 2, "修正後レビューで新規指摘が発生したためPlannerの判断が必要です。"));
assert.deepEqual(transitionAfterReview({ ...base, verdict: "CHANGES_REQUESTED", blockingFindings: [f("R3", "previously_missed")] }, [], 1), expected("WORKER_REPAIR", [], ["R3"], 2));
for (const invalidCycle of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) assert.throws(() => transitionAfterReview({ ...base, verdict: "APPROVED" }, [], invalidCycle), RangeError);
assert.equal(resolveReviewBudget(), 2); assert.equal(resolveReviewBudget({ maxReviewCycles: 3 }), 3); assert.equal(resolveReviewBudget({ maxReviewCycles: 9 }), 3); assert.equal(resolveReviewBudget({ maxReviewCycles: 1, maxRepairCycles: 3 }), 1); assert.equal(resolveReviewBudget({ maxRepairCycles: 1 }), 1); assert.equal(resolveReviewBudget({ maxRepairCycles: 9 }), 3); assert.equal(resolveReviewBudget({ maxReviewCycles: -2 }), 0); assert.throws(() => resolveReviewBudget({ maxReviewCycles: Number.NaN }), /finite/); assert.throws(() => resolveReviewBudget({ maxReviewCycles: Number.POSITIVE_INFINITY }), /finite/);
for (const budget of [0, 1, 2, 3]) { const result = transitionAfterReview({ ...base, verdict: "CHANGES_REQUESTED", blockingFindings: [f(`B${budget}`, "repair_regression")] }, [], budget, { maxReviewCycles: budget }); assert.equal(result.outcome, "CHANGES_REQUIRED"); assert.equal(result.budget, budget); }
console.log("bounded three-role flow tests passed");
