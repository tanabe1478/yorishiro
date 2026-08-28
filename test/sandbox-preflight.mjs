import assert from "node:assert/strict";
import { preflightVerifierSandbox } from "../extensions/development-pipeline/sandbox.ts";
await assert.rejects(() => preflightVerifierSandbox("/tmp"), /does not support repositories under \/tmp/);
console.log("sandbox target preflight test passed");
