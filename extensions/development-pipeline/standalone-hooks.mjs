// Module resolve hook for running the pipeline outside Pi (Claude Code CLI and
// MCP server). `typebox` is supplied by Pi at runtime and only builds tool
// parameter schemas for `pi.registerTool`, which standalone hosts never send to
// a model. Use the real package when it resolves; otherwise use an inert stub.
const STUB = "data:text/javascript,const make=(...args)=>args[0]??{};export const Type=new Proxy({},{get:()=>make});";

export async function resolve(specifier, context, nextResolve) {
  if (specifier !== "typebox") return nextResolve(specifier, context);
  try {
    return await nextResolve(specifier, context);
  } catch {
    return { url: STUB, shortCircuit: true };
  }
}
