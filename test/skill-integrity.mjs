import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFile(path.join(root, file), "utf8");
const exists = async file => { try { await lstat(path.join(root, file)); return true; } catch { return false; } };
const frontmatter = text => text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
const headings = text => [...text.matchAll(/^## (.+)$/gm)].map(match => match[1].trim());

const workflow = await read("skills/development-workflow/SKILL.md");
const workflowFront = frontmatter(workflow);
assert.match(workflowFront, /^name: development-workflow$/m);
assert.match(workflowFront, /^description: .{20,}$/m);
assert.match(workflowFront, /^license: MIT$/m);
assert.match(workflow, /playbooks\/feature\.md/);
assert.match(workflow, /playbooks\/bug-fix\.md/);
assert.match(workflow, /playbooks\/refactoring\.md/);
assert.match(workflow, /実ユーザー面/);
assert.match(workflow, /compilationが通った/);
assert.match(workflow, /同一モデル/);
assert.match(workflow, /NEEDS_PLANNER/);
assert.match(workflow, /Worker:.*承認済みpathを編集してよい/);
assert.match(workflow, /Reviewer:.*sourceと対象checkoutを編集しない/);
assert.doesNotMatch(workflow, /sandbox外への書き込み/);
assert.match(workflow, /\.\.\/\.\.\/docs\/licenses\/pstack-MIT\.txt/);
assert.doesNotMatch(workflow, /\.cursor\//);

for (const playbook of ["feature", "bug-fix", "refactoring"]) {
  const text = await read(`skills/development-workflow/playbooks/${playbook}.md`);
  assert.match(text, /^# /, `${playbook} needs an H1`);
  assert.match(text, /実ユーザー面/, `${playbook} must verify on the user surface`);
  assert.match(text, /NEEDS_PLANNER/, `${playbook} must keep the planner stop`);
  assert.match(text, /commit、push、PR作成は明示指示があるまで行わない/, `${playbook} must not imply automatic shipping`);
}
const bugFix = await read("skills/development-workflow/playbooks/bug-fix.md");
assert.match(bugFix, /再現/);
assert.match(bugFix, /mechanism/);
assert.match(bugFix, /失敗/);
assert.match(bugFix, /成功/);
const refactoring = await read("skills/development-workflow/playbooks/refactoring.md");
assert.match(refactoring, /振る舞い/);
assert.match(refactoring, /変更前後/);

for (const [skill, phase] of [["create-verification-skill", "生成"], ["maintain-verification-skill", "監査"]]) {
  const text = await read(`skills/${skill}/SKILL.md`);
  const front = frontmatter(text);
  assert.match(front, new RegExp(`^name: ${skill}$`, "m"));
  assert.match(front, /^description: .{20,}$/m);
  assert.match(front, /^license: MIT$/m);
  assert.match(text, /opencode-go\/deepseek-v4\.1-flash/);
  assert.match(text, /Workerへ委譲/);
  assert.match(text, /read-only/);
  assert.match(text, new RegExp(phase));
  assert.match(text, /\.pi\/skills\/verify-/);
  assert.match(text, /Sub-features/);
  assert.match(text, /How to get to it \(user POV\)/);
  assert.match(text, /Gotchas/);
  assert.match(text, /Launch/);
  assert.match(text, /Doctor/);
  assert.match(text, /Drive/);
  assert.match(text, /Evidence/);
  assert.match(text, /Cleanup/);
  assert.match(text, /Helpers/);
  assert.match(text, /clean|changed|blocked/);
  assert.match(text, /\.\.\/\.\.\/docs\/licenses\/pstack-MIT\.txt/);
  assert.equal(await exists(path.join("skills", skill, "..", "..", "docs", "licenses", "pstack-MIT.txt")), true, "license link must resolve from the Skill directory");
  assert.doesNotMatch(text, /\.cursor\//);
}
const create = await read("skills/create-verification-skill/SKILL.md");
assert.match(create, /draft/);
assert.match(create, /blocked/);
assert.match(create, /cleanup後にEvidence/);
const maintain = await read("skills/maintain-verification-skill/SKILL.md");
assert.match(maintain, /product codeを変更しません/);
assert.match(maintain, /doc drift/);
assert.match(maintain, /harness gap/);
assert.match(maintain, /product regression/);
assert.match(maintain, /PRを作らず/);

const featureDir = path.join(root, ".pi", "skills", "verify-yorishiro", "features");
const featureFiles = (await readdir(featureDir)).filter(file => file.endsWith(".md") && file !== "README.md").sort();
assert.ok(featureFiles.length >= 3 && featureFiles.length <= 5, "seed 3-5 feature journeys");
const index = await read(path.join(".pi", "skills", "verify-yorishiro", "features", "README.md"));
for (const file of featureFiles) {
  assert.match(index, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `feature index must link ${file}`);
  const text = await read(path.join(".pi", "skills", "verify-yorishiro", "features", file));
  assert.match(text, /^# /);
  assert.deepEqual(headings(text), ["Sub-features", "How to get to it (user POV)", "Driving it with verify-yorishiro", "Gotchas"], `${file} must use the four H2s in order`);
  assert.match(text, /Preconditions:/);
  assert.match(text, /node \.pi\/skills\/verify-yorishiro\/scripts\/verify-yorishiro\.mjs/);
  assert.doesNotMatch(text, /<placeholder>|TODO|TBD/);
}
const verifySkill = await read(".pi/skills/verify-yorishiro/SKILL.md");
assert.match(frontmatter(verifySkill), /^name: verify-yorishiro$/m);
for (const heading of ["Launch", "Doctor", "Drive", "Evidence", "Cleanup", "Helpers"]) assert.match(verifySkill, new RegExp(`^## ${heading}$`, "m"));
assert.match(verifySkill, /Herdr\+LLM pane起動を検証しません/);
const helper = await lstat(path.join(root, ".pi", "skills", "verify-yorishiro", "scripts", "verify-yorishiro.mjs"));
assert.equal(helper.mode & 0o111, 0o111, "generated verify helper must be executable");
assert.match(await read(".pi/skills/verify-yorishiro/scripts/verify-yorishiro.mjs"), /^#!\/usr\/bin\/env node/);

const pkg = JSON.parse(await read("package.json"));
assert.deepEqual(pkg.pi.skills, ["./skills"]);
assert.equal(pkg.pi.skills.includes(".pi"), false, "project-local verify-yorishiro is not exported");
assert.equal(await exists("docs/licenses/pstack-MIT.txt"), true);
const license = await read("docs/licenses/pstack-MIT.txt");
assert.match(license, /MIT License/);
assert.match(license, /Copyright \(c\) 2026 Lauren Tan/);
const adoption = await read("docs/pstack-adoption.md");
assert.match(adoption, /99b609a72323b70204eab407c622f436e858e112/);
assert.match(adoption, /create-formal-verification-skill/);
assert.match(adoption, /statechart/);
assert.match(adoption, /deferred。NOT implemented/);
assert.match(adoption, /automations\/benny/);
assert.match(adoption, /openai-codex\/gpt-5\.6-sol/);
assert.match(await read("README.md"), /docs\/pstack-adoption\.md/);

console.log("Skill discovery/content integrity tests passed");
