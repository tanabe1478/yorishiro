export type RepairAction = "repair" | "terminal" | "continue";

/** Valid negative findings are repairable; malformed reports are always terminal. */
export function repairAction(valid: boolean, positive: boolean, usedCycles: number, budget: number): RepairAction {
  if (!valid) return "terminal";
  if (positive) return "continue";
  return usedCycles < budget ? "repair" : "terminal";
}
