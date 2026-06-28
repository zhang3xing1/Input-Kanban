---
name: input-kanban-execute
description: "Execute an input-kanban-style task.md directly inside the current Agent conversation without submitting it to the Input Kanban dashboard."
---

# input-kanban-execute

Use this skill when the user has an `input-kanban`-style `task.md` handoff, often produced by `input-kanban-prepare`, but wants the current Agent conversation to complete the task directly instead of submitting it to the Input Kanban dashboard.

This skill executes in the current conversation. It does not create an Input Kanban run, does not dispatch workers, and does not use the dashboard scheduler.

## Non-Negotiable Rules

- Read the task file before doing implementation work.
- Treat the task file as the execution contract: Goal, Non-Goals, Acceptance Criteria, Expected Artifacts, Context References, Execution Hints, Risks, and Assumptions.
- Do not broaden scope beyond the task file without asking the user.
- If the task file is ambiguous, contradictory, unsafe, or too large for one conversation, stop and ask clarifying questions or recommend `input-kanban submit`.
- Inspect relevant files, docs, tests, and referenced context before editing.
- Prefer small, reversible edits.
- Run relevant verification commands when available and report exact results.
- Do not claim completion unless every acceptance criterion is satisfied or explicitly marked as not completed with a reason.
- Do not call `input-kanban submit` unless the user explicitly changes the goal to dashboard execution.

## When to Use This Instead of the Dashboard

Use direct execution for:

- Small or medium single-threaded tasks.
- Documentation updates.
- Focused bug fixes.
- Test fixes.
- Tasks with clear acceptance criteria that fit in one conversation.

Prefer `input-kanban submit` for:

- Large multi-worker tasks.
- Work that benefits from dashboard visibility, retries, stop/archive, or long-running background execution.
- Tasks requiring strict batch barriers or independent parallel subtasks.
- Work that should have an auditable Input Kanban run state.

## Workflow

1. Ask for the task file path if it is not provided.
2. Read the full task file.
3. Summarize:
   - Goal
   - Non-Goals
   - Acceptance Criteria
   - Expected Artifacts
   - Risks / assumptions
4. Decide whether the task fits one direct conversation.
   - If not, recommend submitting it to Input Kanban.
5. Inspect the referenced files and any nearby implementation context.
6. Produce a compact execution plan.
7. Execute the plan with normal coding-agent tools.
8. Run targeted verification, then broader verification if appropriate.
9. If verification fails, fix reasonable issues and rerun.
10. Final response must include:
    - What changed
    - Files changed
    - Verification commands and results
    - Acceptance criteria status
    - Remaining risks or follow-up work

## Execution Plan Format

Keep plans short and operational:

```markdown
Plan:
1. Inspect ...
2. Change ...
3. Verify ...
```

Do not over-plan simple tasks.

## Acceptance Criteria Checklist

In the final response, report each criterion as:

```markdown
Acceptance Criteria:
- [x] Criterion ... — verified by `command` / file inspection / artifact
- [ ] Criterion ... — not completed because ...
```

## Expected Artifacts

If the task file lists expected artifacts:

- Create or update them when required.
- Verify they exist.
- Mention them in the final response.

If an expected artifact is no longer appropriate after inspection, explain why before skipping it.

## Verification Guidance

Prefer existing project commands, such as:

```bash
npm run check
node --test <test-file>
pytest <test-file>
go test ./...
```

Choose the smallest useful verification first. Run broader checks when the task touches shared infrastructure, public APIs, or UI behavior.

## Stop Conditions

Stop and ask the user before continuing when:

- Required context is missing.
- The task conflicts with repository policy or user constraints.
- The requested change is much larger than the prepared task.
- Verification requires credentials, services, or destructive operations not approved by the user.
- The task should be handled by parallel workers or long-running dashboard orchestration.

## Relationship to input-kanban-prepare

`input-kanban-prepare` writes a structured handoff.

`input-kanban-execute` consumes that handoff and completes it in the current conversation.

Typical direct-execution prompt:

```text
Use input-kanban-execute on .tmp/input-kanban/20260628-1200-example-task.md and complete it in this conversation.
```

Typical dashboard alternative:

```bash
input-kanban submit --task-file .tmp/input-kanban/20260628-1200-example-task.md --plan-approval
```
