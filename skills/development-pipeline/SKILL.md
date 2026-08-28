---
name: development-pipeline
description: Run the approved development pipeline in stable Herdr worker panes with auditable reports and cleanup safeguards.
---

# Development pipeline

Use `development_pipeline` only after requirements and an implementation plan are approved in the parent Sol conversation. Pass both the task and approved plan; the tool does not spawn a duplicate planner. Do not duplicate implementation in the parent agent.

## Herdr requirement

The parent Pi must be running inside Herdr. The extension requires `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`, and `HERDR_SOCKET_PATH`; it fails clearly when Herdr is absent. It constructs the **current tab** layout with explicit `pane split` calls, leaves the parent pane intact, launches each interactive Pi in its allocated shell pane, uses `--no-focus`, and never closes or zooms panes. The user can focus, resize, zoom, or manually close completed panes in Herdr. The official Pi Herdr integration is optional and is not installed or changed by Yorishiro.

## Visible stages

Each worker stage is a normal interactive Pi TUI in a visible pane (not `--mode json`, `-p`, or a hidden subprocess): Implement/Luna, Verify/Terra, and Review/Sol. The approved parent plan is saved as an artifact before workers start. Repair attempts reuse the existing `Implement · Luna`, `Verify · Terra`, and `Review · Sol` panes and sessions; pane labels remain stable. Child Pis load no Yorishiro extensions or skills, so the pipeline cannot recursively invoke itself. Models are exact IDs:

- Plan: supplied by the parent Sol conversation; no Plan child is started
- Implement/repair: `openai-codex/gpt-5.6-luna`, coding tools
- Verify: `openai-codex/gpt-5.6-terra`, `read,grep,find,ls,run_verification_command`, no source writes; the command tool runs only inside a preflight-checked kernel-enforced read-only sandbox (macOS sandbox-exec or Linux bubblewrap/user namespaces; `/tmp` targets are rejected)
- Review: `openai-codex/gpt-5.6-sol`, read-only tools

Agents receive self-contained prompts. Verify uses only the explicitly loaded, sandboxed `run_verification_command` for commands and cannot write the repository; Verify/Review (and the implementation handoff) submit reports through the explicitly loaded `submit_stage_report`, which writes only the orchestrator-selected pending path. The orchestrator materializes reports with stage/attempt metadata. Verify must end with `VERDICT: PASS|FAIL`, and Review with `VERDICT: APPROVED|CHANGES_REQUESTED`. A stage cannot pass without its durable report, strict verdict (where required), a settled Herdr state, and a still-running interactive Pi. Missing reports, exits, timeouts, and aborts are failures and can never become `SUCCESS`.

Pane monitoring has an explicit `startup` state with a bounded 15-second grace period. Normal monitoring begins only after a valid process-info snapshot reports exact `argv0: "pi"`; only a later valid snapshot without that Pi can mean `exited`. Process-info command or parse failures are retried and never count as absence; repeated failures are recorded distinctly. Startup timeout, the normal 30-minute timeout, and abort all send supported `ctrl+c` followed by `escape`, confirm idle, and preserve the pane. Abort before pane creation records an aborted stage with no child started, so no orphan is possible.

The tool records pane IDs and explicit stage states in `artifacts/<repository>/<run-id>/run.json`. It also saves baseline and stage-end status/diff snapshots in `diffs/`; pre-existing dirty changes remain difficult to attribute perfectly. A valid verification FAIL or review CHANGES_REQUESTED can trigger at most one repair cycle; malformed/missing reports, process failures, timeouts, and aborts are terminal. Repairs are sent as follow-up prompts to the existing panes. Verification output is capped at 64 KiB including model-visible status and truncation notices, cancellation terminates the sandbox process group, every command reports its exit status (including distinct TIMEOUT/CANCELLED states), and preflight rejects unsupported platforms, unavailable sandbox binaries/user namespaces, and `/tmp` checkouts. All panes and artifacts are preserved on failure or abort.

After SUCCESS, worker-pane cleanup defaults to `ask`; `on-success` closes only validated idle panes without confirmation, and `never` leaves them open. Failures, aborts, and CHANGES_REQUIRED never auto-close panes. Deferred cleanup is available through `development_pipeline_cleanup`; it canonicalizes real paths to prevent symlink escape, accepts only `SUCCESS` runs, enforces artifacts containment, parent/current-pane protection, role/workspace/tab identity, idle status, and Review → Verify → Implement order, recording partial failures atomically.

Review and approval remain an explicit boundary: use the tool for a user-approved task, inspect its outcome, and do not treat an unapproved repair as permission to broaden scope.
