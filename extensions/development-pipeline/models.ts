export const STAGES = ["implement", "review"] as const;
export type Stage = (typeof STAGES)[number];

/**
 * Child runtime. `pi` is the default harness; `claude` runs the same pipeline
 * with Claude Code children and Claude models only. It is read once at module
 * load, so a host must set `YORISHIRO_RUNTIME` before importing the pipeline.
 */
export const RUNTIMES = ["pi", "claude"] as const;
export type Runtime = (typeof RUNTIMES)[number];

export function resolveRuntime(value: string | undefined = process.env.YORISHIRO_RUNTIME): Runtime {
  const runtime = value === undefined || value === "" ? "pi" : value;
  if (!(RUNTIMES as readonly string[]).includes(runtime)) throw new Error(`YORISHIRO_RUNTIME must be one of ${RUNTIMES.join(", ")}: ${runtime}`);
  return runtime as Runtime;
}

export const RUNTIME: Runtime = resolveRuntime();

/** Executable name Herdr must report as the child's argv[0]. */
export const AGENT_BINARY = RUNTIME === "claude" ? "claude" : "pi";

/**
 * Fixed child models for Pi. The implementation Worker is deliberately pinned to the
 * explicitly selected `opencode-go/deepseek-v4.1-flash`; the read-only Reviewer
 * uses the canonical `openai/gpt-5.6-sol` provider exposed by this Pi build.
 * `openai-codex/gpt-5.6-sol` is not available here and must not be used.
 */
export const PI_MODELS = {
  implement: "opencode-go/deepseek-v4.1-flash",
  review: "openai/gpt-5.6-sol",
} as const;

/** Defaults for Claude Code children. Each run pins its models at startup. */
export const CLAUDE_DEFAULT_MODELS = {
  implement: "claude-sonnet-5-5",
  review: "claude-opus-5-5",
} as const;

export function resolveClaudeModel(value: string | undefined, fallback: string, name: string) {
  const model = value === undefined || value === "" ? fallback : value;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/.test(model)) throw new Error(`${name} is not a valid Claude model id: ${model}`);
  return model;
}

export const MODELS: Record<Stage, string> = RUNTIME === "claude"
  ? {
    implement: resolveClaudeModel(process.env.YORISHIRO_CLAUDE_WORKER_MODEL, CLAUDE_DEFAULT_MODELS.implement, "YORISHIRO_CLAUDE_WORKER_MODEL"),
    review: resolveClaudeModel(process.env.YORISHIRO_CLAUDE_REVIEWER_MODEL, CLAUDE_DEFAULT_MODELS.review, "YORISHIRO_CLAUDE_REVIEWER_MODEL"),
  }
  : { ...PI_MODELS };

export const PI_ROLE_LABELS = {
  implement: "Worker · DeepSeek",
  review: "Reviewer · Sol",
} as const;

export const CLAUDE_ROLE_LABELS = {
  implement: "Worker · Claude",
  review: "Reviewer · Claude",
} as const;

export const ROLE_LABELS: Record<Stage, string> = RUNTIME === "claude" ? { ...CLAUDE_ROLE_LABELS } : { ...PI_ROLE_LABELS };

/** `tools` uses each runtime's own tool names; `thinking` maps to Claude Code `--effort`. */
export const INFO: Record<Stage, { label: string; tools: string; thinking: "high" | "medium" }> = RUNTIME === "claude"
  ? {
    implement: { label: ROLE_LABELS.implement, tools: "Read,Grep,Glob,Bash,Edit,Write", thinking: "high" },
    review: { label: ROLE_LABELS.review, tools: "Read,Grep,Glob", thinking: "medium" },
  }
  : {
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
