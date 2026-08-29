import assert from "node:assert/strict";
const { validateWorkerReport, validateReviewerReport, workerHandoffFromReviewer } = await import("../extensions/development-pipeline/role-contracts.ts");

const worker = { verdict: "COMPLETED", summary: "日本語の完了報告", changedScope: "ソース変更のみ", evidence: "テスト成功", completedPlanItems: [{ id: "PLAN-1", evidence: "計画項目を確認しました" }], changedPaths: [] };
assert.equal(validateWorkerReport(worker).valid, true);
for (const key of ["summary", "changedScope", "evidence"]) assert.equal(validateWorkerReport({ ...worker, [key]: "" }).valid, false);
assert.equal(validateWorkerReport({ ...worker, verdict: "BLOCKED" }).valid, true);
assert.equal(validateWorkerReport({ ...worker, verdict: "PASS" }).valid, false);
assert.equal(validateWorkerReport({ ...worker, findings: [] }).valid, false);
assert.equal(validateWorkerReport(Object.create({ evidence: "x" })).valid, false);
assert.equal(validateWorkerReport([]).valid, false);

const blocking = (overrides = {}) => ({ id: "AUTH-1", severity: "high", target: "src/auth.ts", reproduction: "再現手順", userImpact: "認証情報が漏れる", expectedOutcome: "認証情報を漏らさない", route: "worker", discovery: "initial", ...overrides });
const note = (overrides = {}) => ({ id: "STYLE-1", severity: "low", target: "src/auth.ts", note: "命名を改善できる", ...overrides });
const report = (overrides = {}) => ({ verdict: "CHANGES_REQUESTED", summary: "日本語のレビュー要約です。", blockingFindings: [blocking()], nonBlockingNotes: [], plannerQuestions: [], ...overrides });
const failures = [];
const expectValid = (value, label) => { if (!validateReviewerReport(value).valid) failures.push(`${label}を受理できない`); };
const expectInvalid = (value, label) => { if (validateReviewerReport(value).valid) failures.push(`${label}を受理している`); };

expectValid({ verdict: "APPROVED", summary: "日本語で承認します。", blockingFindings: [], nonBlockingNotes: [], plannerQuestions: [] }, "APPROVED");
expectValid({ verdict: "APPROVED_WITH_NOTES", summary: "日本語で承認します。", blockingFindings: [], nonBlockingNotes: [note()], plannerQuestions: [] }, "APPROVED_WITH_NOTES");
expectValid(report(), "CHANGES_REQUESTED");
expectValid({ verdict: "NEEDS_PLANNER", summary: "日本語で判断待ちです。", blockingFindings: [blocking({ route: "planner" })], nonBlockingNotes: [], plannerQuestions: ["利用者判断が必要です"] }, "NEEDS_PLANNER");
expectValid(report({ blockingFindings: [blocking({ discovery: "previously_missed", missedReason: "前回は対象経路を確認しなかった" })] }), "previously_missed理由付き");

for (const value of [undefined, "", "   "]) { const invalid = report(); if (value === undefined) delete invalid.summary; else invalid.summary = value; expectInvalid(invalid, "summary空欄"); }
expectInvalid({ ...report(), summary: "Review passed with no issues." }, "英語のみのsummary");
for (const [key, label] of [["reproduction", "reproduction"], ["userImpact", "userImpact"], ["expectedOutcome", "expectedOutcome"]]) { expectInvalid(report({ blockingFindings: [blocking({ [key]: "English only" })] }), `${label}英語のみ`); for (const value of ["", "   "]) expectInvalid(report({ blockingFindings: [blocking({ [key]: value })] }), `${label}空欄`); }
for (const value of ["English only", "", "   "]) expectInvalid(report({ blockingFindings: [blocking({ discovery: "previously_missed", missedReason: value })] }), "missedReason不正");
for (const value of ["English only", "", "   "]) expectInvalid({ ...report(), plannerQuestions: [value] }, "plannerQuestions不正");

for (const [key, label] of [["target", "target空欄"], ["reproduction", "reproduction欠落"], ["userImpact", "userImpact欠落"], ["expectedOutcome", "expectedOutcome欠落"], ["id", "id欠落"], ["severity", "severity欠落"], ["route", "route欠落"], ["discovery", "discovery欠落"]]) { const item = blocking(); delete item[key]; expectInvalid(report({ blockingFindings: [item] }), label); }
for (const value of [null, {}, "", "   "]) expectInvalid(report({ blockingFindings: [blocking({ target: value })] }), "blocking target不正");
expectInvalid(report({ blockingFindings: [blocking({ id: "bad id" })] }), "不正canonical ID");
expectInvalid(report({ blockingFindings: [blocking(), blocking({ id: "AUTH-1", target: "other.ts" })] }), "重複ID");
expectInvalid(report({ blockingFindings: [blocking({ severity: "medium" })] }), "medium blocking");
expectInvalid(report({ blockingFindings: [blocking({ route: "other" })] }), "不正route");
expectInvalid(report({ blockingFindings: [blocking({ discovery: "other" })] }), "不正discovery");
expectInvalid(report({ blockingFindings: [blocking({ discovery: "previously_missed" })] }), "missedReason欠落");
expectInvalid(report({ blockingFindings: [{ ...blocking(), extra: true }] }), "blocking extra field");

