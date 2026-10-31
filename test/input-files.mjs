import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const { extractAbsolutePaths, looksSecret, stageInputFiles, renderInputFilesSection, INPUT_FILE_LIMIT_BYTES, INPUT_TOTAL_LIMIT_BYTES } = await import("../extensions/development-pipeline/input-files.ts");
const { writeWorkflowBrief } = await import("../extensions/development-pipeline/launcher.ts");

// Extraction: absolute and home paths only, not the tail of relative paths or URLs, and no trailing punctuation.
assert.deepEqual(extractAbsolutePaths("仕様は ~/Downloads/spec.md を読む。/tmp/a.txt、/tmp/b.txt."), ["~/Downloads/spec.md", "/tmp/a.txt", "/tmp/b.txt"]);
assert.deepEqual(extractAbsolutePaths("see src/a/b.ts and extensions/x/y.ts and https://example.com/a/b and ./rel and ../up/x"), []);
assert.deepEqual(extractAbsolutePaths("`/etc/hosts` (/tmp/c.md) \"/tmp/d.md\""), ["/etc/hosts", "/tmp/c.md", "/tmp/d.md"]);
assert.deepEqual(extractAbsolutePaths("a / b と c/d"), []);
// A path right after Japanese text ("仕様は/tmp/a.md") is still found; candidates that do not exist are dropped later.
assert.deepEqual(extractAbsolutePaths("仕様は/tmp/a.md"), ["/tmp/a.md"]);
assert.deepEqual(extractAbsolutePaths("/tmp/日本語.md を読む"), ["/tmp/日本語.md"]);

// Secret-looking paths.
for (const secret of ["/home/u/.ssh/id_ed25519", "/home/u/.aws/credentials", "/p/.env", "/p/.env.local", "/p/server.pem", "/p/api-key.txt", "/p/private.key", "/home/u/.config/gcloud/x.json", "/p/secrets.yaml", "/p/token.txt"]) assert.equal(looksSecret(secret), true, secret);
for (const fine of ["/home/u/Downloads/spec.md", "/p/notes/design.md", "/p/environment.md"]) assert.equal(looksSecret(fine), false, fine);

