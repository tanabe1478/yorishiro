import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const { detectBackgroundShells, listProcesses, SHELL_SNAPSHOT_MARKER } = await import("../extensions/development-pipeline/background-shells.ts");

// Real processes: a direct child of this process whose command line carries the snapshot marker is detected,
// a plain child is not, and the count drops to zero once the shell exits.
const fakeAgentInfo = { foreground_processes: [{ argv: ["claude"], argv0: "claude", pid: process.pid }] };
assert.equal(await detectBackgroundShells(fakeAgentInfo, "claude"), 0, "no shell yet");
const plain = spawn("sh", ["-c", "sleep 30; true"], { stdio: "ignore" });
const shell = spawn("sh", ["-c", "sleep 30; true", "probe", `/home/u/${SHELL_SNAPSHOT_MARKER}snapshot-test.sh`], { stdio: "ignore" });
try {
  let detected = 0;
  for (let attempt = 0; attempt < 50 && detected === 0; attempt++) { detected = await detectBackgroundShells(fakeAgentInfo, "claude"); if (!detected) await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(detected, 1, "the marked child is detected and the plain child is not");
  assert.ok((await listProcesses()).length > 10, "ps lists the process table");
} finally {
  shell.kill("SIGKILL"); plain.kill("SIGKILL");
}
await new Promise(resolve => shell.once("close", resolve));
let remaining = 1;
for (let attempt = 0; attempt < 50 && remaining !== 0; attempt++) { remaining = await detectBackgroundShells(fakeAgentInfo, "claude"); if (remaining) await new Promise(resolve => setTimeout(resolve, 100)); }
assert.equal(remaining, 0, "no shell after exit");
console.log("background shell detection tests passed");
