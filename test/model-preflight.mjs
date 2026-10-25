import assert from "node:assert/strict";
const { parseAuthCheck, catalogHasExactModel, preflightFixedModels } = await import("../extensions/development-pipeline/model-preflight.ts");

const ready = parseAuthCheck('{"status":"ready","provider":"opencode-go","authType":"api_key","credentials":"SECRET"}');
assert.deepEqual(ready, { status: "ready", provider: "opencode-go", authType: "api_key" }, "parseAuthCheck must not retain credentials");
assert.equal(ready.credentials, undefined);
assert.equal(parseAuthCheck("").status, "unknown");
assert.equal(parseAuthCheck('{"status":"not_ready","provider":"x","reason":"missing"}').status, "not_ready");
assert.equal(parseAuthCheck("noise\n{\"status\":\"ready\",\"provider\":\"x\"}\n").status, "ready");

const catalog = "provider     model                context  max-out  thinking  images\nopencode-go  deepseek-v4.1-flash  1M       384K     yes       yes\n";
assert.equal(catalogHasExactModel(catalog, "opencode-go", "deepseek-v4.1-flash"), true);
assert.equal(catalogHasExactModel(catalog, "opencode-go", "deepseek-v4.1"), false, "fuzzy prefix is not exact availability");
assert.equal(catalogHasExactModel(catalog, "other", "deepseek-v4.1-flash"), false);

const model = "opencode-go/deepseek-v4.1-flash";
const calls = [];
const runner = (auth = { status: "ready", provider: "opencode-go", authType: "api_key" }, authExit = 0, catalogText = catalog, catalogExit = 0) => async (program, args) => {
  calls.push([program, args]);
  if (args.includes("--list-models")) return { code: catalogExit, stdout: catalogText, stderr: "" };
  return { code: authExit, stdout: JSON.stringify(auth), stderr: "SECRET-TOKEN-IN-STDERR" };
};
const ok = await preflightFixedModels([model], { run: runner(), piBin: "fake-pi" });
assert.equal(ok.status, "ready");
assert.deepEqual(ok.models, [{ model, provider: "opencode-go", authType: "api_key" }]);
assert.deepEqual(calls[0], ["fake-pi", ["--offline", "--list-models", model]]);
assert.deepEqual(calls[1], ["fake-pi", ["auth", "check", "--model", model, "--json", "--no-refresh"]]);

await assert.rejects(() => preflightFixedModels([model], { run: runner({ status: "not_ready", provider: "opencode-go", reason: "missing" }), piBin: "fake-pi" }), /not ready/);
const nonzero = preflightFixedModels([model], { run: runner(undefined, 1), piBin: "fake-pi" });
await assert.rejects(() => nonzero, error => {
  assert.match(error.message, /exited nonzero/);
  assert.doesNotMatch(error.message, /SECRET-TOKEN-IN-STDERR/, "raw stderr must not be relayed");
  return true;
});
await assert.rejects(() => preflightFixedModels([model], { run: runner({ status: "ready", provider: "other", authType: "api_key" }), piBin: "fake-pi" }), /resolved to provider other/);
await assert.rejects(() => preflightFixedModels([model], { run: runner({ status: "ready", provider: "opencode-go" }, 0, "provider model\n"), piBin: "fake-pi" }), /not present in the installed model catalog/);
await assert.rejects(() => preflightFixedModels(["no-slash"], { run: runner(), piBin: "fake-pi" }), /invalid fixed model id/);

console.log("fixed-model auth/catalog preflight tests passed");