const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "yorishiro-input-files-")));
try {
  const cwd = path.join(base, "repo"), artifact = path.join(base, "artifact"), skill = path.join(base, "skill"), home = path.join(base, "home"), outside = path.join(base, "outside");
  for (const dir of [cwd, artifact, skill, path.join(home, "Downloads"), path.join(home, ".ssh"), outside]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(cwd, "inside.md"), "in repo");
  await writeFile(path.join(skill, "SKILL.md"), "skill");
  await writeFile(path.join(home, "Downloads", "spec.md"), "# spec\n日本語の仕様");
  await writeFile(path.join(home, ".ssh", "config"), "Host x");
  await writeFile(path.join(outside, "server.pem"), "pem");
  await writeFile(path.join(outside, "notes.txt"), "notes");
  await writeFile(path.join(outside, "big.bin"), Buffer.alloc(INPUT_FILE_LIMIT_BYTES + 1, 1));
  await writeFile(path.join(outside, "ok-large.txt"), Buffer.alloc(INPUT_FILE_LIMIT_BYTES, 65));
  await mkdir(path.join(outside, "adir"));
  await symlink(path.join(outside, "notes.txt"), path.join(cwd, "link-to-outside.txt"));
  await symlink(path.join(cwd, "inside.md"), path.join(outside, "link-to-inside.md"));

  const text = [
    `読む: ~/Downloads/spec.md と ${path.join(outside, "notes.txt")}`,
    `repo内 ${path.join(cwd, "inside.md")} と skill ${path.join(skill, "SKILL.md")} と artifact ${path.join(artifact, "x.json")}`,
    `秘密 ~/.ssh/config ${path.join(outside, "server.pem")}`,
    `大きい ${path.join(outside, "big.bin")} ディレクトリ ${path.join(outside, "adir")} 無い ${path.join(outside, "missing.md")} デバイス /dev/null`,
    `symlink ${path.join(cwd, "link-to-outside.txt")} ${path.join(outside, "link-to-inside.md")}`,
    `同じ実体の別表記 ${path.join(outside, "..", "outside", "notes.txt")}`,
  ].join("\n");
  const report = await stageInputFiles({ texts: [text, "二つ目のテキストにも ~/Downloads/spec.md"], cwd, artifactDir: artifact, readableDirs: [skill], home });
  const byOriginal = new Map(report.copied.map(item => [item.original, item]));

  // Copied: external regular files, with the symlink resolved to its target.
  const spec = byOriginal.get("~/Downloads/spec.md");
  assert.ok(spec, "a home file is copied");
  assert.equal(path.dirname(spec.copy), path.join(artifact, "inputs"));
  assert.equal(await readFile(spec.copy, "utf8"), "# spec\n日本語の仕様");
  assert.equal((await stat(spec.copy)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(artifact, "inputs"))).mode & 0o777, 0o700);
  const notes = byOriginal.get(path.join(outside, "notes.txt"));
  assert.ok(notes && await readFile(notes.copy, "utf8") === "notes");
  const viaLink = byOriginal.get(path.join(cwd, "link-to-outside.txt"));
  assert.ok(viaLink, "a symlink inside the checkout that points outside is copied from its resolved target");
  assert.equal(viaLink.copy, notes.copy, "the same real file is copied once");
  assert.ok(byOriginal.get(path.join(outside, "..", "outside", "notes.txt")), "another spelling of the same file maps to the same copy");
  assert.equal(report.copied.filter(item => item.original === "~/Downloads/spec.md").length, 1, "a path named twice is listed once");

  // Not copied: already readable, secret, too large, directory, device, missing.
  for (const readableOriginal of [path.join(cwd, "inside.md"), path.join(skill, "SKILL.md"), path.join(artifact, "x.json"), path.join(outside, "link-to-inside.md")]) {
    assert.equal(byOriginal.has(readableOriginal), false, `${readableOriginal} needs no copy`);
    assert.equal(report.skipped.some(item => item.original === readableOriginal), false);
  }
  const reason = original => report.skipped.find(item => item.original === original)?.reason;
  assert.match(reason("~/.ssh/config"), /秘密情報/);
  assert.match(reason(path.join(outside, "server.pem")), /秘密情報/);
  assert.match(reason(path.join(outside, "big.bin")), /1ファイルの上限/);
  assert.match(reason(path.join(outside, "adir")), /ディレクトリ/);
  assert.ok(reason("/dev/null"), "a device is recorded as not copied");
  assert.equal(reason(path.join(outside, "missing.md")), undefined, "a path that does not exist is not an input file");
  const files = await readdir(path.join(artifact, "inputs"));
  assert.equal(files.length, 2, `only spec and notes are copied: ${files}`);
  assert.equal(JSON.stringify(report).includes("Host x"), false);

  // Exactly the per-file limit is allowed; the total limit stops further copies.
  const exact = await stageInputFiles({ texts: [path.join(outside, "ok-large.txt")], cwd, artifactDir: path.join(base, "artifact-exact"), readableDirs: [], home });
  assert.equal(exact.copied.length, 1);
  assert.equal(exact.copied[0].bytes, INPUT_FILE_LIMIT_BYTES);
  const manyDir = path.join(outside, "many"); await mkdir(manyDir);
  const names = [];
  for (let index = 0; index < 7; index++) { const file = path.join(manyDir, `part-${index}.txt`); await writeFile(file, Buffer.alloc(INPUT_FILE_LIMIT_BYTES, 66 + index)); names.push(file); }
  const total = await stageInputFiles({ texts: [names.join("\n")], cwd, artifactDir: path.join(base, "artifact-total"), readableDirs: [], home });
  assert.equal(total.copied.length, Math.floor(INPUT_TOTAL_LIMIT_BYTES / INPUT_FILE_LIMIT_BYTES));
  assert.equal(total.copied.reduce((sum, item) => sum + item.bytes, 0) <= INPUT_TOTAL_LIMIT_BYTES, true);
  assert.equal(total.skipped.length, names.length - total.copied.length);
  assert.ok(total.skipped.every(item => /合計の上限/.test(item.reason)));

  // Nothing to copy: no inputs directory and an empty brief section.
  const none = await stageInputFiles({ texts: ["パスなし。src/a.ts だけ"], cwd, artifactDir: path.join(base, "artifact-none"), readableDirs: [], home });
  assert.deepEqual(none.copied, []);
  assert.equal(await stat(path.join(base, "artifact-none", "inputs")).then(() => true, () => false), false);
  assert.equal(renderInputFilesSection(none), "");
  assert.equal(renderInputFilesSection(undefined), "");

  // The brief carries the mapping table and the skip reasons, for both stages.
  const skillDir = path.join(base, "wf"); await mkdir(skillDir);
  for (const stage of ["implement", "review"]) {
    const brief = await readFile(await writeWorkflowBrief({ artifactDir: artifact, cwd, workflow: "feature", skillDir, playbookPath: path.join(skillDir, "p.md"), verifySkills: [], stage, inputFiles: report }), "utf8");
    assert.match(brief, /## 外部入力ファイル/);
    assert.ok(brief.includes(`| ~/Downloads/spec.md | ${spec.copy} |`), "the mapping row is present");
    assert.match(brief, /\| ~\/\.ssh\/config \| 秘密情報/);
    assert.match(brief, /\| .*big\.bin \| 1ファイルの上限/);
    assert.ok(brief.indexOf("## 外部入力ファイル") < brief.indexOf("## 必須の進め方"));
  }
  const plain = await readFile(await writeWorkflowBrief({ artifactDir: artifact, cwd, workflow: "feature", skillDir, playbookPath: path.join(skillDir, "p.md"), verifySkills: [], stage: "implement" }), "utf8");
  assert.equal(plain.includes("外部入力ファイル"), false, "no section without inputs");
} finally {
  await rm(base, { recursive: true, force: true });
}
console.log("input file staging tests passed");
