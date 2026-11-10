import { access, realpath } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";

function probe(program: string, args: string[], cwd: string): Promise<boolean> {
  return new Promise(resolve => { const child = spawn(program, args, { cwd, shell: false, stdio: "ignore" }); child.once("error", () => resolve(false)); child.once("close", code => resolve(code === 0)); });
}
/**
 * macOS: the per-user temp directory (`getconf DARWIN_USER_TEMP_DIR`, under /var/folders), as a realpath.
 * HotSpot creates its attach socket there and ignores TMPDIR/java.io.tmpdir, and Kotlin's compiler daemon
 * writes its alive file there too. undefined when it cannot be determined (nothing is then allowed).
 */
export function darwinUserTempDir(): string | undefined {
  try {
    const value = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return value ? realpathSync(value) : undefined;
  } catch { return undefined; }
}
/**
 * The directory the verification snapshots are created in. macOS: Yorishiro's own ~/Library/Caches/yorishiro/verification,
 * because the sandbox lets a command write DARWIN_USER_TEMP_DIR, which is where tmpdir() points by default; snapshots kept
 * there could be written by the command of another run. Elsewhere: tmpdir(). Not created here (see ensureVerificationRoot).
 */
export function verificationRoot(): string {
  return process.platform === "darwin" ? path.join(homedir(), "Library", "Caches", "yorishiro", "verification") : tmpdir();
}
/** realpath of the nearest existing ancestor, followed by the missing rest. */
async function realpathAllowMissing(target: string): Promise<string> {
  try { return await realpath(target); } catch {
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(await realpathAllowMissing(parent), path.basename(target));
  }
}
function isInside(base: string, candidate: string) {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
/**
 * macOS only. A target under DARWIN_USER_TEMP_DIR or under the snapshot directory is writable by (or shares a directory
 * with) the verification commands, and a target that contains the snapshot directory would be copied into its own snapshot.
 * All paths are realpaths. Returns the reason, or undefined when the target is fine.
 */
export function darwinTargetRejection(target: string, userTemp: string | undefined, snapshotRoot: string): string | undefined {
  if (userTemp && isInside(userTemp, target)) return `Verifier sandbox does not support repositories under the macOS user temporary directory DARWIN_USER_TEMP_DIR (${userTemp}); use a persistent checkout`;
  if (isInside(snapshotRoot, target)) return `Verifier sandbox does not support repositories under the verification snapshot directory (${snapshotRoot}); use a persistent checkout`;
  if (isInside(target, snapshotRoot)) return `Verifier sandbox cannot copy a target that contains the verification snapshot directory (${snapshotRoot} is inside ${target}); run it from outside the target`;
  return undefined;
}
export async function preflightVerifierSandbox(cwd: string): Promise<void> {
  let target: string;
  try { await access(cwd); target = await realpath(cwd); } catch { throw new Error(`Verifier sandbox target is unavailable: ${cwd}`); }
  // The snapshot is a copy of the target and the checks write their temp files into it. A temp directory inside the
  // target (as in the snapshot of a verification run) would be copied into the next snapshot, again and again.
  const temporary = await realpath(tmpdir()), inside = path.relative(target, temporary);
  if (inside === "" || (!inside.startsWith(`..${path.sep}`) && inside !== ".." && !path.isAbsolute(inside))) throw new Error(`Verifier sandbox cannot copy a target that contains the temporary directory (${temporary} is inside ${target}); run it from outside the target, or set TMPDIR to a directory outside it`);
  const temporaryRoots = [temporary, "/tmp", "/private/tmp"]; if (temporaryRoots.some(root => { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".."); })) throw new Error("Verifier sandbox does not support repositories under /tmp; use a persistent checkout");
  if (process.platform === "darwin") {
    const rejection = darwinTargetRejection(target, darwinUserTempDir(), await realpathAllowMissing(verificationRoot()));
    if (rejection) throw new Error(rejection);
    try { await access("/usr/bin/sandbox-exec"); } catch { throw new Error("Verifier requires /usr/bin/sandbox-exec on macOS"); }
    return;
  }
  if (process.platform === "linux") {
    try { await access("/usr/bin/bwrap"); } catch { throw new Error("Verifier requires /usr/bin/bwrap and usable user namespaces on Linux"); }
    if (!(await probe("/usr/bin/bwrap", ["--ro-bind", "/", "/", "--chdir", target, "--", "/usr/bin/true"], target))) throw new Error("Verifier requires a functioning bubblewrap user namespace");
    return;
  }
  throw new Error(`Verifier sandbox is unsupported on ${process.platform}`);
}

/** One repository: the cwd. Several: each repository (the workspace root itself is not copied, so it is not checked). */
export async function preflightWorkspaceSandbox(cwd: string, repositories?: readonly string[]): Promise<void> {
  if (!repositories) return preflightVerifierSandbox(cwd);
  for (const repository of repositories) await preflightVerifierSandbox(path.join(cwd, ...repository.split("/")));
}
