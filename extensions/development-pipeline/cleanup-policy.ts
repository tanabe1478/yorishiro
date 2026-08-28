export type CleanupMode = "ask" | "on-success" | "never";
export function shouldCleanup(outcome: string, mode: CleanupMode, hasUI: boolean, confirmed: boolean): boolean {
  if (outcome !== "SUCCESS" || mode === "never") return false;
  return mode === "on-success" || (mode === "ask" && hasUI && confirmed);
}
