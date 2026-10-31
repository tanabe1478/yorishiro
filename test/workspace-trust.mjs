import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const { checkWorkspaceTrust, claudeStateFile, workspaceTrustWarning } = await import("../extensions/development-pipeline/workspace-trust.ts");

const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "yorishiro-trust-")));
try {
  const trusted = path.join(base, "trusted"), nested = path.join(trusted, "packages", "app"), other = path.join(base, "other"), declined = path.join(base, "declined");
  for (const dir of [nested, other, declined]) await mkdir(dir, { recursive: true });
  const stateFile = path.join(base, "claude.json");
  await writeFile(stateFile, JSON.stringify({ projects: { [trusted]: { hasTrustDialogAccepted: true }, [declined]: { hasTrustDialogAccepted: false }, [other + "-x"]: { hasTrustDialogAccepted: true } } }));

  assert.deepEqual(await checkWorkspaceTrust(trusted, { stateFile }), { status: "trusted", source: stateFile, checkedDir: trusted });
  assert.equal((await checkWorkspaceTrust(nested, { stateFile })).status, "trusted", "a subdirectory of a trusted directory is trusted (observed: no dialog)");
  assert.equal((await checkWorkspaceTrust(nested, { stateFile })).checkedDir, trusted);
  assert.equal((await checkWorkspaceTrust(other, { stateFile })).status, "untrusted", "a sibling with a similar name is not trusted");
  assert.equal((await checkWorkspaceTrust(declined, { stateFile })).status, "untrusted", "an explicit false is not trust");
  assert.equal((await checkWorkspaceTrust(path.join(base, "does-not-exist"), { stateFile })).status, "untrusted");

  // Anything unreadable or unexpected is "unknown": never a warning, never trust.
  assert.equal((await checkWorkspaceTrust(trusted, { stateFile: path.join(base, "missing.json") })).status, "unknown");
  const broken = path.join(base, "broken.json"); await writeFile(broken, "{not json");
  assert.equal((await checkWorkspaceTrust(trusted, { stateFile: broken })).status, "unknown");
  const shapeless = path.join(base, "shapeless.json"); await writeFile(shapeless, JSON.stringify({ projects: [1, 2] }));
  assert.equal((await checkWorkspaceTrust(trusted, { stateFile: shapeless })).status, "unknown");
  const noProjects = path.join(base, "noprojects.json"); await writeFile(noProjects, JSON.stringify({ theme: "dark" }));
  assert.equal((await checkWorkspaceTrust(trusted, { stateFile: noProjects })).status, "unknown");

  // The check reads only: the state file is untouched.
  const before = await (await import("node:fs/promises")).readFile(stateFile, "utf8");
  await checkWorkspaceTrust(other, { stateFile });
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
