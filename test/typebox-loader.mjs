export async function resolve(specifier, context, nextResolve) {
  if (specifier === "typebox") return { url: "data:text/javascript,export const Type={String:()=>({}),Integer:()=>({}),Array:()=>({}),Optional:(x)=>x,Object:(x)=>x};", shortCircuit: true };
  return nextResolve(specifier, context);
}
