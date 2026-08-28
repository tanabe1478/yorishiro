import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
const run = promisify(execFile);
const workspace = process.env.HERDR_WORKSPACE_ID;
if (process.env.YORISHIRO_RUN_REAL_HERDR_PROBE !== "1") { console.log("skipped real Herdr probe: set YORISHIRO_RUN_REAL_HERDR_PROBE=1"); process.exit(0); }
if (!workspace) { console.log("skipped real Herdr probe: HERDR_WORKSPACE_ID is unavailable"); process.exit(0); }
let tab;
const temp = await mkdtemp(path.join(os.tmpdir(), "yorishiro-herdr-probe-"));
try {
  const version = (await run("herdr", ["--version"])).stdout.trim();
  assert.match(version, /^herdr 0\.7\.3$/);
  const before = JSON.parse((await run("herdr", ["tab", "list", "--workspace", workspace])).stdout).result;
  const focusedBefore = before.tabs.find(t => t.focused)?.tab_id;
  const created = JSON.parse((await run("herdr", ["tab", "create", "--workspace", workspace, "--label", "yorishiro-layout-probe", "--cwd", "/tmp", "--no-focus"])).stdout);
  tab = created.result.tab.tab_id;
  const parent = created.result.root_pane.pane_id;
  const split = async (target, direction, ratio) => JSON.parse((await run("herdr", ["pane", "split", target, "--direction", direction, "--ratio", String(ratio), "--cwd", "/tmp", "--no-focus"])).stdout).result.pane.pane_id;
  const layout = async () => JSON.parse((await run("herdr", ["pane", "layout", "--pane", parent])).stdout).result.layout;
  const implement = await split(parent, "right", 0.55);
  const verify = await split(implement, "down", 1 / 3);
  const review = await split(verify, "down", 0.5);
  const launcher = path.join(temp, "launcher.sh");
  await writeFile(launcher, "#!/bin/sh\nexec sleep 600\n", { mode: 0o700 });
  const launched = await run("herdr", ["pane", "run", implement, `'${launcher.replaceAll("'", "'\\''")}'`]);
  assert.equal(launched.stdout, "", "Herdr 0.7.3 pane run success is empty stdout");
  const actual = await layout();
  assert.deepEqual(actual.panes.map(p => p.pane_id), [parent, implement, verify, review]);
  assert.deepEqual(actual.splits.map(s => s.direction), ["right", "down", "down"]);
  assert.deepEqual(actual.splits.map(s => s.ratio), [0.55, 0.33333334, 0.5]);
  assert.equal(actual.zoomed, false);
  const rects = Object.fromEntries(actual.panes.map(p => [p.pane_id, p.rect]));
  assert.ok(rects[parent].width > rects[implement].width && rects[parent].x < rects[implement].x);
  assert.equal(rects[implement].x, rects[verify].x);
  assert.ok(rects[implement].y < rects[verify].y && rects[verify].y < rects[review].y);
  assert.ok(Math.max(rects[implement].height, rects[verify].height, rects[review].height) - Math.min(rects[implement].height, rects[verify].height, rects[review].height) <= 1);
  const after = JSON.parse((await run("herdr", ["tab", "list", "--workspace", workspace])).stdout).result;
  assert.equal(after.tabs.find(t => t.focused)?.tab_id, focusedBefore);
  console.log(`safe real Herdr ${version} disposable probe passed; active tab/focus preserved; pane-run launcher accepted empty stdout with exit 0`);
} finally {
  if (tab) await run("herdr", ["tab", "close", tab]).catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
