# Release Notes

## Unreleased

- No unreleased changes yet.

## v0.0.31

### Highlights

- Make status reads snapshot-first by default: `input-kanban status`, `status --watch`, and the Web dashboard status endpoint now read the saved `run_state.json` snapshot without taking the run-state lock.
- Add explicit refresh paths for users who need to sync runner state immediately: `input-kanban status <runId> --refresh` and `GET /api/runs/:id/status?refresh=1`.
- Keep the Web dashboard responsive under concurrent Agent/CLI observation by letting automatic detail refreshes read snapshots while the server scheduler remains responsible for normal auto-advancement.
- Update the Web refresh button, status hint text, CLI help, README files, and project guide to reflect the new snapshot-vs-refresh semantics.
- Add regression coverage for snapshot reads while a run-state lock is busy and for the server status endpoint's default snapshot behavior.

### Verification

- `npm run check` passed locally with 147 tests.
- Windows-native validation passed on `zhangxing_win` with `npm run check` and 147 tests in a temporary Windows validation directory.

## v0.0.29

### Highlights

- Recover planner runs automatically when Codex refuses a non-trusted/non-Git workspace by enabling `--skip-git-repo-check` and retrying the planner once.
- Prevent planner/judge child-process `onExit` state update failures, including `run_state.lock` contention, from crashing `input-kanban serve`.
- Make stale run-state lock recovery immediate once the lock file is old enough and the recorded pid is no longer alive.
- Keep `/api/runs/:id/status` responsive when a run-state lock is busy by returning the last saved run snapshot with a clear `statusRefreshError` instead of waiting 30 seconds.
- Speed up batch detail switching by caching loaded task log files in the browser using run/task/file size and mtime cache keys.
- Show recent batch-detail and task-file load durations in the batch-detail refresh indicator tooltip.
- Avoid slow Codex App Server thread enrichment blocking status refreshes by using a short status-specific timeout and caching success/error enrichment results.

### Verification

- `npm run check` passed locally with 146 tests.
- Windows-native validation passed on `zhangxing_win` with `npm run check` and 146 tests in a temporary Windows validation directory.

## v0.0.28

### Highlights

- Add the bundled `input-kanban-execute` Codex skill for completing prepared `task.md` handoffs directly in one Agent conversation without creating an Input Kanban dashboard run.
- Update `input-kanban install-skill codex` to install both `input-kanban-prepare` and `input-kanban-execute`.
- Document the two prepared-task execution paths: submit to the dashboard or execute directly in the current conversation.
- Surface per-task agent backend labels in the task table so Codex and Pi worker tasks are clearly distinguished.
- Hide Codex resume actions for Pi workers and avoid attaching Codex App Server threads to Pi-backed worker tasks.
- Reject `runner=tmux` with `workerBackend=pi` instead of silently running tmux workers through Codex; the Web UI now warns immediately when that incompatible combination is selected.

### Verification

- `npm run check` passed locally with 142 tests.
- Windows-native validation passed on `zhangxing_win` with `npm run check` and 142 tests in a temporary Windows validation directory.

## v0.0.27

### Highlights

- Integrate PR #5's automatic tmux shell backend detection with the existing v0.0.26 pi worker backend.
- Add native tmux run scripts for POSIX shell, PowerShell, and cmd, selecting PowerShell/cmd automatically on Windows and bash/sh elsewhere.
- Detect tmux shell availability alongside tmux itself, blocking tmux run creation when tmux is installed but no usable shell backend is available.
- Record tmux shell and pane metadata in `tmux.json`, including pane selection/attach commands and backend-specific run script paths.
- Preserve both Web UI preferences: `Worker 后端` and selected runner mode.
- Keep `pi` worker execution headless-only while tmux tasks remain Codex-backed.

### Verification

- `npm run check` passed locally with 137 tests.
- Windows-native validation passed on `zhangxing_win` with `pi` 0.80.2 installed; tmux/psmux were absent and no supported installer was available, so validation covered shell backend detection, tmux missing/install failure handling, and `npm run check` with 137 tests in a temporary Windows validation directory.

