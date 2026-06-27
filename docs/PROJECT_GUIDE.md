# Input Kanban Project Guide

This document explains how Input Kanban is implemented so that humans and coding agents can quickly understand the project before making changes.

## Current Status

Implementation status:

```text
mvp / batch-scheduler / codex-exec-primary / tmux-batch-layout / buildkite-style-ui / manual-recovery / stop-archive / cli-bootstrap / agent-guide / prepare-skill / runner-config / session-management / compact-attention-ui
```

Recent validation:

- `npm run check` passes for the CLI entry, backend modules, and test suite. The current v0.0.25 checkout passes with 127 tests.
- A smoke test can start `input-kanban` on a temporary port and read `GET /api/health`.
- The frontend is a single HTML file; its inline script can be extracted and checked with `node --check` when edited.

## Project Purpose

Input Kanban is a local Codex orchestration dashboard. It is not a business service and not a CI system.

It runs local `codex exec --json` processes, stores run state and logs on the filesystem, and serves a static HTML dashboard that polls the backend.

The intended use case is:

1. Create a run from a user task.
2. Ask a planner to split the task into batches and workers.
3. Dispatch workers by strict batch barriers.
4. Observe logs, status, artifacts, and Codex session IDs.
5. Stop or archive runs when needed.
6. Run one final judge pass after all batches complete.

## Important Boundaries

- If the current workspace is a multi-repo umbrella, the target workspace must be a concrete child directory, not the umbrella root.
- Workers can modify the target workspace. Failed workers are not automatically retried because a partial modification may already exist.
- The planner only creates a plan and does not modify the target workspace. Planner failures, invalid output, and empty plans can be safely retried before any worker or judge starts.
- Local process state, `exit_code`, logs, and artifacts are the source of truth. Codex App Server session lookup is auxiliary.
- tmux mode changes terminal visibility only. Node.js still owns scheduling, batch barriers, `maxParallel`, stop/archive, `judge_input.json`, and status refresh from `exit_code` plus artifacts.
- tmux windows stay open after command completion for human inspection, but `exit_code` is written before the keep-open shell starts so state can advance without closing the window.
- Dashboard tmux attach copy actions are shown only after tmux metadata is present. The file viewer does not repeat tmux terminal details.
- `codex exec` is treated as non-interactive; tmux mode provides live terminal visibility, not an approval UI.
- There is no batch-level judge. Only one final judge pass runs after all batches complete.

## CLI Entry

The npm CLI entry is:

```text
bin/input-kanban.js
```

It parses CLI options and sets environment variables before importing backend modules. Without a subcommand, or with `serve`, it starts the HTTP server. With `submit`, it creates a run directly in the shared runs directory and can optionally run an auto loop. Additional subcommands expose agent-friendly status/result/retry/stop flows, a usage guide, bundled skill installation, and tmux dependency checks.

Supported serve options:

```text
--host <host>
--port <port>
--workspace <path>
--repo <path>
--runs-dir <path>
--codex-bin <path>
--runner <headless|tmux>
--open
--no-open
```

Supported runs options:

```text
--runs-dir <path>
--workspace <path>
--repo <path>
--active
--include-archived
--limit <n>
--json
```

`input-kanban runs` lists visible run summaries from the shared runs directory. `--active` filters to runs that still need attention or can continue advancing. `--workspace` filters by target workspace.

Supported status options:

```text
[runId]
--runs-dir <path>
--watch
--poll-ms <ms>
```

`input-kanban status` refreshes and prints a run summary. If no `runId` is provided, it uses the latest run from the shared runs directory. `--watch` keeps polling until the run reaches a terminal state.

Supported result options:

```text
[runId]
--runs-dir <path>
--copy
```

`input-kanban result [runId]` prints the final judge result. It prefers `judge/verdict.json` and falls back to `judge/last_message.md`. If no `runId` is provided, it uses the latest run. `--copy` sends the result to the system clipboard.

