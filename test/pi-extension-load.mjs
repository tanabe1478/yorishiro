import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pi = process.env.YORISHIRO_PI_BIN || "pi";
const run = (extension) => spawnSync(pi, [
  "--mode", "rpc", "--no-session", "--no-tools", "--extension", extension,
], {
  cwd: root,
  input: '{"id":"probe","type":"get_state"}\n',
  encoding: "utf8",
  env: { ...process.env, PI_OFFLINE: "1" },
  timeout: 30_000,
});

const current = run(path.join(root, "extensions", "development-pipeline", "index.ts"));
assert.equal(current.status, 0, `Pi/Jiti failed to initialize the current extension:\n${current.stderr}`);
assert.match(current.stdout, /"command":"get_state"/);

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "yorishiro-jiti-broken-"));
try {
  const fixture = path.join(fixtureRoot, "development-pipeline");
  await cp(path.join(root, "extensions", "development-pipeline"), fixture, { recursive: true });
  const index = path.join(fixture, "index.ts");
  const source = await readFile(index, "utf8");
  assert.match(source, /\n    \}\n  \}\);\n\}\n$/);
  await writeFile(index, source.replace(/\n    \}\n  \}\);\n\}\n$/, "\n  });\n}\n"));

  const broken = run(path.join(fixture, "index.ts"));
  assert.notEqual(broken.status, 0, "broken fixture unexpectedly initialized");
  assert.match(`${broken.stdout}\n${broken.stderr}`, /ParseError|Failed to load extension/);
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
console.log("Pi/Jiti extension initialization regression test passed");