## v0.0.26

### Highlights

- Add a headless `pi` worker backend while keeping planner and final judge on Codex exec.
- Add a Web UI `Worker 后端` selector so new runs can choose `Codex exec` or `Pi Coding Agent` for workers.
- Add CLI/API worker backend support through `--worker-backend <codex|pi>`, `workerBackend`, and `KANBAN_WORKER_BACKEND`.
- Persist the worker backend in run state and keep Codex as the default for existing behavior.
- Record Pi JSON events, timed events, stderr, exit code, prompt, and `last_message.md` artifacts for headless worker tasks.
- Resolve Pi `.js` launchers through Node on Windows to avoid `spawn EFTYPE` failures.

### Verification

- `npm run check` passed locally with 129 tests.
- Windows-native validation passed on `zhangxing_win` after installing `pi` 0.80.2 with `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`; `npm run check` passed with 129 tests in a temporary Windows validation directory.

## v0.0.25

### Highlights

- Refactor task execution behind a Codex executor adapter without changing runtime behavior, so headless/tmux runners call `startAgentTask()` while preserving the existing `startCodexTask` compatibility alias.
- Move Codex command construction, task artifact paths, and tmux `run.sh` generation into `src/agents/codexExecutor.js` as preparation for future agent backends.
- Add backend-visible Pi Coding Agent command monitoring via `KANBAN_PI_BIN`, `GET /api/pi`, and short cached `pi --version` detection.
- Show the detected Pi version in the dashboard footer next to the existing Codex status, with a horizontal footer layout and an install hint when `pi` is unavailable.
- Document the Pi detection environment variables and keep the current task execution path Codex-only.

### Verification

- `npm run check` passed locally with 127 tests.
- Windows-native validation passed on `zhangxing_win` with `npm run check` in a temporary Windows release-candidate directory.

## v0.0.24

### Highlights

- Reduce noise from runtime attention hints by removing the large run-level warning banner for worker attention hints.
- Replace the task-row intervention warning text with a compact bubble icon that shows details only on hover or keyboard focus.
- Keep the `介入 resume` action inside the bubble popover so manual intervention remains available without dominating the task table.
- Sanitize public release notes to avoid exposing local Windows user profile paths; verification now references temporary Windows release-candidate directories generically.

### Verification

- `node --test test/frontend-tmux-ui.test.js test/attention-hint.test.js` passed locally.
- `npm run check` passed locally with 126 tests.
- Windows-native validation passed on `zhangxing_win` with `npm run check` in a temporary Windows release-candidate directory.

## v0.0.23

### Highlights

- Document a timestamped draft filename convention for `input-kanban-prepare`, using `.tmp/input-kanban/YYYYMMDD-HHmm-<short-slug>-task.md` so prepared handoffs sort chronologically and avoid overwrites.
- Update the bundled `input-kanban-prepare` skill, CLI guide output, and README handoff examples to recommend the timestamped draft path.
- Improve runtime attention hints so tool argument errors can surface nearby log context instead of only a generic warning string.
- Widen and reflow the task-row warning/action area so long warning text renders horizontally, and add a clearer `介入 resume` label for manual intervention.
- Correct the copied Codex session resume command from `codex exec resume <sessionId>` to `codex resume <sessionId>`.

### Verification

- `node --test test/cli-submit.test.js` passed locally.
- `node --test test/attention-hint.test.js test/frontend-tmux-ui.test.js` passed locally.
- `npm run check` passed locally with 126 tests.
- Windows-native validation passed on `zhangxing_win` with `npm run check` in a temporary Windows release-candidate directory.

## v0.0.22

### Highlights

- Move the implementation-oriented project guide from the repository root to `docs/PROJECT_GUIDE.md` and update README/package references accordingly.
- Record PR #4's `v0.0.19` validation branch as integrated via `v0.0.21`, preserving PR provenance without reintroducing older code over the current mainline.

