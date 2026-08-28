import { access, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";

function probe(program: string, args: string[], cwd: string): Promise<boolean> {
  return new Promise(resolve => { const child = spawn(program, args, { cwd, shell: false, stdio: "ignore" }); child.once("error", () => resolve(false)); child.once("close", code => resolve(code === 0)); });
}
export async function preflightVerifierSandbox(cwd: string): Promise<void> {
  let target: string;
  try { await access(cwd); target = await realpath(cwd); } catch { throw new Error(`Verifier sandbox target is unavailable: ${cwd}`); }
  const temporaryRoots = [await realpath(tmpdir()), "/tmp", "/private/tmp"]; if (temporaryRoots.some(root => { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".."); })) throw new Error("Verifier sandbox does not support repositories under /tmp; use a persistent checkout");
  if (process.platform === "darwin") {
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
