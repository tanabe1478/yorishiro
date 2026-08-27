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

Do not add a Skill or Extension speculatively. Introduce one after a repeated need or a concrete enforcement requirement appears.
