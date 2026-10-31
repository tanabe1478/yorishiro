# Yorishiro instructions

## Purpose

Yorishiro is a portable personal harness for pi. Keep its tracked files safe to share and useful across projects.

At the start of a task, read `AGENTS.local.md` when it exists. It contains private, machine-local preferences and must remain untracked.

## Working principles

- Inspect the relevant files and current state before changing anything.
- Prefer the smallest change that fully solves the task.
- Follow the target project's own instructions when working below `work/`; more specific project rules take precedence.
- Verify changes with the most relevant available checks before reporting completion.
- Ask before destructive, irreversible, or externally visible actions unless the user explicitly requested that exact action.
- Never commit credentials, tokens, session data, caches, or machine-specific absolute paths.

## Where knowledge belongs

- Put universal, always-needed rules in `AGENTS.md`.
- Put private preferences and machine-local notes in `AGENTS.local.md`.
- Put repeatable, on-demand workflows in `skills/<name>/SKILL.md`.
- Put controls that must be enforced in code, and external integrations, in `extensions/`.
- Keep generated artifacts and working repositories out of Git.
- Keep entry points short and apply progressive disclosure: read the detailed docs and Skills only when the current task needs them.

## Development work

For non-trivial feature, bug-fix, or refactoring work, the parent session is the Planner, not the implementer:

1. Read `skills/development-workflow/SKILL.md` and the matching playbook, then investigate read-only.
2. Present the plan, the paths to change, and the `qualityContract`, and wait for the user's agreement.
3. Run the development pipeline (`skills/development-pipeline/SKILL.md`). Its Worker implements and its Reviewer reviews.

A request such as "implement this" starts this flow; it does not authorize the parent to implement. The parent does not edit target repositories or create implementation branches or worktrees, before or during the run. Implement directly only when the user explicitly asks to skip the pipeline. If the pipeline cannot start, report why and ask instead of falling back to direct implementation. When unsure whether work is trivial, ask before editing.

When creating or auditing a project-local verification Skill, read `skills/create-verification-skill/SKILL.md` or `skills/maintain-verification-skill/SKILL.md`. Delegate all generated verification files to the pipeline's fixed Worker.

Do not add a Skill or Extension speculatively. Introduce one after a repeated need or a concrete enforcement requirement appears.
