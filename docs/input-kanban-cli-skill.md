# Input Kanban CLI Skill Draft

## Purpose

Use the `input-kanban` CLI as the execution tool for tasks that have already been decomposed and accepted externally. This skill is for controlled execution, status checks, retry handling, and result retrieval. It is not responsible for task decomposition or final acceptance decisions.

## Core Principles

- Treat `input-kanban` as the execution surface, not the source of truth for decomposition or acceptance.
- Prefer updating or retrying an existing run instead of creating a new run when the task definition is the same.
- Keep task identity stable and use attempts to represent re-execution.
- Use `status`, `result`, and `stop` for observation and control.
- Do not rely on the model alone to declare completion.

## Before `submit`: Prepare the Handoff

If the task came from an external Agent conversation, prepare a structured `task.md` first. Prefer these sections:

- `Goal`
- `Acceptance Criteria`
- `Expected Artifacts`
- `Context References`
- `Risks`

Use `skills/input-kanban-prepare/SKILL.md` when an Agent needs a stricter preparation workflow. If the prepared task should be completed directly in the current conversation instead of being submitted to the dashboard, use `skills/input-kanban-execute/SKILL.md`.

Prefer timestamped task draft paths so handoffs sort chronologically and do not overwrite each other:

```text
.tmp/input-kanban/YYYYMMDD-HHmm-<short-slug>-task.md
```

Example:

```text
.tmp/input-kanban/20260601-1909-p0-precompute-input-copy-boundary-task.md
```

## When to Execute Directly Instead

Use `input-kanban-execute` instead of `submit` when the prepared task is small enough to complete in one Agent conversation and does not need dashboard scheduling, retries, stop/archive, or final judge orchestration.

Example prompt:

```text
use input-kanban-execute skill on .tmp/input-kanban/20260601-1909-p0-precompute-input-copy-boundary-task.md and complete it in this conversation
```

## When to Use `submit`

Use `submit` only when a new task identity is needed.

Examples:

- The task goal changed.
- The workspace or scope changed materially.
- You intentionally want to start a new run with a clean history.

Recommended forms:

```bash
input-kanban submit --task "..."
input-kanban submit --task-file .tmp/input-kanban/20260601-1909-p0-precompute-input-copy-boundary-task.md
input-kanban submit --task-file .tmp/input-kanban/20260601-1909-p0-precompute-input-copy-boundary-task.md --plan-approval
input-kanban submit --task-file task.md --codex-skip-git-repo-check
```

Use `--codex-skip-git-repo-check` only for trusted umbrella / non-Git workspaces where Codex would otherwise refuse to run. It is off by default.

## When to Use `retry`

Use `retry` when the task is the same, but the previous execution did not pass a gate or failed to complete correctly.

Examples:

- Planner output was invalid.
- A worker failed or was marked unknown.
- The final judge needs another attempt after a blocking issue is resolved.

Recommended forms:

```bash
input-kanban retry <runId>
input-kanban retry <runId> <taskId>
```

Retry should be treated as a new execution attempt for the same task definition, not as an overwrite of the prior attempt.

## When to Use `status`

Use `status` whenever you need to know the current state before acting.

Recommended forms:

```bash
input-kanban status <runId>
input-kanban status <runId> --watch
input-kanban --json status <runId>
```

Use `--json` when another tool or agent needs structured output.

## When to Use `result`

Use `result` only after the run reaches a terminal state or when a final outcome is needed for review.

Recommended forms:

```bash
input-kanban result <runId>
input-kanban --json result <runId>
input-kanban result <runId> --copy
```

Prefer the persisted judge result over the model's own summary.

## When to Use `stop`

Use `stop` when execution should halt immediately.

Recommended form:

```bash
input-kanban stop <runId>
```

Only stop an explicitly named run. Never stop by guesswork.

## Suggested Control Loop

1. Discover active work:

```bash
input-kanban --json runs --active
```

2. Inspect a run:

```bash
input-kanban --json status <runId>
```

3. If blocked or failed, decide whether to retry or stop.
4. If retry is appropriate, call `retry` on the same run.
5. If the task is complete, fetch the final result:

```bash
input-kanban --json result <runId>
```

## Decision Rules

- Use `submit` only for a new task identity.
- Use `retry` for the same task definition with a new execution attempt.
- Use `status` before any action that depends on current state.
- Use `result` for final confirmation.
- Use `stop` only with a known `runId`.

## Safety Rules

- Do not create a new run just to recover from a failed attempt if the task definition has not changed.
- Do not treat a failed execution as a successful result.
- Do not let the model self-approve completion without external evidence.
- Prefer preserving history and attempt lineage.

## Practical Guidance

- If the task is still the same, keep the task identity stable and create a new attempt.
- If the task meaning changed, start a new run.
- If the run is blocked, surface the warning and wait for external intervention or a retry decision.
- If the run is already terminal, do not mutate it in place.

## Example Patterns

### New task

```bash
input-kanban submit --task "Refactor the task scheduler to support gates" --label "Scheduler gate refactor"
```

### Retry the same task

```bash
input-kanban retry run_1234567890
```

### Check progress

```bash
input-kanban status run_1234567890 --watch
```

### Get final outcome

```bash
input-kanban result run_1234567890 --copy
```

## Example Templates

### 1. Submit a new task from inline text

```bash
input-kanban submit --task "Implement the new gate workflow" --label "gate-workflow"
```

### 2. Submit a task from a file

```bash
input-kanban submit --task-file task.md
```

### 3. Submit with plan approval enabled

```bash
input-kanban submit --task-file task.md --plan-approval
```

### 4. Submit detached for background execution

```bash
input-kanban submit --task-file task.md --detach
```

### 5. Check a run once

```bash
input-kanban status run_1234567890
```

### 6. Watch a run until it changes

```bash
input-kanban status run_1234567890 --watch
```

### 7. Inspect the final result

```bash
input-kanban result run_1234567890
```

### 8. Copy the final result for handoff

```bash
input-kanban result run_1234567890 --copy
```

### 9. Retry the whole run

```bash
input-kanban retry run_1234567890
```

### 10. Stop a known run immediately

```bash
input-kanban stop run_1234567890
```

## Notes for Agent Behavior

- Prefer stable task identity over repeated recreation.
- Prefer attempt lineage over overwriting history.
- Treat gates as external decisions, not as assumptions.
- When in doubt, ask for clarification before creating a new run.
