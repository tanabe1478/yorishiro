import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { reviewPlan, reviewDiff, resolveReviewMode } from "../extensions/development-pipeline/human-review-gates.ts";

assert.equal(resolveReviewMode(), "ask");
assert.equal(resolveReviewMode("skip"), "skip");
assert.throws(() => resolveReviewMode("bad"));
const content = "# 日本語の計画\n\n実装します。";
const expectedHash = createHash("sha256").update(content).digest("hex");
function busFor(statuses, seen = []) { return { emit(name, request) { seen.push({ name, requestId: request.requestId, action: request.action, payload: request.payload }); const status = statuses.shift() ?? { result: { status: "pending", reviewId: "review-1" } }; setTimeout(() => request.respond(status), 0); } }; }

let confirms = 0;
const skipped = await reviewPlan({ mode: "skip", planContent: content, planFilePath: "plan.md", origin: "parent", confirm: () => { confirms++; return true; }, eventBus: busFor([]) });
assert.equal(skipped.decision, "skipped"); assert.equal(confirms, 0);
const unavailable = await reviewPlan({ mode: "ask", planContent: content, planFilePath: "plan.md", origin: "parent", eventBus: busFor([]) });
assert.equal(unavailable.decision, "unavailable");
confirms = 0;
const asked = await reviewPlan({ mode: "ask", confirm: () => { confirms++; return false; }, planContent: content, planFilePath: "plan.md", origin: "parent", eventBus: busFor([]) });
assert.equal(asked.decision, "skipped"); assert.equal(confirms, 1);

const events = [];
const approved = await reviewPlan({ mode: "required", requestId: "request-1", planContent: content, planFilePath: "plan.md", origin: "parent", eventBus: busFor([{ result: { status: "pending", reviewId: "review-1" } }, { result: { status: "pending", reviewId: "review-1" } }, { result: { status: "completed", reviewId: "review-1", approved: true } }], events), pollIntervalMs: 0, sleep: async () => {}, now: () => new Date("2026-01-01T00:00:00Z") });
assert.equal(approved.decision, "approved"); assert.equal(approved.hash, expectedHash); assert.equal(approved.reviewId, "review-1"); assert.equal(approved.approvedAt, "2026-01-01T00:00:00.000Z");
assert.deepEqual(events.map(({ respond, ...event }) => event), [
  { name: "plannotator:request", requestId: "request-1", action: "plan-review", payload: { planContent: content, planFilePath: "plan.md", origin: "parent" } },
  { name: "plannotator:request", requestId: "request-1", action: "review-status", payload: { reviewId: "review-1" } },
  { name: "plannotator:request", requestId: "request-1", action: "review-status", payload: { reviewId: "review-1" } },
]);
const rejected = await reviewPlan({ mode: "required", planContent: content, planFilePath: "plan.md", origin: "parent", eventBus: busFor([{ result: { status: "pending", reviewId: "r" } }, { result: { status: "completed", reviewId: "r", approved: false, feedback: "日本語feedback" } }]), pollIntervalMs: 0, sleep: async () => {} });
assert.equal(rejected.decision, "rejected"); assert.equal(rejected.feedback, "日本語feedback");
const unavailablePlan = await reviewPlan({ mode: "required", planContent: content, planFilePath: "plan.md", origin: "parent", eventBus: busFor([{ result: { status: "pending", reviewId: "r" } }, { result: { status: "unavailable", reviewId: "r" } }]), pollIntervalMs: 0, sleep: async () => {} });
assert.equal(unavailablePlan.decision, "unavailable");
const errorPlan = await reviewPlan({ mode: "required", planContent: content, planFilePath: "plan.md", origin: "parent", eventBus: { emit: async () => { throw new Error("event failed"); } } });
assert.equal(errorPlan.decision, "error");
const abortController = new AbortController(); const abortedPlan = await reviewPlan({ mode: "required", planContent: content, planFilePath: "plan.md", origin: "parent", signal: abortController.signal, eventBus: { emit(_name, request) { setTimeout(() => { if (request.action === "plan-review") request.respond({ result: { status: "pending", reviewId: "r" } }); else { abortController.abort(); request.respond({ result: { status: "pending", reviewId: "r" } }); } }, 0); } }, pollIntervalMs: 0, sleep: async () => {} });
assert.equal(abortedPlan.decision, "aborted");
let clock = 0; const timedOut = await reviewPlan({ mode: "required", planContent: content, planFilePath: "plan.md", origin: "parent", timeoutMs: 1, now: () => new Date(clock++), eventBus: busFor([{ result: { status: "pending", reviewId: "r" } }]), pollIntervalMs: 0, sleep: async () => {} });
assert.equal(timedOut.decision, "timeout");

let execCall; const diff = await reviewDiff({ mode: "required", cwd: "/repo", exec: async (command, args, signal) => { execCall = { command, args, signal }; return { code: 0, stdout: 'DIFFAI_REVIEW_RESULT={"decision":"approved","feedback":"日本語feedback","replyFile":"reply.md"}\n' }; } });
assert.equal(diff.decision, "approved"); assert.equal(diff.feedback, "日本語feedback"); assert.equal(diff.replyFile, "reply.md"); assert.deepEqual(execCall.args, ["--yes", "github:tanabe1478/diffai", "--cwd", "/repo"]);
const changes = await reviewDiff({ mode: "ask", confirm: () => true, cwd: "/repo", exec: async () => ({ code: 0, stdout: 'DIFFAI_REVIEW_RESULT={"decision":"changes_requested","summary":"日本語feedback"}' }) }); assert.equal(changes.decision, "changes_requested");
for (const stdout of ["", "DIFFAI_REVIEW_RESULT=bad", 'DIFFAI_REVIEW_RESULT={"decision":"other"}']) assert.equal((await reviewDiff({ mode: "required", cwd: "/repo", exec: async () => ({ code: 0, stdout }) })).decision, "invalid");
assert.equal((await reviewDiff({ mode: "required", cwd: "/repo", exec: async () => ({ code: 2, stdout: "", stderr: "failed" }) })).decision, "unavailable");
const diffAbort = new AbortController(); diffAbort.abort(); assert.equal((await reviewDiff({ mode: "required", cwd: "/repo", signal: diffAbort.signal, exec: async () => ({ code: 0, stdout: "" }) })).decision, "aborted");
assert.equal((await reviewDiff({ mode: "skip", cwd: "/repo", exec: async () => { throw new Error("must not run"); } })).decision, "skipped");
console.log("human review gates module tests passed");