### Verification

- `npm run check` passed locally with 125 tests.
- PR #4 was separately validated on a temporary `v0.0.19` worktree with `npm run check` passing 119 tests.

## v0.0.21

### Highlights

- Add platform-aware runner selection: runs can use `headless` or `tmux`, with Web creation controls and per-run persistence.
- Add local default runner configuration shared by CLI and Web UI, while allowing `KANBAN_RUNNER` to override the local default.
- Add tmux dependency detection and explicit install guidance via `input-kanban deps tmux` and `input-kanban deps install tmux`.
- Support Windows tmux-compatible install guidance through `winget install --id marlocarlo.psmux -e`, clearly noting psmux is a third-party tmux-compatible implementation.
- Block tmux run creation when tmux is unavailable instead of silently falling back to headless.
- Surface `load_failed` run summaries with visible load error details when a stored run cannot be normalized.
- Surface running worker warnings before final judge by detecting patch context drift, tool argument errors, permission/sandbox denials, and HTTP 401/403/409 environment blockers from worker logs.
- Show run-level warning text and add a task-row `resume` copy action so users can quickly resume the Codex session for manual intervention.

### Verification

- `npm run check` passed locally with 125 tests.
- Windows-native validation passed on `zhangxing_win` with `npm run check` in a temporary Windows release-candidate directory.

## v0.0.20

### Highlights

- Add an explicit Web UI checkbox, checked by default, and a CLI flag for trusted umbrella / non-Git workspaces to pass Codex `--skip-git-repo-check` through planner, worker, and judge executions.
- Persist the bypass as run-level metadata and show it in the selected run header only when enabled.
- Surface `worker context` unauthorized failures as explicit worker attention hints in the task table.
- Describe the bundled `input-kanban-prepare` skill in the README files, including its role as a task handoff preparer rather than an executor.

### Verification

- `npm run check` passed locally.
- Windows-native validation passed on `zhangxing_win` with `npm run check` in a temporary Windows release-candidate directory.

## v0.0.19

### Highlights

- Add Codex-compatible YAML frontmatter to the bundled `input-kanban-prepare` skill so installs are immediately discoverable by Codex.

### Verification

- `node --test test/cli-submit.test.js` passed locally.
- `git diff --check` passed locally.

## v0.0.18

### Highlights

- Rework the main README files to focus on how to use Input Kanban instead of only describing what it is.
- Add `skills/input-kanban-prepare/SKILL.md` and `docs/input-kanban-prepare.md` for structured task handoff from external Agent conversations.
- Add `input-kanban install-skill codex` to install the bundled `input-kanban-prepare` skill into a Codex skills directory.
- Extend `input-kanban guide` and `input-kanban --help` with a handoff-aware preparation flow and execution template.
- Teach the planner prompt to treat structured handoff sections such as Goal, Acceptance Criteria, and Expected Artifacts as the execution contract.

### Verification

- `node --test test/cli-submit.test.js` passed locally.
- `git diff --check` passed locally.
- `node --check bin/input-kanban.js && node --check src/orchestrator.js` passed locally.
- Windows-native validation passed on `zhangxing_win` with `npm run check` in the Windows release-candidate working tree.

## v0.0.17

### Highlights

- Add a friendly `input-kanban guide` CLI entry that prints an agent-oriented control loop, decision rules, and ready-to-copy execution templates.
- Extend `input-kanban --help` with a visible agent guide entry point so CLI-only agents can discover the execution flow without reading repository docs.
- Add a small `docs/input-kanban-cli-README.md` entry page and a reusable `docs/input-kanban-cli-skill.md` execution guide for external-project reuse.

### Verification

- `node --test test/cli-submit.test.js` passed locally.
- `git diff --check` passed locally.
- Windows-native validation passed on `zhangxing_win` with `npm run check` in the Windows release-candidate working tree.

## v0.0.16

