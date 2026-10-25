import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Install a deterministic `pi` stand-in for pipeline tests. It answers the two
 * preflight probes (`--list-models` and `auth check`) without network or real
 * credentials. Test cases can override readiness through environment variables.
 */
export async function installFakePi(directory, options = {}) {
  const models = options.models ?? ["opencode-go/deepseek-v4.1-flash", "openai/gpt-5.6-sol"];
  const bin = path.join(directory, "pi");
  await writeFile(bin, `#!/usr/bin/env node
const a = process.argv.slice(2);
const models = JSON.parse(process.env.FAKE_PI_MODELS || "[]");
if (a.includes("--list-models")) {
  const wanted = a[a.indexOf("--list-models") + 1];
  process.stdout.write("provider     model                context  max-out  thinking  images\\n");
  for (const model of models) {
    if (wanted && model !== wanted) continue;
    const slash = model.indexOf("/");
    process.stdout.write(model.slice(0, slash) + "  " + model.slice(slash + 1) + "  1M       1K       yes       yes\\n");
  }
  process.exit(Number(process.env.FAKE_PI_LIST_EXIT || 0));
}
if (a[0] === "auth") {
  const model = a[a.indexOf("--model") + 1] || "";
  const provider = process.env.FAKE_PI_PROVIDER || model.slice(0, model.indexOf("/"));
  const status = process.env.FAKE_PI_AUTH_STATUS || "ready";
  const body = { status, provider, ...(status === "ready" ? { authType: "test" } : { reason: "not_configured" }) };
  process.stdout.write(JSON.stringify(body) + "\\n");
  process.exit(Number(process.env.FAKE_PI_AUTH_EXIT || 0));
}
process.exit(0);
`);
  await chmod(bin, 0o755);
  process.env.FAKE_PI_MODELS = JSON.stringify(models);
  process.env.YORISHIRO_PI_BIN = bin;
  return bin;
}
