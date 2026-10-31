import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const { checkWorkspaceTrust, claudeStateFile, workspaceTrustWarning } = await import("../extensions/development-pipeline/workspace-trust.ts");

const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "yorishiro-trust-")));
// os.tmpdir() can itself sit inside a git checkout (the quality gate points TMPDIR into a snapshot of the repository),
// so every check below stops the git-root search at `base`, like GIT_CEILING_DIRECTORIES. Production passes no ceiling.
const realCheckWorkspaceTrust = checkWorkspaceTrust;
const check = (dir, options = {}) => realCheckWorkspaceTrust(dir, { gitCeiling: base, ...options });
try {
  const trusted = path.join(base, "trusted"), nested = path.join(trusted, "packages", "app"), other = path.join(base, "other"), declined = path.join(base, "declined");
  for (const dir of [nested, other, declined]) await mkdir(dir, { recursive: true });
  const stateFile = path.join(base, "claude.json");
  await writeFile(stateFile, JSON.stringify({ projects: { [trusted]: { hasTrustDialogAccepted: true }, [declined]: { hasTrustDialogAccepted: false }, [other + "-x"]: { hasTrustDialogAccepted: true } } }));

  assert.deepEqual(await check(trusted, { stateFile }), { status: "trusted", source: stateFile, checkedDir: trusted });
  assert.equal((await check(nested, { stateFile })).status, "trusted", "a subdirectory of a trusted directory is trusted (observed: no dialog)");
  assert.equal((await check(nested, { stateFile })).checkedDir, trusted);
  assert.equal((await check(other, { stateFile })).status, "untrusted", "a sibling with a similar name is not trusted");
  assert.equal((await check(declined, { stateFile })).status, "untrusted", "an explicit false is not trust");
  assert.equal((await check(path.join(base, "does-not-exist"), { stateFile })).status, "untrusted");

  // Observed with claude 2.1.316 (one throwaway pane per case, launcher flags). Inside a git repository only the git
  // root's entry counts; outside git, trust is inherited from parent directories.
  const plain = path.join(base, "plain"), plainChild = path.join(plain, "new", "dir");
  const repo = path.join(base, "repo"), sub = path.join(repo, "packages", "new");
  const nestedRepo = path.join(repo, "work", "nested-repo"), nestedRepoSub = path.join(nestedRepo, "src");
  const worktree = path.join(repo, "work", "linked-worktree"), declinedRepo = path.join(base, "plain", "declined-repo");
  for (const dir of [plainChild, sub, nestedRepoSub, worktree, path.join(repo, ".git"), path.join(nestedRepo, ".git"), path.join(declinedRepo, ".git")]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(worktree, ".git"), "gitdir: ../../.git/worktrees/linked\n"); // worktrees and submodules use a .git file
  const gitState = path.join(base, "claude-git.json");
  await writeFile(gitState, JSON.stringify({ projects: { [plain]: { hasTrustDialogAccepted: true }, [repo]: { hasTrustDialogAccepted: true }, [declinedRepo]: { hasTrustDialogAccepted: false } } }));
  // (a) a new non-git directory under a trusted non-git directory: no dialog
  assert.deepEqual(await check(plainChild, { stateFile: gitState }), { status: "trusted", source: gitState, checkedDir: plain });
  // (b) an independent git repository under a trusted git repository: dialog, so not trusted
  assert.equal((await check(nestedRepo, { stateFile: gitState })).status, "untrusted", "a nested git repository does not inherit the outer repository's trust");
  assert.equal((await check(nestedRepoSub, { stateFile: gitState })).status, "untrusted", "a subdirectory of a nested repository follows its own git root");
  assert.equal((await check(worktree, { stateFile: gitState })).status, "untrusted", "a .git file also marks a git root");
  assert.equal((await check(declinedRepo, { stateFile: gitState })).status, "untrusted", "a git root with explicit false does not fall back to a trusted parent directory");
  // (c) a new subdirectory of a trusted git repository: no dialog
  assert.deepEqual(await check(sub, { stateFile: gitState }), { status: "trusted", source: gitState, checkedDir: repo });
  assert.deepEqual(await check(repo, { stateFile: gitState }), { status: "trusted", source: gitState, checkedDir: repo });
  // Once the nested repository's own entry is accepted (what Claude Code writes after the dialog), it is trusted.
  const gitState2 = path.join(base, "claude-git2.json");
  await writeFile(gitState2, JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true }, [nestedRepo]: { hasTrustDialogAccepted: true } } }));
  assert.deepEqual(await check(nestedRepoSub, { stateFile: gitState2 }), { status: "trusted", source: gitState2, checkedDir: nestedRepo });

  // The git-root search stops at the ceiling; without a ceiling (production) an outer .git is found.
  const box = path.join(base, "box"), boxRepo = path.join(box, "repo"), boxChild = path.join(boxRepo, "child");
  for (const dir of [boxChild, path.join(boxRepo, ".git")]) await mkdir(dir, { recursive: true });
  const boxState = path.join(base, "claude-box.json");
  await writeFile(boxState, JSON.stringify({ projects: { [box]: { hasTrustDialogAccepted: true } } }));
  // No ceiling: boxRepo is the git root and has no accepted entry, so the trusted parent `box` is not inherited.
  assert.equal((await realCheckWorkspaceTrust(boxChild, { stateFile: boxState })).status, "untrusted", "without a ceiling the outer .git is found");
  // A ceiling above the repository does not hide it.
  assert.equal((await realCheckWorkspaceTrust(boxChild, { stateFile: boxState, gitCeiling: base })).status, "untrusted");
  // A ceiling at the repository directory is not entered, so the search finds no git root and trust is inherited from `box`.
  assert.deepEqual(await realCheckWorkspaceTrust(boxChild, { stateFile: boxState, gitCeiling: boxRepo }), { status: "trusted", source: boxState, checkedDir: box });
  // The ceiling directory itself is still examined when cwd is the ceiling.
  assert.equal((await realCheckWorkspaceTrust(boxRepo, { stateFile: boxState, gitCeiling: boxRepo })).status, "untrusted");

  // Anything unreadable or unexpected is "unknown": never a warning, never trust.
  assert.equal((await check(trusted, { stateFile: path.join(base, "missing.json") })).status, "unknown");
  const broken = path.join(base, "broken.json"); await writeFile(broken, "{not json");
  assert.equal((await check(trusted, { stateFile: broken })).status, "unknown");
  const shapeless = path.join(base, "shapeless.json"); await writeFile(shapeless, JSON.stringify({ projects: [1, 2] }));
  assert.equal((await check(trusted, { stateFile: shapeless })).status, "unknown");
  const noProjects = path.join(base, "noprojects.json"); await writeFile(noProjects, JSON.stringify({ theme: "dark" }));
  assert.equal((await check(trusted, { stateFile: noProjects })).status, "unknown");

  // The check reads only: the state file is untouched.
  const before = await (await import("node:fs/promises")).readFile(stateFile, "utf8");
  await check(other, { stateFile });
  assert.equal(await (await import("node:fs/promises")).readFile(stateFile, "utf8"), before);

  assert.equal(claudeStateFile({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/u"), path.join("/cfg", ".claude.json"));
  assert.equal(claudeStateFile({}, "/home/u"), path.join("/home/u", ".claude.json"));
  const warning = workspaceTrustWarning("/work/repo");
  assert.match(warning, /Workerペインにワークスペース信頼のダイアログが出て/);
  assert.match(warning, /応答してください/);
  assert.match(warning, /自動では付与しません/);
} finally {
  await rm(base, { recursive: true, force: true });
}
console.log("workspace trust check tests passed");
