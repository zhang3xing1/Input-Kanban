# Environment Variables

This file documents the runtime environment variables supported by Input Kanban. It is intended for local deployment and runtime configuration, not as the main implementation guide for agents.

CLI options take precedence over environment variables. Environment variables take precedence over defaults.

## Variables

- `PORT`: HTTP server port. Default: `8787`. CLI option: `--port`.
- `HOST`: HTTP bind host. Default: `127.0.0.1`. CLI option: `--host`.
- `KANBAN_DEFAULT_WORKSPACE`: Default workspace path for new runs. Default: the current working directory when `input-kanban` is launched. CLI option: `--workspace`. `KANBAN_DEFAULT_REPO` remains as a compatibility alias. Creating a run only requires this path to exist and be a directory; Git is detected and marked when available.
- `KANBAN_RUNS_DIR`: Directory for run state, logs, and artifacts. Default: `.input-kanban/runs` under the user's home directory. CLI option: `--runs-dir`.
- `KANBAN_CODEX_BIN`: Codex CLI executable name or path. Default: `codex`. CLI option: `--codex-bin`.
- `KANBAN_PI_BIN`: Pi Coding Agent CLI executable name or path used for command availability monitoring. Default: `pi`. This is detection-only in the current release; Input Kanban still executes tasks through Codex.
- `KANBAN_CONFIG_PATH`: Local Input Kanban config path. Default: `~/.input-kanban/config.json`.
- `KANBAN_RUNNER`: Runner mode. Supported values: `headless`, `tmux`. CLI option: `--runner`. When set, it overrides the local config default runner.
- `KANBAN_AUTO_POLL_MS`: Poll interval for the Web server background scheduler. Default: `3000`.
- `KANBAN_AUTO_MAX_RETRIES`: Maximum automatic retries for recoverable failed/unknown tasks in the scheduler. Default: `1`.
- `KANBAN_PI_CHECK_LATEST`: Set to `1` to let `/api/pi` also query npm for the latest `@earendil-works/pi-coding-agent` version. Default: disabled, so detection only runs `pi --version`.

## Environment Example

```bash
PORT=8787 \
KANBAN_DEFAULT_WORKSPACE=/path/to/workspace \
KANBAN_RUNS_DIR=/path/to/kanban-runs \
KANBAN_CODEX_BIN=codex \
KANBAN_PI_BIN=pi \
KANBAN_RUNNER=headless \
input-kanban
```

## Equivalent CLI Example

```bash
input-kanban \
  --port 8787 \
  --workspace /path/to/workspace \
  --runs-dir /path/to/kanban-runs \
  --codex-bin codex \
  --runner headless
```

## Notes

- `KANBAN_DEFAULT_WORKSPACE` / `--workspace` should point to the local directory where work should run; `KANBAN_DEFAULT_REPO` / `--repo` remain compatibility aliases.
- Without `KANBAN_RUNNER`, the default runner is read from `~/.input-kanban/config.json`; if no config exists, it falls back to `headless`.
- `input-kanban serve` starts a lightweight background scheduler that uses the same orchestrator auto-advance path as CLI `submit --auto` / `input-kanban auto <runId>`. It advances planned runs, serial batches, final judge startup, and bounded automatic retries without relying on an open browser tab. If a run was created with `--plan-approval` / plan approval gate enabled, the scheduler stops after planning until the user confirms the plan.
- `KANBAN_RUNNER` / `--runner tmux` runs Codex tasks inside tmux windows while keeping scheduling and status tracking in the Node.js orchestrator.
- `KANBAN_RUNNER=tmux` is optional. Use it when you want live terminal visibility into planner, worker, and final judge sessions.
- The Web create form can choose `headless`, `tmux`, or follow the configured default runner for each run.
- The Web UI checks tmux availability before creating a tmux run. If tmux is missing, creation is blocked and the UI offers the CLI command `input-kanban deps install tmux`; the Web server does not run package-manager commands.
- `input-kanban deps install tmux` chooses a platform install plan and requires explicit terminal confirmation unless `--yes` is passed. `--dry-run` prints the plan without installing.
- With `KANBAN_RUNNER=tmux`, stopping and restarting `input-kanban serve` does not interrupt already-running Codex sessions; tmux keeps them alive and the scheduler resumes after restart. Do not assume the same safety for `headless` runner child processes.
- tmux mode uses one session per run and one window for planner, each batch, and judge. Batch windows contain an overview pane plus worker panes.
- tmux role windows stay open after the Codex command exits. The runner writes `exit_code` before entering the keep-open shell so Node.js status refresh can continue to advance from filesystem state.
- The dashboard exposes the run-level `tmux attach-session` copy action after tmux metadata is available. File viewer panels do not repeat tmux terminal details.
- `codex exec` is non-interactive in current supported usage. tmux mode does not implement automatic approval and does not turn `codex exec` into an approval UI.
- `/api/pi` and the Web footer can detect whether the `pi` command is visible to the backend process. This is preparatory monitoring only; task execution remains Codex-backed until a future agent backend is implemented.
- The runtime runs directory contains task text, logs, model output, artifacts, and possible audit information. It should not be committed to git.
- Avoid writing machine-specific absolute paths into public or shared documentation.
