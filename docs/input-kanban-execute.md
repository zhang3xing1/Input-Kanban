# Direct Execution Skill

Use this guide when an `input-kanban`-style `task.md` should be completed inside the current Agent conversation instead of being submitted to the Input Kanban dashboard.

The bundled skill is:

```text
skills/input-kanban-execute/SKILL.md
```

## Purpose

`input-kanban-execute` consumes the same structured handoff shape produced by `input-kanban-prepare`, but it does not create a run, dispatch workers, or use the dashboard scheduler.

It is for single-conversation execution:

1. Read the prepared task file.
2. Inspect referenced context.
3. Implement the changes directly.
4. Run verification.
5. Report acceptance criteria status.

## When to Use It

Use direct execution for:

- Focused bug fixes.
- Documentation updates.
- Small or medium code changes.
- Test fixes.
- Tasks with clear acceptance criteria that fit in one conversation.

Prefer dashboard execution for:

- Large multi-worker tasks.
- Long-running work.
- Tasks that benefit from dashboard progress visibility.
- Work needing retries, stop/archive, batch barriers, or final judge orchestration.

## Typical Flow

First prepare a structured task file:

```text
use input-kanban-prepare skill
```

Then execute directly:

```text
use input-kanban-execute skill on .tmp/input-kanban/20260628-1200-example-task.md and complete it in this conversation
```

Or submit to the dashboard instead:

```bash
input-kanban submit --task-file .tmp/input-kanban/20260628-1200-example-task.md --plan-approval
```

## Install Bundled Skills

Install both bundled Codex skills:

```bash
input-kanban install-skill codex
```

This installs:

- `input-kanban-prepare`
- `input-kanban-execute`

Use a custom skills root when needed:

```bash
input-kanban install-skill codex --target-dir ~/.codex/skills
```

## Execution Contract

The execute skill treats the task file as the contract. A good task file includes:

- Goal
- Non-Goals
- Acceptance Criteria
- Expected Artifacts
- Context References
- Execution Hints
- Risks and Assumptions

If the task is too ambiguous or too large for one conversation, the execute skill should stop and ask for clarification or recommend `input-kanban submit`.

## Final Report Expectations

The final response should include:

- What changed.
- Files changed.
- Verification commands and results.
- Acceptance criteria checklist.
- Remaining risks or follow-up work.