### Highlights

- Add a low-profile footer entry for session management, covering both board-managed and local Codex sessions.
- Show board/local tabs in the session modal and classify sessions with lightweight board-managed metadata.
- Add local Codex process visibility in the session modal, including resumable sessions, other Codex-related processes, and total memory usage in the modal header.
- Simplify the session modal layout with a compact close control, adjustable height, wider default width, and reduced empty spacing.
- Keep only meaningful session status badges, hide `unknown` in session cards, and move session IDs/copy actions to the right side.

### Verification

- `node --test test/server-static.test.js` passed locally.
- `node --test test/frontend-tmux-ui.test.js` passed locally.
- Windows-native validation passed on `zhangxing_win` with `npm run check` in the Windows release-candidate working tree.

## v0.0.15

### Highlights

- Absorb PR #3 recovery hardening without directly merging its older `v0.0.13` branch, preserving the `v0.0.14` Plan Approval Gate and Web layout changes.
- Route blocked-run dashboard execution actions to `/api/runs/:id/retry`, so `batch_blocked` runs retry failed/unknown tasks instead of hitting the dispatch endpoint.
- Remove stale Web `workers_completed` / `workers_failed` UI state handling now that backend run status uses `batches_completed` and `batch_blocked`.
- Harden final judge starts: reject archived/stopped runs, duplicate running judges, and completed judges; failed judges are archived to `judge_attempts/` before retrying.
- Add short `/api/codex` detection caching to avoid repeatedly spawning Codex detection during frequent dashboard refreshes.
- Keep task-table Codex session IDs and their copy buttons on one line by widening the session column and using a compact inline layout.

### Verification

- `npm run check` passed locally with 84 tests.
- `npm pack --dry-run` passed for `input-kanban@0.0.15`.
- Windows release-candidate validation on `zhangxing_win` passed with 84 tests.
- Windows Web smoke confirmed `/api/health`, `/api/codex`, Plan Approval UI, compact header copy tools, and one-line Codex session copy layout.

## v0.0.14

### Highlights

- Add a durable Plan Approval Gate: runs can now pause after planning until the generated plan is manually confirmed.
- Add `input-kanban submit --plan-approval`, which lets auto advance through planning and then stop at the unapproved plan gate instead of dispatching workers immediately.
- Make `dispatchRun()` confirm the plan gate before starting workers, so Web `开始执行` means “approve this plan and continue execution.”
- Clarify auto semantics in docs: auto advances to completion, failure, or the first unapproved gate; `--no-auto` is not a durable scheduler gate.
- Update the Web create form wording to `计划生成后手动确认后执行` and show planned gated runs as `已拆分，待确认`.
- Rework the run detail header layout: keep title/status on the left, move `Run ID ⧉` and `tmux ⧉` copy tools to a lightweight right-side tool group, and keep long unreadable IDs out of metadata chips.
- Record the Agent Profile / Candidate / Reviewer design direction in the private KB while keeping the current executor Codex-only.

### Verification

- `npm run check` passed locally with 78 tests.
- `npm run check` passed on the remote Windows validation host `zhangxing_win` with 78 tests for the release-candidate working tree.
- Windows Web smoke confirmed the plan approval input, compact title copy tools, `/api/health`, and `/api/codex`.

## v0.0.13

### Highlights

- Harden Codex launching on Windows by resolving npm `codex.cmd` shims and explicit JavaScript launchers through a shared `resolveCodexLauncher()` adapter.
- Use the shared Codex launcher path from the app-server client, headless runner, tmux runner, and Web footer Codex detection.
- Add `/api/codex` and a compact Web footer Codex status that shows the backend-visible CLI version, for example `codex-cli 0.139.0`, without relying on npm registry `latest` by default.
- Improve Web action feedback by turning run action buttons into lightweight state indicators: pending actions disable immediately, active backend states pulse subtly, and retry/done states use concise labels.
- Keep `batch_blocked` runs discoverable via `input-kanban runs --active`, so agent/CLI auto loops can continue recoverable work instead of hiding blocked batches.
- Make retry preparation atomic when selected tasks include a live process: no worker attempt is archived until all selected tasks are confirmed safe to retry.
- Add Windows-focused regression coverage for Codex launcher resolution, app-server spawn failures, headless spawn failures, and tmux launcher quoting.

