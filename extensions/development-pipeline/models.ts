export const STAGES = ["implement", "review"] as const;
export type Stage = (typeof STAGES)[number];

/**
 * Fixed child models. The implementation Worker is deliberately pinned to the
 * explicitly selected `opencode-go/deepseek-v4.1-flash`; the read-only Reviewer
 * uses the canonical `openai/gpt-5.6-sol` provider exposed by this Pi build.
 * `openai-codex/gpt-5.6-sol` is not available here and must not be used.
 */
export const MODELS = {
  implement: "opencode-go/deepseek-v4.1-flash",
  review: "openai/gpt-5.6-sol",
} as const;

export const ROLE_LABELS = {
  implement: "Worker · DeepSeek",
  review: "Reviewer · Sol",
} as const;

export const INFO: Record<Stage, { label: string; tools: string; thinking: "high" | "medium" }> = {
  implement: { label: ROLE_LABELS.implement, tools: "read,grep,find,ls,bash,edit,write,submit_stage_report", thinking: "high" },
  review: { label: ROLE_LABELS.review, tools: "read,grep,find,ls,run_verification_command,submit_stage_report", thinking: "medium" },
};

/**
 * Normalize a Pi model object to `provider/id`. Anything else is treated as an
 * unknown identity so the runtime guard can fail closed.
 */
export function modelIdentity(model: unknown): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  const candidate = model as { provider?: unknown; id?: unknown };
  if (typeof candidate.provider !== "string" || candidate.provider.length === 0) return undefined;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return undefined;
  return `${candidate.provider}/${candidate.id}`;
}

export function roleModels() {
  return { implement: MODELS.implement, review: MODELS.review };
}

export function roleMetadata() {
  return Object.fromEntries(STAGES.map(stage => [stage, { label: INFO[stage].label, model: MODELS[stage], thinking: INFO[stage].thinking }]));
}
