import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isActiveAgentStatus } from "./pane-monitor.ts";

/**
 * Follow-up prompts (repair and re-review in a reused pane) for the Claude
 * runtime. A long multi-line `send-text` is folded by Claude Code into a
 * `[Pasted text #N +M lines]` placeholder and the Enter that follows can be
 * lost, leaving the text unsent while the child sits idle. So the full text
 * goes to a file in the artifact and the pane only receives a one-line pointer,
 * and the orchestrator checks that the child actually started working.
 */
export const PROMPT_NOT_SUBMITTED = "PROMPT_NOT_SUBMITTED";
/** How long to wait for the pane to leave idle after one Enter. */
export const SUBMIT_CONFIRM_WINDOW_MS = 5000;
/** Enter presses added after the first one when the pane stays idle. */
export const MAX_ENTER_RETRIES = 2;
export const SUBMIT_POLL_INTERVAL_MS = 250;
/** Pause between the text and the first Enter, so the TUI has taken the input. */
export const SETTLE_BEFORE_ENTER_MS = 300;

export function followUpPromptFile(artifactDir: string, stage: string, attempt: number) {
  return path.join(artifactDir, `${stage}-prompt-${attempt}.md`);
}

/** One line for the input box. Never contains a newline, so it is never folded. */
export function followUpInstruction(file: string) {
  return `次のファイルを最後まで読み、その指示に従ってください: ${file}`;
}

export async function writeFollowUpPrompt(artifactDir: string, stage: string, attempt: number, text: string) {
  const file = followUpPromptFile(artifactDir, stage, attempt);
  await fs.writeFile(file, text, { encoding: "utf8", mode: 0o600 });
  return { file, instruction: followUpInstruction(file) };
}

type CommandResult = { code: number; stdout: string; stderr: string };

export type PromptDeliveryDeps = {
  sendText: (text: string) => Promise<CommandResult>;
  sendEnter: () => Promise<CommandResult>;
  /** Herdr `agent_status` of the pane, or undefined when it cannot be read. */
  readStatus: () => Promise<string | undefined>;
  /** The stage's durable report already exists: the child got the prompt and finished. */
  reportExists: () => boolean;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  confirmWindowMs?: number;
  maxEnterRetries?: number;
  pollIntervalMs?: number;
  settleBeforeEnterMs?: number;
};

export type PromptDeliveryResult =
  | { submitted: true; via: "status" | "report"; status?: string; enterPresses: number; elapsedMs: number }
  | { submitted: false; code: typeof PROMPT_NOT_SUBMITTED; enterPresses: number; lastStatus?: string; elapsedMs: number; aborted?: boolean };

/** A child that left idle took the prompt. `blocked` is a permission or trust dialog, which only appears after a submit. */
export function indicatesSubmission(status: string | undefined) {
  return isActiveAgentStatus(status) || status?.toLowerCase() === "blocked";
}

function failure(label: string, result: CommandResult) {
  return new Error(`${label}: ${result.stderr || result.stdout || `exit ${result.code}`}`);
}

/**
 * Send the instruction, press Enter, and wait for the pane to start working. If
 * it stays idle for a window, press Enter again, at most `maxEnterRetries`
 * more times. Returns `submitted: false` instead of waiting for a report that
 * will never come.
 */
export async function deliverPrompt(instruction: string, deps: PromptDeliveryDeps): Promise<PromptDeliveryResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  const windowMs = deps.confirmWindowMs ?? SUBMIT_CONFIRM_WINDOW_MS;
  const retries = deps.maxEnterRetries ?? MAX_ENTER_RETRIES;
  const interval = deps.pollIntervalMs ?? SUBMIT_POLL_INTERVAL_MS;
  const startedAt = now();
  const sent = await deps.sendText(instruction);
  if (sent.code) throw failure("Could not send prompt", sent);
  await sleep(deps.settleBeforeEnterMs ?? SETTLE_BEFORE_ENTER_MS);
  let enterPresses = 0, lastStatus: string | undefined;
  for (let round = 0; round <= retries; round++) {
    const enter = await deps.sendEnter();
    if (enter.code) throw failure("Could not submit prompt", enter);
    enterPresses++;
    const roundEnd = now() + windowMs;
    while (true) {
      if (deps.signal?.aborted) return { submitted: false, code: PROMPT_NOT_SUBMITTED, enterPresses, lastStatus, elapsedMs: now() - startedAt, aborted: true };
      if (deps.reportExists()) return { submitted: true, via: "report", status: lastStatus, enterPresses, elapsedMs: now() - startedAt };
      lastStatus = (await deps.readStatus()) ?? lastStatus;
      if (indicatesSubmission(lastStatus)) return { submitted: true, via: "status", status: lastStatus, enterPresses, elapsedMs: now() - startedAt };
      if (now() >= roundEnd) break;
      await sleep(interval);
    }
  }
  return { submitted: false, code: PROMPT_NOT_SUBMITTED, enterPresses, lastStatus, elapsedMs: now() - startedAt };
}

/** The reason kept in run.json and the CLI message. Names the pane so a human can look at it. */
export function describePromptFailure(paneId: string, result: Extract<PromptDeliveryResult, { submitted: false }>, file: string) {
  const status = result.lastStatus ?? "unknown";
  return `${PROMPT_NOT_SUBMITTED}: ペイン ${paneId} に指示を送りましたが、Enter を${result.enterPresses}回押しても子が作業を始めませんでした（最後のHerdr status: ${status}、${Math.round(result.elapsedMs / 1000)}秒）。入力欄に未送信の文が残っている可能性があります。指示本文: ${file}。ペインは保持しています。`;
}

export class PromptNotSubmittedError extends Error {
  code: typeof PROMPT_NOT_SUBMITTED = PROMPT_NOT_SUBMITTED;
  detail: { paneId: string; promptFile: string; enterPresses: number; lastStatus?: string };
  constructor(message: string, detail: { paneId: string; promptFile: string; enterPresses: number; lastStatus?: string }) {
    super(message);
    this.name = "PromptNotSubmittedError";
    this.detail = detail;
  }
}