### Verification

- `npm run check` passed locally with 76 tests.
- `npm run check` passed on the remote Windows validation host `zhangxing_win` with 76 tests after installing `@openai/codex` CLI.
- Windows backend Codex detection returned `codex-cli 0.139.0` through `detectCodexInfo()`.

## v0.0.12

### Highlights

- Fix Windows startup/static serving by resolving `APP_ROOT` with `fileURLToPath(import.meta.url)` instead of URL pathname parsing.
- Add a regression test for serving `/` and `/api/health` from the HTTP server.
- Add task-detail hover guidance for sandbox and network capability issues, clarifying that sandbox-denied errors are not necessarily task failures.
- Remember the last selected Web worker sandbox mode in browser local storage, so users do not need to reselect `danger-full-access` or other modes each time.
- Auto-scroll the execution process view to the end when opened, while preserving the user's scroll position during refresh if they have scrolled upward.

### Verification

- `npm run check` passed with 64 tests.
- `npm pack --dry-run` passed before release prep.

## v0.0.11

### Highlights

- Simplify the Web sidebar header: show `任务批次` as the section title with a compact `新建` action on the right, removing repeated wording.
- Document safe `input-kanban serve` restarts for `tmux` runner: already-running Codex sessions in tmux continue while the server is down, and the scheduler resumes after restart.
- Clarify that `headless` runner does not provide the same safe-restart guarantee for in-flight child processes.

### Verification

- `npm run check` passed with 63 tests.
- `npm pack --dry-run` passed before release prep.

## v0.0.10

### Highlights

- Adopt a workspace-first model: `workspace` / `--workspace` are now the primary identity for runs, while `repo` / `--repo` remain compatibility aliases.
- Allow non-Git workspace directories and show Git only as an optional capability marker when detected.
- Add workspace filtering to CLI/API/Web: `input-kanban runs --workspace <path>` and `/api/runs?workspace=<path>` filter runs by workspace.
- Add a server-side background scheduler for `input-kanban serve` so unfinished runs continue to advance without relying on an open browser tab.
- Share auto-advance logic between CLI `submit --auto` / `input-kanban auto <runId>` and the Web server scheduler through the orchestrator.
- Make `/api/runs` lightweight by reading run summaries without refreshing every historical run, improving cold-start list loading.
- Simplify the Web sidebar: workspace filtering is a compact dropdown, the redundant list refresh button is removed, list load timing is available via a small hover icon, and Git is shown as a simple marker.

### Verification

- `npm run check` passed with 62 tests.
- `npm pack --dry-run` passed before publishing.

## v0.0.9

### Highlights

- Add MIT license and include it in the published npm package.
- Add agent-friendly `--json` output for discovery, status lookup, result reading, stop, submit, and auto commands.
- Add `runs` / `runs --active` to list visible and active run IDs before querying details.
- Add `retry <runId> [taskId]` with preserved failed attempts and a one-shot auto retry path for blocked batches.
- Add per-run `run_state.lock` protection around state writes to reduce CLI/Web/supervisor lost-update races.
- Keep Web auto mode enabled by default after planning: dispatch planned work and auto-start the final judge while the page is open.
- Keep CLI auto mode enabled by default for `submit`, with `--no-auto` as the create-and-plan-only escape hatch.
- Add `result --copy` for copying final judge output, and keep version display in both CLI and Web footer.

### Verification

- `npm run check` passed with 58 tests.
- `npm pack --dry-run` included the MIT `LICENSE` file.

## v0.0.8

### Highlights

