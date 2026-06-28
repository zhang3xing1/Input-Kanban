# Preparing Tasks for Input Kanban

Use this guide when a task starts in an external Agent conversation and should be converted into a structured execution contract. The resulting `task.md` can be submitted to `input-kanban` or executed directly in the current Agent conversation with `input-kanban-execute`.

The goal is not to make Input Kanban do all planning from a vague prompt. The goal is to give it a clear execution contract so the planner, workers, and final judge have better inputs.

## Recommended Flow

1. Use the external Agent conversation to clarify the goal, scope, risks, and acceptance criteria.
2. Convert the discussion into a structured task draft.
3. Save the draft under `.tmp/input-kanban/` with a timestamped filename: `YYYYMMDD-HHmm-<short-slug>-task.md`.
4. Choose one execution path.

Dashboard path, for larger or multi-worker work, submits the task with plan approval:

```bash
input-kanban submit --task-file .tmp/input-kanban/20260601-1909-p0-precompute-input-copy-boundary-task.md --plan-approval
```

Direct single-conversation path, for smaller focused work, uses the execute skill instead:

```text
use input-kanban-execute skill on .tmp/input-kanban/20260601-1909-p0-precompute-input-copy-boundary-task.md and complete it in this conversation
```

5. For dashboard execution, review the generated plan before dispatching workers.
6. For direct execution, verify changes in the current conversation and report acceptance criteria status.
7. Use `status`, `result`, `retry`, and `stop` to control dashboard execution.

## Recommended Task File Path

Prefer timestamped local draft paths so multiple Agent-prepared handoffs are easy to sort and do not overwrite each other:

```text
.tmp/input-kanban/YYYYMMDD-HHmm-<short-slug>-task.md
```

Example:

```text
.tmp/input-kanban/20260601-1909-p0-precompute-input-copy-boundary-task.md
```

Use local time for `YYYYMMDD-HHmm`. Keep `<short-slug>` lowercase, descriptive, and shell-friendly.

## Minimal `task.md` Structure

```markdown
# Task

## Goal

Describe the desired outcome in one or two concrete paragraphs.

## Non-Goals

- List what should not be changed.

## Acceptance Criteria

- [ ] Criterion that can be tested, inspected, or verified.
- [ ] Another criterion.

## Expected Artifacts

- Path: `relative/or/absolute/path`
  Verify: command, inspection step, or expected content.

## Context References

- `path/to/spec.md`
- `path/to/relevant/file.ts`

## Execution Hints

### Suggested Batches

- Batch: first safe step
  Reason: why this is an execution barrier
  Max parallel: 1
  Tasks:
    - concrete worker instruction

## Risks and Assumptions

- Known risk, assumption, or unresolved detail.
```

## Good Handoff Checklist

- The goal is specific.
- The scope is bounded.
- Acceptance criteria are checkable.
- Expected artifacts include verification methods.
- Context references point to real material.
- Batch hints explain dependencies or safety reasons.
- Risks and assumptions are visible.

## Skill Template

Reusable skill drafts are available at:

```text
skills/input-kanban-prepare/SKILL.md
skills/input-kanban-execute/SKILL.md
```

After installing the npm package, you can install the bundled skills for Codex:

```bash
input-kanban install-skill codex
```

Use `--target-dir` if your Codex skills root is custom:

```bash
input-kanban install-skill codex --target-dir /path/to/codex/skills
```

Use `input-kanban-prepare` when you want the Agent to prepare a better `task.md`. Use `input-kanban-execute` when that prepared task should be completed directly in one conversation instead of being submitted to the dashboard.
