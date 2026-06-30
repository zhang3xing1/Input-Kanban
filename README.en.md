# Input Kanban

[中文](README.md) | English

Sponsored by <a href="https://ai.input.im"><img src="public/assets/ai-input-logo.png" alt="AI.INPUT.IM" width="18" align="absmiddle" /></a> [AI.INPUT.IM](https://ai.input.im) — one API for all models, an AI API gateway built for developers.

You can think of Input Kanban as a local Codex execution board: you create a task, and it helps you plan, dispatch, run, and judge it. This README focuses on **how to use it**.

## Fast Start

### 1. Install

```bash
npm install -g input-kanban
```

Verify it works:

```bash
input-kanban --help
```

### 2. Start inside your target workspace

Run it in the directory you want Codex to modify or inspect:

```bash
cd /path/to/your/workspace
input-kanban
```

By default, it starts a local web server at:

```text
http://127.0.0.1:8787
```

Open that URL in your browser to create runs, watch progress, and read results.

### 3. Start without `cd`

If you do not want to change directories first, pass the workspace explicitly:

```bash
input-kanban --workspace /path/to/your/workspace
```

`--repo` is still supported as a compatibility alias.

## The 6 Most Common Ways to Use It

### 1) Create and run a task in the Web UI

1. Click `New Run`
2. Enter the workspace, worker sandbox, and task description
3. `Skip Codex Git/trust directory check` is enabled by default; disable it when the workspace is not a trusted umbrella / non-Git root
4. Click `Create Run`
5. The dashboard automatically starts planning
6. After planning, it dispatches workers
7. After all batches finish, it starts the final judge

### 2) Submit a task from the terminal

```bash
input-kanban submit --task "Fix the login issue and add regression tests" --label "fix-login"
```

To load task text from a file:

```bash
input-kanban submit --task-file task.md
```

For a trusted umbrella / non-Git workspace, explicitly pass the Codex bypass:

```bash
input-kanban submit --task-file task.md --codex-skip-git-repo-check
```

### 3) Pause after planning for approval

```bash
input-kanban submit --task-file task.md --plan-approval
```

This pauses after planning and waits for you to confirm the plan in the Web UI before dispatching workers.

### 4) Create and plan only

```bash
input-kanban submit --task-file task.md --no-auto
```

### 5) Check progress, result, retry, or stop

```bash
input-kanban status <runId>
input-kanban status <runId> --watch
input-kanban result <runId>
input-kanban result <runId> --copy
input-kanban retry <runId> [taskId]
input-kanban stop <runId>
```

## Agent and Handoff Workflow

### CLI-only Agents

If you are an Agent and can only call the CLI, run:

```bash
input-kanban guide
```

Or:

```bash
input-kanban --help
```

`guide` prints an agent-friendly control loop and ready-to-copy templates.

### Install the `input-kanban-prepare` Skill

To install the bundled `input-kanban-prepare` skill for Codex:

```bash
input-kanban install-skill codex
```

This skill turns an external Agent conversation into an execution-ready `task.md` for Input Kanban: it helps fill in `Goal`, `Acceptance Criteria`, `Expected Artifacts`, `Context References`, and `Risks`, and can suggest batches or parallelism when needed. It does not execute the task or decide final acceptance.

To specify the Codex skills root explicitly:

```bash
input-kanban install-skill codex --target-dir ~/.codex/skills
```

### Hand Off from an External Agent Conversation

If the task was first discussed in Claude, Cursor, Codex, or another external Agent conversation, prepare a structured `task.md` before handing it to Input Kanban. Prefer saving drafts under `.tmp/input-kanban/` with a `YYYYMMDD-HHmm-<short-slug>-task.md` filename so handoffs sort chronologically and do not overwrite each other:

```text
.tmp/input-kanban/20260601-1909-p0-precompute-input-copy-boundary-task.md
```

```bash
input-kanban submit --task-file task.md --plan-approval
```

A good `task.md` should include at least:

- `Goal`: what should be completed
- `Acceptance Criteria`: how completion will be checked
- `Expected Artifacts`: expected outputs and verification methods
- `Context References`: relevant files, specs, or prior notes
- `Risks`: assumptions, risks, and unknowns

See `skills/input-kanban-prepare/SKILL.md` or `docs/input-kanban-prepare.md` for a reusable preparation flow. This gives the planner a stronger execution contract instead of asking it to infer everything from a vague request.

## Quick Command Cheat Sheet

```bash
input-kanban submit --task "..."
input-kanban submit --task-file task.md
input-kanban submit --task-file task.md --plan-approval
input-kanban submit --task-file task.md -d
input-kanban install-skill codex
input-kanban deps tmux
input-kanban --json runs --active
input-kanban --json status <runId>
input-kanban --json result <runId>
input-kanban --json retry <runId> [taskId]
input-kanban --json stop <runId>
```

Use `--json` when another tool or script needs structured output.

## tmux Mode (Optional)

The default runner is `headless`. If you want live terminal visibility for each role, switch to `tmux`:

```bash
input-kanban submit --task-file task.md --runner tmux
```

Use tmux mode when you want to:

- watch planner / worker / judge output live
- see the overview pane and worker panes in each batch window
- inspect the run process locally

If you do not need terminal visibility, keep using the default `headless` runner.

When creating a run in the Web UI, you can also choose a runner:

- `Follow default`: use the local default runner
- `headless`: force this run to use headless mode
- `tmux`: force this run to use tmux mode

The default runner is stored in the local config file `~/.input-kanban/config.json` and is shared by the CLI and Web UI. If `KANBAN_RUNNER` is set, the environment variable takes precedence.

If you choose `tmux` in the Web UI but tmux is not detected, run creation is blocked and an install command is shown. The Web UI does not install system dependencies directly; run the command explicitly in a terminal:

```bash
input-kanban deps install tmux
```

The installer plan chooses a common package manager for the platform, such as winget/psmux on Windows, Homebrew on macOS, or apt/dnf/pacman/zypper/apk on Linux. On Windows, psmux is a third-party tmux-compatible implementation, not official tmux. You can also install another implementation manually as long as a working `tmux` command is available. The install path shows the command and requires confirmation before running; you can preview it first:

```bash
input-kanban deps install tmux --dry-run
```

## Runtime Data Location

Runtime data is stored in the default runs directory:

```text
~/.input-kanban/runs
```

Each run roughly looks like this:

```text
runs/<runId>/
├── task.md
├── plan.json
├── run_state.json
├── planner/
├── workers/<taskId>/
└── judge/
    ├── judge_input.json
    └── verdict.json
```

These files are local run records and do not need to be committed to your application workspace.

## What You Usually Do with It

- Split a larger Codex task into multiple execution steps
- Watch planning, execution, and results in the Web UI
- Automate submit / status / retry / result / stop flows from the terminal
- Add a human approval gate with `--plan-approval` when needed
- Use tmux only when you want live terminal inspection

## Requirements

- Node.js 20 or newer
- Codex CLI installed and available
- `tmux` installed if you want `--runner tmux`
- Use `input-kanban deps tmux` to check tmux status
- The `codex` command works in your terminal, or `--codex-bin` points to the executable

## Maintainer Development

If you want to develop Input Kanban itself:

```bash
git clone https://github.com/zhang3xing1/Input-Kanban.git
cd Input-Kanban
npm install
npm start
```

For local CLI development:

```bash
npm link
input-kanban --help
```

Run checks:

```bash
npm run check
```

## More Documentation

- [Project guide](docs/PROJECT_GUIDE.md)
- [Environment variables](ENVIRONMENT.md)
- [Agent CLI README](docs/input-kanban-cli-README.md)
- [Agent CLI Skill draft](docs/input-kanban-cli-skill.md)
- [Structured handoff guide](docs/input-kanban-prepare.md)
- [input-kanban-prepare Skill](skills/input-kanban-prepare/SKILL.md)