for (const [key, label] of [["id", "note id欠落"], ["severity", "note severity欠落"], ["target", "note target欠落"], ["note", "note本文欠落"]]) { const item = note(); delete item[key]; expectInvalid({ ...report(), blockingFindings: [], verdict: "APPROVED_WITH_NOTES", nonBlockingNotes: [item] }, label); }
for (const value of [null, {}, "", "   "]) expectInvalid({ ...report(), blockingFindings: [], verdict: "APPROVED_WITH_NOTES", nonBlockingNotes: [note({ target: value })] }, "note target不正");
expectInvalid({ ...report(), blockingFindings: [], verdict: "APPROVED_WITH_NOTES", nonBlockingNotes: [{ ...note(), id: "bad id" }] }, "note不正canonical ID");
expectInvalid({ ...report(), blockingFindings: [], verdict: "APPROVED_WITH_NOTES", nonBlockingNotes: [{ ...note(), severity: "high" }] }, "critical/high note");
expectInvalid({ ...report(), blockingFindings: [], verdict: "APPROVED_WITH_NOTES", nonBlockingNotes: [{ ...note(), extra: true }] }, "note extra field");
for (const value of ["English only", "", "   "]) expectInvalid({ ...report(), blockingFindings: [], verdict: "APPROVED_WITH_NOTES", nonBlockingNotes: [note({ note: value })] }, "note不正");
expectInvalid({ ...report(), blockingFindings: [blocking()], nonBlockingNotes: [note({ id: "AUTH-1" })] }, "blockingとnote間の重複ID");
expectInvalid({ ...report(), blockingFindings: [], verdict: "APPROVED_WITH_NOTES", nonBlockingNotes: [note(), note({ id: "STYLE-1" })] }, "note内の重複ID");
expectInvalid({ ...report(), blockingFindings: [note()] }, "low noteのblocking混入");
expectInvalid({ ...report(), verdict: "APPROVED", blockingFindings: [blocking()] }, "APPROVEDのblocking矛盾");
expectInvalid({ ...report(), verdict: "APPROVED_WITH_NOTES", blockingFindings: [], nonBlockingNotes: [] }, "notesなしAPPROVED_WITH_NOTES");
expectInvalid({ ...report(), verdict: "CHANGES_REQUESTED", blockingFindings: [blocking({ route: "planner" })] }, "planner routeのCHANGES_REQUESTED");
expectInvalid({ ...report(), verdict: "NEEDS_PLANNER", blockingFindings: [blocking()], plannerQuestions: [] }, "planner要素なしNEEDS_PLANNER");
expectInvalid({ ...report(), extra: true }, "cross-role extra field");

const handoffReport = report({ summary: "日本語の要約はhandoffに含めない。", blockingFindings: [blocking({ discovery: "previously_missed", missedReason: "前回のレビューで見逃した理由" })], nonBlockingNotes: [note()] });
try {
  assert.deepEqual(workerHandoffFromReviewer(handoffReport), { findings: [{ id: "AUTH-1", severity: "high", target: "src/auth.ts", reproduction: "再現手順", userImpact: "認証情報が漏れる", expectedOutcome: "認証情報を漏らさない", route: "worker", discovery: "previously_missed", missedReason: "前回のレビューで見逃した理由" }] });
} catch { failures.push("CHANGES_REQUESTEDのhandoffがdeepEqualでない"); }
try { workerHandoffFromReviewer({ verdict: "APPROVED_WITH_NOTES", summary: "日本語", blockingFindings: [], nonBlockingNotes: [note()], plannerQuestions: [] }); failures.push("APPROVED_WITH_NOTESからhandoffを生成している"); } catch {}
try { workerHandoffFromReviewer({ verdict: "NEEDS_PLANNER", summary: "日本語", blockingFindings: [blocking({ route: "planner" })], nonBlockingNotes: [], plannerQuestions: ["判断"] }); failures.push("NEEDS_PLANNERからhandoffを生成している"); } catch {}
assert.deepEqual(failures, [], `Reviewer契約GREEN: ${failures.join("\n")}`);
console.log("structured role contract tests passed");