- Add CLI `submit` workflow with two task input modes: `--task-file <markdown>` for Markdown files and `--task <text>` for inline task text.
- Add CLI auto loop as the default `submit` behavior to create a run, start planning, dispatch batches, and run the final judge while keeping the run visible in the shared Web dashboard.
- Add CLI `-d` / `--detach` to run the auto loop in a background supervisor, plus `--no-auto` for create-and-plan-only mode.
- Add CLI `status [runId] [--watch]`, defaulting to the latest run when `runId` is omitted.
- Add CLI `result [runId] [--copy]` to print or copy the final judge result.
- Add CLI `retry <runId> [taskId]` and automatic one-shot retry for blocked batches while preserving failed worker attempts.
- Add per-run `run_state.lock` protection around state writes to reduce CLI/Web/supervisor lost-update races.
- Add CLI `stop <runId>` and make backend stop robust across CLI/Web processes by falling back to stored live PIDs.
- Derive the run label from task text when `--label` / form label is omitted.
- Add dashboard run-card archive confirmation without modal popups and replace the detail refresh text chips with a one-shot circle animation.

### Verification

- `npm run check` passed with 58 tests.

## v0.0.7

### Highlights

- Improve the run list cards: replace `Run ID` with a repository chip and copy action, add frozen duration, and hide rename buttons until hover/focus.
- Streamline dashboard flow: creating a run now automatically starts planning, selecting a task opens its execution log by default, and running-task conflicts show Chinese user-facing messages.
- Improve task detail ergonomics: copy actions are available for both final replies and verdict JSON, and manual success completion stores pasted human evidence.
- Add execution timing artifacts and summary chips, including `events_timed.jsonl`, command duration breakdowns, model/scheduler time, startup/teardown time, and system event counts.
- Strengthen run creation validation by rejecting missing target paths and directories outside a Git work tree before planning starts.
- Keep release notes in a single repository-level `RELEASE_NOTES.md` and include that file in the npm package.

### Verification

- `npm run check` passed with 43 tests.
- `npm pack --dry-run` passed before publishing.

## v0.0.6

### Changes

- Validate the target repository when creating a run, rejecting missing paths and directories outside a Git work tree before planning starts.
- Add a compact copy button for the full repository path in the run detail header.
- Document the Git work tree requirement in the README, English README, environment reference, and project guide.

### Verification

- `npm run check` passed with 38 tests.
- `npm pack --dry-run` confirmed package contents before the version bump.

## v0.0.5

### Highlights

- Add Input Kanban branding icons to the dashboard header and browser tab.
- Add standard favicon and Apple touch icon assets so browsers can show the same visual identity as the page header.
- Align left run-list metadata with the compact chip style used in run details.
- Align batch-row metadata in the task table with the same chip style for `Batch ID`, `最大并发`, and `进度`.

### Notes

- This is a UI polish release after `v0.0.4`.
- No runner, scheduler, tmux, sandbox, or Codex execution behavior changes are included.

### Verification

- `npm run check` passed.
- `npm pack --dry-run` passed.

## v0.0.4

### Highlights

- Add tmux batch layout: one session per run, windows for planner, each batch, and judge, with batch windows showing an overview pane plus worker panes.
- Show formatted Codex execution output in tmux panes while keeping raw JSONL logs in `events.jsonl`.
- Add worker sandbox selection in the create form, including explicit `danger-full-access` for controlled test repositories.
- Refine the dashboard UI with compact run metadata chips, no redundant tmux badges, no file-viewer tmux panel, and role-specific file tabs.
- Freeze run duration after terminal states such as final judge completion, instead of continuing to count on auto-refresh.

### Notes

- `codex exec` is treated as non-interactive; tmux mode provides live terminal visibility but does not implement manual approval prompts.
- The dashboard exposes the run-level `tmux attach-session` copy action after tmux metadata is available.
- Use `danger-full-access` only when you explicitly want to relax worker sandbox limits in a controlled environment.

### Verification

- `npm run check` passed.