Supported retry options:

```text
<runId>
[taskId]
--runs-dir <path>
--reason <text>
--max-retries <n>
--json
```

`input-kanban retry <runId> [taskId]` retries failed or unknown worker tasks. If `taskId` is omitted, it retries failed/unknown tasks in the current blocked batch. Before retrying, the worker output directory is moved under `worker_attempts/<taskId>/attempt-XX/` so failed logs, stderr, exit code, and last message remain available for audit. Retry resets the task to `pending`, records retry history, then reuses the existing scheduler.

Supported stop options:

```text
<runId>
--runs-dir <path>
--reason <text>
```

`input-kanban stop <runId>` calls the same orchestrator stop path as the Web dashboard. Stop requires an explicit run id. The backend first asks the active runner to stop known processes and then falls back to killing live stored PIDs, so Web and CLI processes can stop each other's headless workers.

Supported submit options:

```text
--workspace <path>
--repo <path>
--label <label>
--task <text>
--task-file <path|->
--max-parallel <n>
--worker-sandbox <read-only|workspace-write|danger-full-access>
--codex-skip-git-repo-check
--plan-approval
--runner <headless|tmux>
--runs-dir <path>
--auto
--no-auto
--detach / -d
--watch
--poll-ms <ms>
```

`input-kanban submit` creates a run and starts the planner. Task content can come from `--task <text>` or `--task-file <path|->`; omitting `--workspace` uses the current working directory as the target workspace, and `--repo` remains a compatibility alias. Omitting `--label` derives the run label from the first non-empty task line. Auto mode is the default for submit: it keeps polling the run through the shared orchestrator auto-advance path, dispatches batches when the plan is ready, and starts the final judge once all batches complete. `--codex-skip-git-repo-check` passes Codex `--skip-git-repo-check` through planner, worker, and judge executions for trusted umbrella or non-Git workspaces. `--plan-approval` adds a durable Planner → Worker gate: auto advances through planning, then pauses at the completed plan until the user confirms it from the Web dashboard by clicking `开始执行`. `--no-auto` keeps submit to create + plan only for the current CLI process, but a running Web server scheduler can still advance the run unless a durable gate such as `--plan-approval` is configured. `-d` / `--detach` starts a background supervisor process for the same auto loop and lets the submitting terminal return immediately. The Web server also starts a lightweight scheduler that uses this shared path, so serial batch advancement does not depend on an open browser tab. The submit output includes `input-kanban status <runId> --watch` for terminal-side observation. Because it writes to the same runs directory as the Web server, CLI-created runs are visible in the 8787 dashboard when both processes use the same `--runs-dir`.

Supported guide / skill / dependency commands:

```text
input-kanban guide [--json]
input-kanban install-skill codex [--target-dir <path>] [--force] [--dry-run] [--json]
input-kanban deps tmux [--json]
input-kanban deps install tmux [--dry-run] [--yes] [--json]
```

`guide` prints an agent-oriented control loop, decision rules, and copyable templates. `install-skill codex` installs the bundled `input-kanban-prepare` skill, which helps external Agent conversations produce structured `task.md` handoffs. `deps tmux` checks tmux availability; `deps install tmux` prints or runs a platform-specific install plan with explicit confirmation unless `--yes` is passed.

Default behavior:

- default workspace: current working directory when `input-kanban` is launched; run creation only validates that the selected directory exists and is a directory; Git is detected and labeled when available;
- default host: `127.0.0.1`;
- default port: `8787`;
- default runs directory: `~/.input-kanban/runs`;
- default Codex binary: `codex`.

## Agent Workflow

This project already exposes an agent-friendly CLI path. Use `--json` for machine-readable output and `runs --active` to discover current work before asking for per-run details.

Discovery / lookup pattern:

```text
input-kanban --json runs --active
input-kanban --json status <runId>
input-kanban --json result <runId>
input-kanban --json stop <runId>
```

Key points:

- `runs` lists visible batches from the shared runs directory; `--active` filters to runs that have not reached a terminal state or still have running tasks.
- `status` resolves a single run by id and defaults to the latest run when the id is omitted.
- `result` prefers `judge/verdict.json` and falls back to `judge/last_message.md`; `--copy` copies the result to the clipboard.
- `stop` requires an explicit `runId` and uses the same stop path as the Web dashboard.
- `retry` retries failed/unknown workers while preserving the failed attempt directory.
- `submit` defaults to auto mode: planner -> dispatch -> final judge, with one automatic retry for `batch_blocked` by default. `--plan-approval` changes this to planner -> wait for plan confirmation -> dispatch -> final judge. `--no-auto` keeps create + plan only for the CLI process, and `-d/--detach` moves the auto loop to a background supervisor.
- The Web server scheduler follows the same shared auto behavior: after planning it auto-dispatches planned runs and auto-starts the final judge once all batches complete, unless a plan approval gate is required and still unapproved.

Example agent loop:

```text
1. input-kanban --json runs --active
2. input-kanban --json status <runId>
3. input-kanban --json result <runId>
4. input-kanban --json stop <runId>   # only when necessary
```

## Data Model

### Run

A run is one user-submitted task batch. It appears as one card in the left sidebar and maps to one runtime directory:

```text
runs/<runId>/
```

Main files:

```text
task.md
plan.json
run_state.json
```

### Batch

A batch is a strict scheduling barrier produced by the planner. Only the first incomplete batch is eligible for scheduling. Later batches must wait until all earlier batches complete.

### Task

A task is one worker inside a batch. Batch-level parallelism is controlled by `batch.maxParallel`.

### Roles

- `planner`: read-only `codex exec` that returns a plan.
- `worker`: `codex exec` that performs work. The run-level worker sandbox defaults to `workspace-write`, and the create form can explicitly select `read-only` or `danger-full-access`.
- `judge`: read-only `codex exec` that performs final evaluation.

## Run State Machine

Common run states:

- `created`: run exists, planner has not started.
- `planning`: planner is running.
- `plan_failed`: planner failed or returned output that could not be parsed.
- `plan_empty`: planner returned valid JSON but zero tasks.
- `planned`: planner produced executable tasks.
- `running`: at least one worker in the current batch is running.
- `batch_blocked`: the current batch has a `failed` or `unknown` worker; later batches will not start.
- `batches_completed`: all batches completed; final judge can run.
- `judging`: final judge is running.
- `judged`: final judge process completed.
- `judge_failed`: final judge process failed.
- `stopped`: user stopped the run; no further scheduling occurs.
- `load_failed`: summary-only status used when an existing run directory cannot be normalized; it keeps corrupted or incompatible runs visible instead of silently hiding them.

## Planner Retry Policy

Planner retry is allowed only before any worker or judge has started.

Before retrying, the backend:

1. Moves the current `planner/` directory to `planner_attempts/attempt-XX/`.
2. Clears current `tasks` and `batches`.
3. Resets `judge` state.
4. Deletes old `plan.json`.
5. Starts a new planner in a clean `planner/` directory.

If the planner returns valid JSON with zero tasks, the run is marked `plan_empty`. The UI shows a warning and allows planning again.

## Worker Failure Policy

Failed or unknown workers can be retried explicitly with `input-kanban retry <runId> [taskId]` or via Web/API retry. CLI/Web auto mode may retry a blocked batch once by default.

Retry rules:

- Retry is an orchestrator-level state transition, not a runner auto-restart.
- Retry refuses stopped or archived runs.
- Retry refuses tasks that still have a live process.
- Retry preserves failed output under `worker_attempts/<taskId>/attempt-XX/` before resetting the task.
- Retry resets failed/unknown tasks to `pending`, records retry history, and reuses the existing scheduler.

Recovery options after retries are exhausted:

