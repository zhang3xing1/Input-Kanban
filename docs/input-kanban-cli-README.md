# Input Kanban CLI Usage

This page is only the entry point.

Before using `input-kanban` from another project, read:

- `docs/input-kanban-cli-skill.md`
- `docs/input-kanban-prepare.md` when the task comes from an external Agent conversation
- `docs/input-kanban-execute.md` when a prepared task should be completed directly in one Agent conversation

## What this is for

- Controlled execution through the `input-kanban` CLI
- Structured handoff from external Agent conversations
- Status checks, retry handling, result retrieval, and stop control
- Agent usage in a project that needs stable task execution

## What this is not for

- Task decomposition
- Final acceptance decisions
- Replacing external gate checks

## Install the bundled Codex skills

```bash
input-kanban install-skill codex
```

This installs both `input-kanban-prepare` and `input-kanban-execute`.

Use `--target-dir` if your Codex skills root is not `~/.codex/skills`:

```bash
input-kanban install-skill codex --target-dir /path/to/codex/skills
```

## Quick rule

- Use `submit` for a new task identity
- Use `retry` for the same task definition with a new attempt
- Use timestamped drafts like `.tmp/input-kanban/YYYYMMDD-HHmm-<short-slug>-task.md` for prepared handoffs
- Use `input-kanban-execute` for small prepared tasks that should finish in the current conversation instead of the dashboard
- Use `status` before state-dependent actions
- Use `result` for final confirmation
- Use `stop` only with an explicit `runId`
