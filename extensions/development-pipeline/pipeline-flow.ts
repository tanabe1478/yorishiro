export type StageResult = { valid: boolean; positive: boolean; verdict?: string; text: string };
export type FlowStep = "implement" | "verify" | "review" | "terminal";
export function finalizeStage(result: StageResult, snapshotSucceeded: boolean): StageResult {
  return snapshotSucceeded ? result : { ...result, valid: false, positive: false, text: "" };
}
export function flowAfterVerification(result: StageResult, cycles: number, budget: number): FlowStep[] {
  if (!result.valid) return ["terminal"];
  if (result.positive) return ["review"];
  return cycles < budget ? ["implement", "verify"] : ["terminal"];
}
export function flowAfterReview(result: StageResult, cycles: number, budget: number): FlowStep[] {
  if (!result.valid || result.positive) return result.valid ? [] : ["terminal"];
  return cycles < budget ? ["implement", "verify", "review"] : ["terminal"];
}