- Inspect `events.pretty`, `stderr.log`, `last_message.md`, archived worker attempts, and artifacts.
- Manually mark `failed` or `unknown` workers as completed if the user confirms the work is actually done.
- Manual completion writes `workers/<taskId>/manual_completion.json`.
- If the user pastes a manual success result, it is saved as `workers/<taskId>/manual_result.md` and included in final judge input.
- The UI preserves the original failed or unknown status while also showing the manual completion marker.

## Run State Concurrency and Retry Implementation Notes

### Failure Retry

Retry is implemented as an explicit orchestrator state transition.

Implemented behavior:

- `input-kanban retry <runId> [taskId]` retries either one failed/unknown task or, when `taskId` is omitted, failed/unknown tasks in the current blocked batch.
- CLI/Web auto mode retries a `batch_blocked` run once by default via the same retry path.
- Retry reuses the existing scheduler and does not trigger replanning.
- Planner retry remains separate and only applies before any worker or judge starts.

Safety requirements enforced by implementation:

1. Refuse retry when the run is `stopped` or `archived`.
2. Refuse retry if the target task still has a live process.
3. Preserve the failed attempt directory under `worker_attempts/<taskId>/attempt-XX/` before resetting the task to `pending`.
4. Reset the run back to `running` when there is pending retry work, then let the existing scheduler start workers naturally.
5. Keep retry counters and history on the task so agents can tell transient noise from deterministic task failure.

Why this shape was favored:

- Runner-level auto-restart hides intent from the state machine and would have to be duplicated for headless/tmux.
- Auto-replan is too heavy for a single failed worker and would throw away useful per-task evidence.
- The retry decision belongs to orchestration, where agents and humans can see it explicitly.

### `run_state.json` Concurrency Safety

The backend now uses a per-run lock file to protect state writes. Atomic writes prevent partial files; the lock prevents common lost-update races between detach supervisors, CLI commands, and Web API actions.

Implemented shape:

- The lock file is `run_state.lock` inside the run directory.
- Lock acquisition uses exclusive file creation and stores `pid`, `runId`, and timestamp in the lock file.
- Stale locks can be recovered when the owning PID is gone and the lock is older than the stale threshold.
- Lock granularity is one run, so different runs do not block each other.
- State transition paths re-read the run inside the lock before mutating it.

Write paths under lock include:

- planner start and completion callback;
- dispatch;
- retry;
- stop;
- archive;
- rename;
- manual task completion;
- judge start and completion callback;
- refresh/recovery state materialization.

Risk notes:

- A stale-lock timeout that is too short can accidentally steal a lock from a slow or paused process; too long slows recovery.
- `child.onExit` callbacks must continue to take the write lock.
- If the workspace ever moves to shared network storage, the current single-machine exclusive-file assumptions should be re-evaluated.

## Stop and Archive

### Stop

`POST /api/runs/:runId/stop` terminates still-running local `codex exec` child processes for that run and freezes the run as `stopped`.

### Archive

`POST /api/runs/:runId/archive` performs a soft archive:

- writes `archived: true` to `run_state.json`;
- does not move the run directory;
- hides the run from default `GET /api/runs` and the left sidebar.

Archived runs can be queried with:

```text
GET /api/runs?includeArchived=1
```

## Left Sidebar Behavior

The left sidebar is rendered from API summaries, not direct file reads.

Flow:

1. Backend scans `runs/<runId>/run_state.json`.
2. `summaryOfRun()` creates summaries.
3. `GET /api/runs` returns those summaries.
4. Frontend renders run cards.

Current behavior:

- Shows the newest 10 runs by default.
- `Show more` appends 10 more runs.
- Sidebar height is fixed to the viewport; the run list has its own vertical scroll.
- Each card shows label, status, run ID, creation time, progress, running count, and failed count.
- Long labels are clamped to two lines with a browser tooltip for the full value.

## Final Judge

Final Judge runs once after all batches complete.

Before starting the judge, the backend generates:

