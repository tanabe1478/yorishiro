// 実 sandbox（runSandboxedVerification）で JVM 向けの既定を確かめる。sandbox を入れ子にするので test:gate には入れない（test/gate-exclusions.json）。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
const { runSandboxedVerification, darwinUserTempDir } = await import("../extensions/development-pipeline/verifier-tools.ts");

// 元の Gradle ホームは対象チェックアウトの中（git 管理外の artifacts/）に置く。snapshot には複製されるが、元の場所には書けないはず。
const gradleHome = path.join(process.cwd(), "artifacts", `verifier-jvm-sandbox-${process.pid}`);
const properties = "org.gradle.java.installations.paths=/example/jdk\n";
await rm(gradleHome, { recursive: true, force: true });
await mkdir(path.join(gradleHome, "caches"), { recursive: true });
await writeFile(path.join(gradleHome, "gradle.properties"), properties);
await writeFile(path.join(gradleHome, "caches", "marker"), "ro");
const saved = { GRADLE_USER_HOME: process.env.GRADLE_USER_HOME, JAVA_TOOL_OPTIONS: process.env.JAVA_TOOL_OPTIONS, GRADLE_RO_DEP_CACHE: process.env.GRADLE_RO_DEP_CACHE };
process.env.GRADLE_USER_HOME = gradleHome;
process.env.JAVA_TOOL_OPTIONS = "-Dcaller=1";
delete process.env.GRADLE_RO_DEP_CACHE;

const userTemp = process.platform === "darwin" ? darwinUserTempDir() : undefined;
const tempMarker = userTemp ? path.join(userTemp, `yorishiro-jvm-sandbox-${process.pid}.tmp`) : undefined;
const sourceMarker = path.join(process.cwd(), ".yorishiro-jvm-sandbox-source-write.tmp");
await rm(sourceMarker, { force: true });
const probe = `
const fs = require("node:fs");
const attempt = (file, content = "x") => { try { fs.writeFileSync(file, content); return true; } catch { return false; } };
const properties = process.env.GRADLE_USER_HOME + "/gradle.properties";
process.stdout.write(JSON.stringify({
  javaToolOptions: process.env.JAVA_TOOL_OPTIONS,
  tmpdir: process.env.TMPDIR,
  gradleUserHome: process.env.GRADLE_USER_HOME,
  roCache: process.env.GRADLE_RO_DEP_CACHE,
  propertiesMode: (fs.statSync(properties).mode & 0o777).toString(8),
  propertiesCopied: fs.readFileSync(properties, "utf8") === ${JSON.stringify(properties)},
  roCacheReadable: fs.readFileSync(process.env.GRADLE_RO_DEP_CACHE + "/marker", "utf8") === "ro",
  writeGradleHome: attempt(process.env.GRADLE_USER_HOME + "/written"),
  writeRoCache: attempt(process.env.GRADLE_RO_DEP_CACHE + "/written"),
  writeSource: attempt(${JSON.stringify(sourceMarker)}),
  writeUserTemp: ${JSON.stringify(tempMarker ?? null)} ? attempt(${JSON.stringify(tempMarker ?? "")}) : null,
}));`;
try {
  const result = await runSandboxedVerification(process.execPath, ["-e", probe], process.cwd(), 30_000);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const seen = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
  assert.equal(seen.javaToolOptions, `-Dcaller=1 -Djava.io.tmpdir=${seen.tmpdir}`, "the caller's JAVA_TOOL_OPTIONS is kept and java.io.tmpdir points into the snapshot");
  assert.ok(seen.tmpdir.endsWith(".yorishiro-tmp"));
  assert.ok(seen.gradleUserHome.endsWith(path.join(".yorishiro-cache", "gradle")));
  assert.equal(seen.roCache, path.join(gradleHome, "caches"), "the caller's caches are the read-only dependency cache");
  assert.equal(seen.propertiesCopied, true, "gradle.properties is copied into the snapshot's Gradle home");
  assert.equal(seen.propertiesMode, "600");
  assert.equal(seen.roCacheReadable, true);
  assert.equal(seen.writeGradleHome, true, "the snapshot's Gradle home is writable");
  assert.equal(seen.writeRoCache, false, "the caller's Gradle caches stay read-only");
  assert.equal(seen.writeSource, false, "the source checkout stays read-only");
  assert.equal(existsSync(sourceMarker), false);
  assert.equal(existsSync(path.join(gradleHome, "caches", "written")), false);
  assert.equal(await readFile(path.join(gradleHome, "gradle.properties"), "utf8"), properties, "the original gradle.properties is untouched");
  if (process.platform === "darwin") {
    assert.ok(userTemp, "getconf DARWIN_USER_TEMP_DIR is available on macOS");
    assert.equal(seen.writeUserTemp, true, "DARWIN_USER_TEMP_DIR is writable (HotSpot attach socket, Kotlin compiler alive file)");
    assert.equal(existsSync(tempMarker), true);
  } else console.log("skipped DARWIN_USER_TEMP_DIR check: not macOS");
} finally {
  if (tempMarker) await rm(tempMarker, { force: true });
  await rm(gradleHome, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
}
console.log("verifier JVM sandbox test passed");
