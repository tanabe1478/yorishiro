// Import this first, then load pipeline modules with dynamic import().
import { register } from "node:module";

register("./standalone-hooks.mjs", import.meta.url);

/** Minimal Pi ExtensionAPI stand-in that only collects registered tools. */
export function collectTools(...extensions) {
  const tools = new Map();
  const host = { registerTool(tool) { tools.set(tool.name, tool); }, on() {} };
  for (const extension of extensions) extension(host);
  return tools;
}