```text
runs/<runId>/judge/judge_input.json
```

This manifest is the judge's primary source of truth. It contains:

- run metadata;
- original task text;
- `plan.json`;
- batch summaries and task order;
- planner status, output, and parse errors;
- worker status, exit code, start/end timestamps, expected artifacts;
- each worker's `last_message.md`, `result.json`, `evidence.json`, `manual_completion.json`, and stderr tail.

The judge prompt instructs the model to use `judge_input.json` first and inspect other run artifacts only if needed. This makes final evaluation more deterministic than asking the judge to discover files on its own.

## File Viewer

The file viewer calls:

```text
GET /api/runs/:runId/tasks/:taskId/file?name=...
```

It can read planner, worker, and judge files.

Current behavior:

- Selecting a task updates the file viewer title to `runId / taskId`.
- File tabs are role-specific. Planner, worker, and judge views expose only their common or relevant files.
- If a file tab is already open, switching tasks reloads the same file only when that role exposes the same tab; otherwise the file view is cleared.
- Auto refresh also reloads the selected task's selected file and attempts to preserve scroll position.
- `events.pretty` is a virtual file generated by formatting `events.jsonl` into a readable Chinese execution log.
- The execution view shows event counts and a jump-to-bottom button.
- `last_message.md` has a hover copy button in the top-left of the text area.
- `judge_input.json` and `verdict.json` are shown for the judge role. `exit_code` is not a default file tab because the task table already shows exit codes.
- Runtime attention hints for workers are shown as compact task-row bubbles. The popover can include nearby log context and, when a Codex session id is available, a `codex resume <sessionId>` copy action for manual intervention.

## Files and Responsibilities

```text
bin/input-kanban.js       CLI entry; parses args and starts server
src/server.js             HTTP server, static files, API routes
src/orchestrator.js       run state machine, scheduling, codex exec, stop/archive, file formatting
src/agents/codexExecutor.js Codex command/script executor adapter used by runners
src/appServerClient.js    Codex App Server stdio client and session lookup
src/config.js             local Input Kanban config, including default runner
src/deps.js               dependency detection/install plans, currently tmux
src/status.js             run status classification helpers
src/utils.js              paths, IDs, atomic JSON writes, file info, JSON extraction
public/index.html         single-file frontend, no build step
skills/input-kanban-prepare/SKILL.md bundled prepare skill for structured handoffs
README.md                 user-facing overview
docs/PROJECT_GUIDE.md     implementation guide for humans and agents
ENVIRONMENT.md            runtime environment variable reference
```

Runtime files:

```text
runs/<runId>/run_state.json
runs/<runId>/task.md
runs/<runId>/plan.json
runs/<runId>/planner/
runs/<runId>/planner_attempts/attempt-XX/
runs/<runId>/workers/<taskId>/
runs/<runId>/worker_attempts/<taskId>/attempt-XX/
runs/<runId>/judge/judge_input.json
runs/<runId>/workers/<taskId>/events_timed.jsonl
runs/<runId>/workers/<taskId>/manual_result.md
runs/<runId>/judge/verdict.json
```

## API

- `GET /`
- `GET /api/health`
- `GET /api/codex`
- `GET /api/pi`
- `GET /api/config`
- `PATCH /api/config`
- `GET /api/tmux`
- `GET /api/session-management`
- `GET /api/session-management/processes`
- `GET /api/runs`
- `GET /api/runs?includeArchived=1`
- `POST /api/runs`
- `GET /api/runs/:runId/status`
- `POST /api/runs/:runId/plan`
- `POST /api/runs/:runId/dispatch`
- `POST /api/runs/:runId/judge`
- `POST /api/runs/:runId/retry`
- `POST /api/runs/:runId/stop`
- `POST /api/runs/:runId/archive`
- `PATCH /api/runs/:runId/label`
- `GET /api/runs/:runId/task-text`
- `GET /api/runs/:runId/tasks/:taskId/file?name=...`
- `POST /api/runs/:runId/tasks/:taskId/mark-completed`

