import assert from "node:assert/strict";
const { parsePsOutput, agentPidsFromProcessInfo, countBackgroundShells, detectBackgroundShells } = await import("../extensions/development-pipeline/background-shells.ts");

// ps output parsing keeps the whole command line, including spaces.
const rows = parsePsOutput([
  "  100     1 claude --model x",
  "  200   100 /bin/zsh -c source /home/u/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'sleep 600'",
  "  201   100 node /path/to/mcp-server.mjs",
  "  300   999 /bin/zsh -c source /home/u/.claude/shell-snapshots/snapshot-zsh-2.sh",
  "garbage line",
  "",
].join("\n"));
assert.deepEqual(rows.map(row => [row.pid, row.ppid]), [[100, 1], [200, 100], [201, 100], [300, 999]]);
assert.equal(rows[1].command.startsWith("/bin/zsh -c source"), true);

// The agent PID comes from the exact argv[0] / argv0, wherever Herdr nests it.
const info = { foreground_processes: [{ argv: ["claude", "-c"], argv0: "claude", name: "2.1.310", pid: 100 }, { argv: ["node", "mcp.mjs"], argv0: "node", pid: 201 }] };
assert.deepEqual(agentPidsFromProcessInfo(info, "claude"), [100]);
assert.deepEqual(agentPidsFromProcessInfo(info, "pi"), []);
assert.deepEqual(agentPidsFromProcessInfo({ foreground_processes: [{ argv: ["/usr/local/bin/claude"], pid: 5 }] }, "claude"), [], "only the exact argv[0] counts");
assert.deepEqual(agentPidsFromProcessInfo({ foreground_processes: [{ argv: ["claude"] }] }, "claude"), [], "no pid, no detection");

// Only direct children of the agent whose command sources a shell snapshot count: not MCP servers, not other agents' shells.
assert.equal(countBackgroundShells([100], rows), 1);
assert.equal(countBackgroundShells([], rows), 0);
assert.equal(countBackgroundShells([999], rows), 1, "the shell of another parent is counted only for that parent");
assert.equal(countBackgroundShells([201], rows), 0);
assert.equal(await detectBackgroundShells(info, "claude", async () => rows), 1);
assert.equal(await detectBackgroundShells({}, "claude", async () => { throw new Error("must not list processes without an agent pid"); }), 0);

console.log("background shell detection tests passed");