## Planner Output

Preferred shape:

```json
{
  "batches": [
    {
      "id": "batch-1",
      "name": "first batch",
      "maxParallel": 3,
      "tasks": [
        {
          "id": "T-01",
          "name": "short name",
          "prompt": "worker prompt",
          "sandbox": "workspace-write",
          "expectedArtifacts": []
        }
      ]
    }
  ],
  "finalJudgeRequired": true
}
```

Backward-compatible shape:

```json
{
  "tasks": [
    {
      "id": "T-01",
      "name": "short name",
      "prompt": "worker prompt",
      "sandbox": "workspace-write",
      "expectedArtifacts": []
    }
  ]
}
```

The old `tasks` format is wrapped into `batch-1` automatically.

## Development Checks

```bash
npm run check
```

When editing `public/index.html`, also consider extracting the inline script and checking it with `node --check`.

## Manual Smoke Checklist

Use this checklist before an npm release when runner behavior or package contents
change. Record the exact commands, run ids, and artifact paths in the release
notes or handoff.

1. Headless runner:
   - Start the app with `input-kanban --runner headless --runs-dir <tmp-runs-dir> --workspace <target-workspace> --port <free-port>`.
   - Create a small run, plan it, dispatch at least one worker, and run the final judge if the plan requires it.
   - Verify the run state reports `runner: headless`, no task exposes `tmux` metadata, and role directories contain the expected `prompt.md`, `events.jsonl`, `events_timed.jsonl`, `stderr.log`, `last_message.md`, and `exit_code` files.
   - Stop the run and verify no unrelated local process is affected.

2. tmux runner, only when `tmux -V` succeeds:
   - Start the app with `input-kanban --runner tmux --runs-dir <tmp-runs-dir> --workspace <target-workspace> --port <free-port>`.
   - Create a small run and click Plan. Verify a session named `input-kanban-<runId>` exists and has a planner window.
   - Dispatch workers. Verify each batch gets its own window with an overview pane plus worker panes, and each role directory writes `run.sh` and `tmux.json` with the expected `sessionName`, `windowName`, `target`, and `attachCommand`.
   - Verify `run.sh` writes `exit_code` before printing the keep-open summary, then keeps the window open for manual inspection.
   - Verify status refresh can advance planner, workers, and judge to `completed`, `planned`, or `judged` from filesystem state while tmux windows remain open.
   - Verify the UI does not show run attach copy before tmux metadata exists, then shows `复制tmux attach指令` in the run detail header after metadata exists. Verify the file viewer does not show a separate tmux terminal info panel.
   - Complete or stop the run. Verify stop removes only the exact `input-kanban-<runId>` tmux session and leaves any other tmux session running.
   - Do not mark this smoke as passed when tmux is unavailable or when these tmux checks were not run.

3. Package dry run:
   - Run `npm pack --dry-run`.
   - Verify the package includes `bin/`, `src/`, `public/`, `README.md`, `README.en.md`, `docs/PROJECT_GUIDE.md`, `ENVIRONMENT.md`, and `package.json`.
   - Verify no runtime run directories, local logs, or unrelated temporary artifacts are included.

## Release Notes

Keep a single repository-level `RELEASE_NOTES.md` with recent version history. Do not add one tracked `RELEASE_NOTES.vX.Y.Z.md` file per release. When creating a GitHub Release, use a temporary notes file or copy the relevant version section from `RELEASE_NOTES.md` into `gh release create --notes-file`.

## Change Guidelines

- Do not add automatic worker retry unless there is a verified rollback or idempotency mechanism.
- Do not default to bypassing workspace validation; prefer a concrete target child workspace.
- Preserve batch barriers when modifying scheduling logic.
- Decide clearly between soft archive and physical directory archive before changing archive semantics.
- Keep the frontend buildless unless there is a strong reason to introduce a build pipeline.
