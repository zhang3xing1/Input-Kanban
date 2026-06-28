#!/usr/bin/env node
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { isActiveRunSummaryStatus, isFailureRunStatus, isTerminalRunStatus } from '../src/status.js';

const PACKAGE_VERSION = JSON.parse(await fsp.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const VALID_RUNNERS = ['headless', 'tmux'];
const VALID_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
const COMMANDS = new Set(['serve', 'submit', 'runs', 'status', 'result', 'retry', 'stop', 'auto', 'guide', 'install-skill', 'deps']);
const BUNDLED_CODEX_SKILLS = ['input-kanban-prepare', 'input-kanban-execute'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const STATUS_TEXT = {
  created: '已创建', planning: '拆分中', plan_failed: '拆分失败', plan_empty: '拆分为空', planned: '已拆分',
  running: '执行中', batch_blocked: '批次阻塞', batches_completed: '批次完成', judging: '验收中', judged: '已验收',
  judge_failed: '验收失败', stopped: '已停止', load_failed: '加载失败'
};

function validateChoice(value, source, choices) {
  if (choices.includes(value)) return value;
  throw new Error(`invalid ${source}: ${value}; expected one of: ${choices.join(', ')}`);
}

function validateRunner(value, source) {
  return validateChoice(value, source, VALID_RUNNERS);
}

function validateSandbox(value, source) {
  return validateChoice(value, source, VALID_SANDBOXES);
}

function splitCommand(argv) {
  let index = 0;
  const globals = { json: false };
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === '--json' || arg === '-j') { globals.json = true; index++; continue; }
    break;
  }
  const rest = argv.slice(index);
  if (rest[0] === '--version' || rest[0] === '-v' || rest[0] === 'version') return { command: 'version', rest: rest.slice(1), globals };
  if (rest[0] && COMMANDS.has(rest[0])) return { command: rest[0], rest: rest.slice(1), globals };
  return { command: 'serve', rest, globals };
}

function parseServeArgs(argv) {
  const args = { host: '127.0.0.1', port: undefined, workspace: undefined, repo: undefined, runsDir: undefined, codexBin: undefined, runner: undefined, open: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json' || arg === '-j') args.json = true;
    else if (arg === '--open') args.open = true;
    else if (arg === '--no-open') args.open = false;
    else if (arg === '--host') args.host = next();
    else if (arg === '--port' || arg === '-p') args.port = Number(next());
    else if (arg === '--workspace') args.workspace = next();
    else if (arg === '--repo' || arg === '-r') args.repo = next();
    else if (arg === '--runs-dir') args.runsDir = next();
    else if (arg === '--codex-bin') args.codexBin = next();
    else if (arg === '--runner') args.runner = validateRunner(next(), '--runner');
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function parseRunsArgs(argv) {
  const args = { runsDir: undefined, workspace: undefined, repo: undefined, active: false, includeArchived: false, limit: 20, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json' || arg === '-j') args.json = true;
    else if (arg === '--runs-dir') args.runsDir = next();
    else if (arg === '--workspace') args.workspace = next();
    else if (arg === '--repo' || arg === '-r') args.repo = next();
    else if (arg === '--active') args.active = true;
    else if (arg === '--include-archived') args.includeArchived = true;
    else if (arg === '--limit') args.limit = Number(next());
    else throw new Error(`unknown runs argument: ${arg}`);
  }
  return args;
}

function parseStatusArgs(argv) {
  const args = { host: '127.0.0.1', port: 8787, runsDir: undefined, runId: undefined, watch: false, json: false, pollMs: 3000, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json' || arg === '-j') args.json = true;
    else if (arg === '--host') args.host = next();
    else if (arg === '--port' || arg === '-p') args.port = Number(next());
    else if (arg === '--runs-dir') args.runsDir = next();
    else if (arg === '--watch') args.watch = true;
    else if (arg === '--poll-ms') args.pollMs = Number(next());
    else if (!arg.startsWith('-') && !args.runId) args.runId = arg;
    else throw new Error(`unknown status argument: ${arg}`);
  }
  return args;
}

function parseResultArgs(argv) {
  const args = { runsDir: undefined, runId: undefined, copy: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json' || arg === '-j') args.json = true;
    else if (arg === '--runs-dir') args.runsDir = next();
    else if (arg === '--copy') args.copy = true;
    else if (!arg.startsWith('-') && !args.runId) args.runId = arg;
    else throw new Error(`unknown result argument: ${arg}`);
  }
  return args;
}

function parseRetryArgs(argv) {
  const args = { runsDir: undefined, runId: undefined, taskId: undefined, reason: 'manual retry from CLI', maxRetries: 1, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json' || arg === '-j') args.json = true;
    else if (arg === '--runs-dir') args.runsDir = next();
    else if (arg === '--reason') args.reason = next();
    else if (arg === '--max-retries') args.maxRetries = Number(next());
    else if (!arg.startsWith('-') && !args.runId) args.runId = arg;
    else if (!arg.startsWith('-') && !args.taskId) args.taskId = arg;
    else throw new Error(`unknown retry argument: ${arg}`);
  }
  return args;
}

function parseStopArgs(argv) {
  const args = { runsDir: undefined, runId: undefined, reason: 'stopped from CLI', json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json' || arg === '-j') args.json = true;
    else if (arg === '--runs-dir') args.runsDir = next();
    else if (arg === '--reason') args.reason = next();
    else if (!arg.startsWith('-') && !args.runId) args.runId = arg;
    else throw new Error(`unknown stop argument: ${arg}`);
  }
  return args;
}

function parseAutoArgs(argv) {
  const args = { host: '127.0.0.1', port: 8787, workspace: undefined, runsDir: undefined, codexBin: undefined, runner: undefined, runId: undefined, json: false, pollMs: 3000, maxRetries: 1, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json' || arg === '-j') args.json = true;
    else if (arg === '--host') args.host = next();
    else if (arg === '--port' || arg === '-p') args.port = Number(next());
    else if (arg === '--workspace') args.workspace = next();
    else if (arg === '--runs-dir') args.runsDir = next();
    else if (arg === '--codex-bin') args.codexBin = next();
    else if (arg === '--runner') args.runner = validateRunner(next(), '--runner');
    else if (arg === '--poll-ms') args.pollMs = Number(next());
    else if (arg === '--max-retries') args.maxRetries = Number(next());
    else if (!arg.startsWith('-') && !args.runId) args.runId = arg;
    else throw new Error(`unknown auto argument: ${arg}`);
  }
  return args;
}

function parseGuideArgs(argv) {
  const args = { json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json' || arg === '-j') args.json = true;
    else throw new Error(`unknown guide argument: ${arg}`);
  }
  return args;
}

function parseInstallSkillArgs(argv) {
  const args = { provider: undefined, targetDir: undefined, force: false, dryRun: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json' || arg === '-j') args.json = true;
    else if (arg === '--target-dir') args.targetDir = next();
    else if (arg === '--force') args.force = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (!arg.startsWith('-') && !args.provider) args.provider = arg;
    else throw new Error(`unknown install-skill argument: ${arg}`);
  }
  return args;
}

function parseDepsArgs(argv) {
  const args = { action: 'status', dependency: undefined, yes: false, dryRun: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json' || arg === '-j') args.json = true;
    else if (arg === '--yes' || arg === '-y') args.yes = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === 'install' && args.action === 'status') args.action = 'install';
    else if (!arg.startsWith('-') && !args.dependency) args.dependency = arg;
    else throw new Error(`unknown deps argument: ${arg}`);
  }
  args.dependency = args.dependency || 'tmux';
  if (args.dependency !== 'tmux') throw new Error(`unsupported dependency: ${args.dependency}; expected tmux`);
  return args;
}

function parseSubmitArgs(argv) {
  const args = {
    host: '127.0.0.1', port: 8787, workspace: undefined, repo: undefined, runsDir: undefined, codexBin: undefined,
    runner: undefined, label: undefined, taskText: undefined, taskFile: undefined, maxParallel: 3,
    workerSandbox: 'workspace-write', workerBackend: undefined, codexSkipGitRepoCheck: false, planApproval: false, auto: true, detach: false, watch: true, json: false, pollMs: 3000, maxRetries: 1, help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json' || arg === '-j') args.json = true;
    else if (arg === '--host') args.host = next();
    else if (arg === '--port' || arg === '-p') args.port = Number(next());
    else if (arg === '--workspace') args.workspace = next();
    else if (arg === '--repo' || arg === '-r') args.repo = next();
    else if (arg === '--runs-dir') args.runsDir = next();
    else if (arg === '--codex-bin') args.codexBin = next();
    else if (arg === '--runner') args.runner = validateRunner(next(), '--runner');
    else if (arg === '--label' || arg === '-l') args.label = next();
    else if (arg === '--task') args.taskText = next();
    else if (arg === '--task-file') args.taskFile = next();
    else if (arg === '--max-parallel') args.maxParallel = Number(next());
    else if (arg === '--worker-sandbox') args.workerSandbox = validateSandbox(next(), '--worker-sandbox');
    else if (arg === '--worker-backend') args.workerBackend = validateChoice(next(), '--worker-backend', ['codex', 'pi']);
    else if (arg === '--codex-skip-git-repo-check') args.codexSkipGitRepoCheck = true;
    else if (arg === '--plan-approval') args.planApproval = true;
    else if (arg === '--auto') { args.auto = true; args.watch = true; }
    else if (arg === '--no-auto') { args.auto = false; args.watch = false; }
    else if (arg === '--detach' || arg === '-d') args.detach = true;
    else if (arg === '--watch') args.watch = true;
    else if (arg === '--poll-ms') args.pollMs = Number(next());
    else if (arg === '--max-retries') args.maxRetries = Number(next());
    else throw new Error(`unknown submit argument: ${arg}`);
  }
  return args;
}

function applyRuntimeEnv(args) {
  if (args.port) process.env.PORT = String(args.port);
  if (args.host) process.env.HOST = args.host;
  const workspace = args.workspace || args.repo;
  if (workspace) {
    const resolvedWorkspace = path.resolve(workspace);
    process.env.KANBAN_DEFAULT_WORKSPACE = resolvedWorkspace;
    process.env.KANBAN_DEFAULT_REPO = resolvedWorkspace;
  } else {
    if (!process.env.KANBAN_DEFAULT_WORKSPACE) process.env.KANBAN_DEFAULT_WORKSPACE = process.env.KANBAN_DEFAULT_REPO || process.cwd();
    if (!process.env.KANBAN_DEFAULT_REPO) process.env.KANBAN_DEFAULT_REPO = process.env.KANBAN_DEFAULT_WORKSPACE || process.cwd();
  }
  if (args.runsDir) process.env.KANBAN_RUNS_DIR = path.resolve(args.runsDir);
  if (args.codexBin) process.env.KANBAN_CODEX_BIN = args.codexBin;
}

function applyRunnerEnv(args) {
  if (args.runner) process.env.KANBAN_RUNNER = args.runner;
  if (args.workerBackend) process.env.KANBAN_WORKER_BACKEND = args.workerBackend;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printVersion() {
  console.log(`input-kanban v${PACKAGE_VERSION}`);
}

function printHelp() {
  console.log(`input-kanban v${PACKAGE_VERSION}

Usage:
  input-kanban [options]
  input-kanban serve [options]
  input-kanban submit [options]
  input-kanban guide [options]
  input-kanban install-skill codex [options]
  input-kanban deps [install] tmux [options]
  input-kanban --version
  input-kanban runs [options]
  input-kanban status [runId] [options]
  input-kanban result [runId] [options]
  input-kanban retry <runId> [taskId] [options]
  input-kanban stop <runId> [options]

Agent guide:
  input-kanban guide           Print a friendly agent-oriented control loop and templates
  input-kanban install-skill codex
                               Install bundled input-kanban skills for Codex

Serve options:
  --host <host>              Host to bind, default 127.0.0.1
  -p, --port <port>          Port to bind, default 8787
  --workspace <path>         Default workspace, default current directory
  -r, --repo <path>          Alias for --workspace
  --runs-dir <path>          Runtime runs directory, default ~/.input-kanban/runs
  --codex-bin <path>         Codex CLI executable, default codex
  --runner <mode>            Runner mode: headless or tmux, default headless
  -j, --json                 Emit JSON startup output
  -v, --version              Print version and exit
  --open                     Open browser after starting
  --no-open                  Do not open browser, default

Runs options:
  --runs-dir <path>          Runtime runs directory shared with the Web UI
  --active                   Show only active or pending-action runs
  --include-archived         Include archived runs
  --limit <n>                Maximum rows to print, default 20
  -j, --json                 Emit JSON output instead of human text

Status options:
  --runs-dir <path>          Runtime runs directory shared with the Web UI
  --watch                    Keep printing status until the run reaches a terminal state
  --poll-ms <ms>             Watch poll interval, default 3000
  -j, --json                 Emit JSON output instead of human text

Result options:
  --runs-dir <path>          Runtime runs directory shared with the Web UI
  --copy                     Copy final result to clipboard
  -j, --json                 Emit JSON output instead of human text

Retry options:
  --runs-dir <path>          Runtime runs directory shared with the Web UI
  --reason <text>            Retry reason stored in task retry history
  --max-retries <n>          Retry limit for automatic retry policy, default 1
  -j, --json                 Emit JSON output instead of human text

Stop options:
  --runs-dir <path>          Runtime runs directory shared with the Web UI
  --reason <text>            Stop reason stored in run state
  -j, --json                 Emit JSON output instead of human text

Install skill options:
  --target-dir <path>        Codex skills root, default $CODEX_SKILLS_DIR or ~/.codex/skills
  --dry-run                  Print the planned install target without copying files
  --force                    Replace an existing installed skill directory
  -j, --json                 Emit JSON output instead of human text

Deps options:
  input-kanban deps tmux
  input-kanban deps install tmux --dry-run
  input-kanban deps install tmux --yes
  --dry-run                  Print the platform install plan without running it
  -y, --yes                  Confirm and run the install command
  -j, --json                 Emit JSON output instead of human text

Submit options:
  --workspace <path>         Target workspace, default current directory
  -r, --repo <path>          Alias for --workspace
  -l, --label <label>        Task batch name, default generated from task text
  --task <text>              Task description text
  --task-file <path>         Read task description from file, use - for stdin
  --max-parallel <n>         Default max parallel workers, default 3
  --worker-sandbox <mode>    read-only, workspace-write, or danger-full-access
  --worker-backend <backend> codex or pi; default codex
  --codex-skip-git-repo-check
                               Pass --skip-git-repo-check to Codex exec for umbrella/non-Git workspaces
  --plan-approval            Pause after planning until the generated plan is confirmed
  --runner <mode>            Runner mode: headless or tmux
  --runs-dir <path>          Runtime runs directory shared with the Web UI
  --auto                     Plan, dispatch all batches, judge, and watch, default for submit
  --no-auto                  Only create the run and start planning
  -d, --detach               Run the default auto loop in a background supervisor
  --watch                    Watch status after starting the planner
  --poll-ms <ms>             Watch poll interval, default 3000
  -j, --json                 Emit JSON output instead of human text
  -h, --help                 Show help
`);
}

function printSubmitHelp() {
  console.log(`input-kanban submit

Usage:
  input-kanban submit --workspace <path> --task-file task.md
  input-kanban submit --workspace <path> --task "fix the bug" --label "bugfix"
  input-kanban submit --task-file task.md -d

Options:
  --workspace <path>         Target workspace, default current directory
  -r, --repo <path>          Alias for --workspace
  -l, --label <label>        Task batch name, default generated from task text
  --task <text>              Task description text
  --task-file <path>         Read task description from file, use - for stdin
  --max-parallel <n>         Default max parallel workers, default 3
  --worker-sandbox <mode>    read-only, workspace-write, or danger-full-access
  --worker-backend <backend> codex or pi; default codex
  --codex-skip-git-repo-check
                               Pass --skip-git-repo-check to Codex exec for umbrella/non-Git workspaces
  --plan-approval            Pause after planning until the generated plan is confirmed
  --runner <mode>            Runner mode: headless or tmux
  --runs-dir <path>          Runtime runs directory shared with the Web UI
  --auto                     Plan, dispatch all batches, judge, and watch, default for submit
  --no-auto                  Only create the run and start planning
  -d, --detach               Run the default auto loop in a background supervisor
  --watch                    Watch status after starting the planner
  --poll-ms <ms>             Watch poll interval, default 3000
`);
}

function printRunsHelp() {
  console.log(`input-kanban runs

Usage:
  input-kanban runs
  input-kanban runs --workspace <path>
  input-kanban runs --active
  input-kanban --json runs --active

Options:
  --runs-dir <path>          Runtime runs directory shared with the Web UI
  --workspace <path>         Filter by workspace path
  -r, --repo <path>          Alias for --workspace
  --active                   Show only active or pending-action runs
  --include-archived         Include archived runs
  --limit <n>                Maximum rows to print, default 20
  -j, --json                 Emit JSON output instead of human text
`);
}

function printStatusHelp() {
  console.log(`input-kanban status

Usage:
  input-kanban status
  input-kanban status <runId>
  input-kanban status --watch
  input-kanban status <runId> --watch

Options:
  --runs-dir <path>          Runtime runs directory shared with the Web UI
  --watch                    Keep printing status until the run reaches a terminal state
  --poll-ms <ms>             Watch poll interval, default 3000
  -j, --json                 Emit JSON output instead of human text
`);
}

function printResultHelp() {
  console.log(`input-kanban result

Usage:
  input-kanban result
  input-kanban result <runId>
  input-kanban result <runId> --copy

Options:
  --runs-dir <path>          Runtime runs directory shared with the Web UI
  --copy                     Copy final result to clipboard
  -j, --json                 Emit JSON output instead of human text
`);
}

function printRetryHelp() {
  console.log(`input-kanban retry

Usage:
  input-kanban retry <runId>
  input-kanban retry <runId> <taskId>
  input-kanban --json retry <runId> <taskId>

Options:
  --runs-dir <path>          Runtime runs directory shared with the Web UI
  --reason <text>            Retry reason stored in task retry history
  --max-retries <n>          Retry limit for automatic retry policy, default 1
  -j, --json                 Emit JSON output instead of human text
`);
}

function printStopHelp() {
  console.log(`input-kanban stop

Usage:
  input-kanban stop <runId>

Options:
  --runs-dir <path>          Runtime runs directory shared with the Web UI
  --reason <text>            Stop reason stored in run state
  -j, --json                 Emit JSON output instead of human text
`);
}

function printAutoHelp() {
  console.log(`input-kanban auto

Usage:
  input-kanban auto <runId>

Options:
  --runs-dir <path>          Runtime runs directory shared with the Web UI
  --codex-bin <path>         Codex CLI executable, default codex
  --runner <mode>            Runner mode: headless or tmux
  --poll-ms <ms>             Watch poll interval, default 3000
  -j, --json                 Emit JSON output instead of human text
`);
}

function printInstallSkillHelp() {
  console.log(`input-kanban install-skill

Usage:
  input-kanban install-skill codex
  input-kanban install-skill codex --target-dir ~/.codex/skills
  input-kanban install-skill codex --dry-run
  input-kanban --json install-skill codex

Options:
  --target-dir <path>        Codex skills root, default $CODEX_SKILLS_DIR or ~/.codex/skills
  --dry-run                  Print the planned install target without copying files
  --force                    Replace an existing installed skill directory
  -j, --json                 Emit JSON output instead of human text
`);
}

function printDepsHelp() {
  console.log(`input-kanban deps

Usage:
  input-kanban deps tmux
  input-kanban deps install tmux
  input-kanban deps install tmux --dry-run
  input-kanban deps install tmux --yes

Options:
  --dry-run                  Print the platform install plan without running it
  -y, --yes                  Confirm and run the install command
  -j, --json                 Emit JSON output instead of human text
`);
}

function printAgentGuide(json = false) {
  const preferredTaskFilePattern = '.tmp/input-kanban/YYYYMMDD-HHmm-<short-slug>-task.md';
  const preferredTaskFileExample = '.tmp/input-kanban/20260601-1909-p0-precompute-input-copy-boundary-task.md';
  const quickStart = [
    'Use `input-kanban` as the execution tool.',
    'Treat `submit` as a new task identity.',
    'Treat `retry` as a new attempt for the same task.',
    'If the task came from an external chat, prepare a structured task draft first.',
    `Prefer task draft paths like \`${preferredTaskFilePattern}\`.`,
    'Use `--codex-skip-git-repo-check` only for trusted umbrella / non-Git workspaces.',
    'Use `status` before any state-dependent action.',
    'Use `result` for the final outcome.',
    'Use `stop` only with a known `runId`.'
  ];
  const templates = [
    'input-kanban submit --task "Implement the new gate workflow" --label "gate-workflow"',
    `input-kanban submit --task-file ${preferredTaskFileExample}`,
    `input-kanban submit --task-file ${preferredTaskFileExample} --plan-approval`,
    'input-kanban submit --task-file task.md --codex-skip-git-repo-check',
    'input-kanban submit --task-file task.md --detach',
    'input-kanban status run_1234567890',
    'input-kanban status run_1234567890 --watch',
    'input-kanban result run_1234567890',
    'input-kanban result run_1234567890 --copy',
    'input-kanban retry run_1234567890',
    'input-kanban stop run_1234567890'
  ];
  if (json) {
    printJson({
      ok: true,
      command: 'guide',
      title: 'Input Kanban Agent Guide',
      quickStart,
      templates,
      preferredTaskFilePattern,
      preferredTaskFileExample,
      handoffSections: ['Goal', 'Acceptance Criteria', 'Expected Artifacts', 'Context References', 'Risks'],
      skillInstall: 'input-kanban install-skill codex',
      rules: [
        'submit = new task identity',
        'retry = same task definition, new attempt',
        'status = inspect before acting',
        'result = final confirmation',
        'stop = only with explicit runId'
      ]
    });
    return;
  }
  console.log(`Input Kanban Agent Guide

Quick start:
${quickStart.map(item => `  - ${item}`).join('\n')}

Core commands:
  submit   Create a new run for a new task identity
  retry    Re-attempt the same task definition with a new attempt
  status   Inspect current progress before acting
  result   Read the final outcome
  stop     Halt a known run

Preparation before submit:
  - Goal
  - Acceptance Criteria
  - Expected Artifacts
  - Context References
  - Risks

Recommended task draft path:
  ${preferredTaskFilePattern}
  Example: ${preferredTaskFileExample}

Install bundled Codex skills:
  input-kanban install-skill codex
  Installs: input-kanban-prepare, input-kanban-execute

Example templates:
${templates.map((item, index) => `  ${String(index + 1).padStart(2, '0')}. ${item}`).join('\n')}

See also:
  input-kanban --help
`);
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.unref();
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function readTaskText(args) {
  if (args.taskText !== undefined) return args.taskText;
  if (args.taskFile === '-') return await readStdin();
  if (args.taskFile) return await fsp.readFile(path.resolve(args.taskFile), 'utf8');
  throw new Error('submit requires --task or --task-file');
}

function baseUrl(args) {
  return `http://${args.host || '127.0.0.1'}:${Number(args.port || 8787)}`;
}

function webUrl(args, runId = '') {
  return `${baseUrl(args)}${runId ? `  (runId: ${runId})` : ''}`;
}

function displayStatus(status) {
  const text = STATUS_TEXT[status] || status || '-';
  return status && text !== status ? `${text}(${status})` : text;
}

function countByStatus(state) {
  const tasks = state.tasks || [];
  return {
    total: tasks.length,
    completed: tasks.filter(task => task.status === 'completed').length,
    running: tasks.filter(task => task.status === 'running').length,
    failed: tasks.filter(task => ['failed', 'unknown'].includes(task.status)).length
  };
}

function currentBatchText(state) {
  const batch = (state.batches || []).find(item => item.status !== 'completed');
  if (!batch) return '-';
  const tasks = batch.tasks || [];
  const completed = tasks.filter(task => task.status === 'completed').length;
  return `${batch.name || batch.id}(${batch.id}) ${displayStatus(batch.status)} ${completed}/${tasks.length}`;
}

function statusLine(state) {
  const counts = countByStatus(state);
  return `${state.label || state.runId}｜${state.runId}｜状态 ${displayStatus(state.status)}｜进度 ${counts.completed}/${counts.total}｜执行中 ${counts.running}｜失败 ${counts.failed}`;
}

function printRunStatus(state) {
  const counts = countByStatus(state);
  console.log(`任务批次: ${state.label || '-'}`);
  console.log(`Run ID: ${state.runId}`);
  console.log(`状态: ${displayStatus(state.status)}`);
  console.log(`工作区: ${state.workspacePath || state.repo || '-'}`);
  console.log(`当前批次: ${currentBatchText(state)}`);
  console.log(`进度: ${counts.completed}/${counts.total} ｜执行中 ${counts.running} ｜失败 ${counts.failed}`);
  if (state.judge?.status && state.judge.status !== 'pending') console.log(`验收: ${displayStatus(state.judge.status)}`);
}

function printRunsTable(runs) {
  if (!runs.length) { console.log('没有找到任务批次'); return; }
  for (const run of runs) {
    console.log(`${run.runId}｜${run.label || '-'}｜${displayStatus(run.status)}｜进度 ${run.completed}/${run.total}｜执行中 ${run.running}｜失败 ${run.failed}｜runner ${run.runner || '-'}｜沙箱 ${run.workerSandbox || '-'}｜工作区 ${run.workspacePath || run.repo || '-'}`);
  }
}

function isTerminal(state) {
  return isTerminalRunStatus(state.status);
}

function isFailureTerminal(state) {
  return isFailureRunStatus(state.status);
}

function isActiveRunSummary(run) {
  if (!run) return false;
  if (Number(run.running) > 0) return true;
  return isActiveRunSummaryStatus(run.status);
}

function hasRecoverableUnknownTask(state) {
  return (state.tasks || []).some(task => task.status === 'unknown' && (task.exitCode === undefined || task.exitCode === 0));
}

async function confirmFailureTerminal(runId, state, refreshRun, pollMs) {
  let confirmed = state;
  const deadline = Date.now() + 30000;
  while (confirmed?.status === 'batch_blocked' && hasRecoverableUnknownTask(confirmed) && Date.now() < deadline) {
    await delay(Math.max(500, Number(pollMs) || 3000));
    confirmed = await refreshRun(runId);
    if (!confirmed || !isTerminal(confirmed) || confirmed.status !== state.status) return { confirmed: false, state: confirmed };
  }
  return { confirmed: true, state: confirmed };
}

async function watchRun(runId, { auto = false, pollMs = 3000, quiet = false, maxRetries = 1 } = {}) {
  const { autoAdvanceRun, refreshRun } = await import('../src/orchestrator.js');
  let lastStatus = '';
  while (true) {
    const state = auto
      ? await autoAdvanceRun(runId, { startCreated: true, maxRetries, retryReason: 'auto retry from CLI' })
      : await refreshRun(runId);
    if (!state) throw new Error(`run not found: ${runId}`);
    const line = statusLine(state);
    if (line !== lastStatus) {
      if (!quiet) console.log(`[${new Date().toLocaleTimeString()}] ${line}`);
      lastStatus = line;
    }

    if (isTerminal(state)) {
      if (isFailureTerminal(state)) {
        const result = await confirmFailureTerminal(runId, state, refreshRun, pollMs);
        if (!result.confirmed) {
          lastStatus = '';
          continue;
        }
        return result.state || state;
      }
      return state;
    }
    await delay(Math.max(500, Number(pollMs) || 3000));
  }
}

async function serve(args) {
  applyRuntimeEnv(args);
  applyRunnerEnv(args);
  const { startServer } = await import('../src/server.js');
  const instance = await startServer({ host: process.env.HOST, port: Number(process.env.PORT || 8787), log: false });
  if (args.json) {
    printJson({ ok: true, command: 'serve', version: instance.version, url: instance.url, defaultWorkspace: instance.defaultWorkspace, defaultRepo: instance.defaultRepo, runsDir: instance.runsDir, runner: instance.runner, scheduler: instance.scheduler });
  } else {
    console.log(`Input Kanban v${PACKAGE_VERSION} started`);
    console.log(`URL:  ${instance.url}`);
    console.log(`Workspace: ${instance.defaultWorkspace}`);
    console.log(`Repo alias: ${instance.defaultRepo}`);
    console.log(`Runs: ${instance.runsDir}`);
    console.log(`Runner: ${instance.runner}`);
    console.log(`Scheduler: ${instance.scheduler ? 'enabled' : 'disabled'}`);
  }
  if (args.open) openBrowser(instance.url);
  const shutdown = () => { instance.stop().finally(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function detachedAutoArgs(runId, args) {
  const cliPath = fileURLToPath(import.meta.url);
  const values = [cliPath, 'auto', runId, '--host', args.host || '127.0.0.1', '--port', String(args.port || 8787), '--poll-ms', String(args.pollMs || 3000), '--max-retries', String(args.maxRetries ?? 1)];
  if (args.runsDir) values.push('--runs-dir', path.resolve(args.runsDir));
  if (args.codexBin) values.push('--codex-bin', args.codexBin);
  if (args.runner) values.push('--runner', args.runner);
  return values;
}

function startDetachedAuto(runId, args) {
  const child = spawn(process.execPath, detachedAutoArgs(runId, args), {
    detached: true,
    stdio: 'ignore',
    env: process.env
  });
  child.unref();
  return child.pid;
}

async function latestRunId() {
  const { listRuns } = await import('../src/orchestrator.js');
  const runs = await listRuns();
  if (!runs.length) throw new Error('没有找到任务批次');
  return runs[0].runId;
}

async function runs(args) {
  applyRuntimeEnv(args);
  const { listRuns } = await import('../src/orchestrator.js');
  const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Number(args.limit) : 20;
  const workspace = args.workspace || args.repo || '';
  const allRuns = await listRuns({ includeArchived: !!args.includeArchived, workspace });
  const filtered = (args.active ? allRuns.filter(isActiveRunSummary) : allRuns).slice(0, limit);
  if (args.json) {
    printJson({ ok: true, command: 'runs', active: !!args.active, includeArchived: !!args.includeArchived, workspace: workspace || undefined, limit, count: filtered.length, runs: filtered });
    return;
  }
  printRunsTable(filtered);
}

async function status(args) {
  applyRuntimeEnv(args);
  const runId = args.runId || await latestRunId();
  const { refreshRun, summaryOfRun } = await import('../src/orchestrator.js');
  if (args.watch) {
    const finalState = await watchRun(runId, { auto: false, pollMs: args.pollMs, quiet: args.json });
    if (isFailureTerminal(finalState)) process.exitCode = 1;
    if (args.json) printJson({ ok: true, command: 'status', run: summaryOfRun(finalState) });
    return;
  }
  const state = await refreshRun(runId);
  if (!state) throw new Error(`run not found: ${runId}`);
  if (args.json) { printJson({ ok: true, command: 'status', run: summaryOfRun(state) }); return; }
  printRunStatus(state);
}

async function readFinalResult(runId) {
  const { loadRun, readRunFile } = await import('../src/orchestrator.js');
  const state = await loadRun(runId);
  if (!state) throw new Error(`run not found: ${runId}`);
  try {
    const text = await readRunFile(runId, 'judge', 'verdict.json');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    return { state, source: 'judge/verdict.json', text, parsed };
  }
  catch {}
  try {
    const text = await readRunFile(runId, 'judge', 'last_message.md');
    return { state, source: 'judge/last_message.md', text, parsed: null };
  }
  catch {}
  throw new Error(`最终结果尚未生成：当前状态 ${displayStatus(state.status)}`);
}

function clipboardCommands() {
  if (process.platform === 'darwin') return [['pbcopy', []]];
  if (process.platform === 'win32') return [['clip', []]];
  return [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
}

async function copyToClipboard(text) {
  let lastError = null;
  for (const [command, args] of clipboardCommands()) {
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
        child.stdin.end(text);
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`无法复制到剪贴板：${lastError?.message || '未找到可用剪贴板命令'}`);
}

function homeDir() {
  if (process.env.HOME) return process.env.HOME;
  if (process.env.USERPROFILE) return process.env.USERPROFILE;
  if (process.env.HOMEDRIVE && process.env.HOMEPATH) return `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`;
  return '';
}

function defaultCodexSkillsDir() {
  if (process.env.CODEX_SKILLS_DIR) return path.resolve(process.env.CODEX_SKILLS_DIR);
  const home = homeDir();
  if (!home) throw new Error('cannot determine home directory; pass --target-dir');
  return path.join(home, '.codex', 'skills');
}

async function pathExists(filePath) {
  try { await fsp.access(filePath); return true; }
  catch { return false; }
}

async function installSkill(args) {
  const provider = String(args.provider || '').toLowerCase();
  if (!provider) throw new Error('install-skill requires a provider, currently: codex');
  if (provider !== 'codex') throw new Error(`unsupported skill provider: ${args.provider}; expected codex`);
  const skillsRoot = args.targetDir ? path.resolve(args.targetDir) : defaultCodexSkillsDir();
  const skills = BUNDLED_CODEX_SKILLS.map(skill => {
    const sourceDir = fileURLToPath(new URL(`../skills/${skill}`, import.meta.url));
    const targetDir = path.join(skillsRoot, skill);
    return { skill, sourceDir, targetDir };
  });
  for (const item of skills) item.exists = await pathExists(item.targetDir);
  const payload = {
    ok: true,
    command: 'install-skill',
    provider,
    skillsRoot,
    skills: skills.map(item => ({ skill: item.skill, sourceDir: item.sourceDir, targetDir: item.targetDir, exists: !!item.exists, installed: false, replaced: false })),
    dryRun: !!args.dryRun,
    installed: false,
    replaced: false
  };
  if (args.dryRun) {
    if (args.json) { printJson(payload); return; }
    console.log(`Provider: codex`);
    for (const item of skills) {
      console.log(`Skill: ${item.skill}`);
      console.log(`Source: ${item.sourceDir}`);
      console.log(`Target: ${item.targetDir}`);
    }
    console.log('Dry run: no files copied');
    return;
  }
  const existing = skills.filter(item => item.exists);
  if (existing.length && !args.force) {
    throw new Error(`skill already exists: ${existing.map(item => item.targetDir).join(', ')}; pass --force to replace it`);
  }
  await fsp.mkdir(skillsRoot, { recursive: true });
  for (const item of skills) {
    if (item.exists && args.force) await fsp.rm(item.targetDir, { recursive: true, force: true });
    await fsp.cp(item.sourceDir, item.targetDir, { recursive: true });
    const payloadItem = payload.skills.find(entry => entry.skill === item.skill);
    payloadItem.installed = true;
    payloadItem.replaced = item.exists && !!args.force;
  }
  payload.installed = true;
  payload.replaced = payload.skills.some(item => item.replaced);
  if (args.json) { printJson(payload); return; }
  console.log(`已安装 Codex skills: ${BUNDLED_CODEX_SKILLS.join(', ')}`);
  console.log(`位置: ${skillsRoot}`);
  console.log('在 Codex 对话中可尝试使用：use input-kanban-prepare skill 或 use input-kanban-execute skill');
}

async function confirmTerminalInstall(displayCommand) {
  if (!process.stdin.isTTY) return false;
  console.log('即将执行安装命令:');
  console.log(`  ${displayCommand}`);
  console.log('请输入 yes 确认安装，其他输入将取消。');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('> ');
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

function tmuxInstallNotesFrom(value = {}) {
  return value.installNotes || value.installPlan?.notes || value.notes || [];
}

function printTmuxInstallGuidance(value = {}) {
  if (value.installAvailable || value.available) {
    const command = value.installCommand || value.displayCommand || value.installPlan?.displayCommand || '';
    if (command) console.log(`平台命令: ${command}`);
    return;
  }
  const notes = tmuxInstallNotesFrom(value);
  if (notes.length) {
    console.log('手动安装指引:');
    for (const note of notes) console.log(`  - ${note}`);
  }
}

function tmuxManualInstallMessage(value = {}) {
  const notes = tmuxInstallNotesFrom(value);
  return notes.length ? notes.join(' ') : (value.installHint || value.platform || process.platform);
}

async function deps(args) {
  const { detectTmuxDependency, installTmux } = await import('../src/deps.js');
  if (args.action === 'status') {
    const status = await detectTmuxDependency();
    if (args.json) { printJson({ ok: true, command: 'deps', dependency: 'tmux', status }); return; }
    console.log(`tmux: ${status.installed ? status.version || 'installed' : 'not installed'}`);
    if (!status.installed) {
      if (status.installAvailable) console.log(`安装命令: input-kanban deps install tmux`);
      printTmuxInstallGuidance(status);
    }
    return;
  }

  if (!args.yes && !args.dryRun) {
    const status = await detectTmuxDependency();
    if (status.installed) {
      if (args.json) { printJson({ ok: true, command: 'deps', dependency: 'tmux', installed: true, alreadyInstalled: true, status }); return; }
      console.log(`tmux 已安装: ${status.version || status.tmuxBin}`);
      return;
    }
    if (!status.installAvailable) throw new Error(`当前平台未找到可自动执行的 tmux 安装器: ${tmuxManualInstallMessage(status)}`);
    const confirmed = await confirmTerminalInstall(status.installCommand);
    if (!confirmed) throw new Error('installation cancelled; rerun with --yes to confirm non-interactively');
    args.yes = true;
  }

  const result = await installTmux({ yes: args.yes, dryRun: args.dryRun });
  if (args.json) { printJson({ ok: true, command: 'deps', action: 'install', dependency: 'tmux', result }); return; }
  if (result.dryRun) {
    if (result.installPlan?.available) console.log(`安装计划: ${result.installPlan.displayCommand}`);
    else printTmuxInstallGuidance(result.installPlan || {});
    return;
  }
  console.log(result.alreadyInstalled ? `tmux 已安装: ${result.after.version || result.after.tmuxBin}` : `tmux 安装完成: ${result.after.version || result.after.tmuxBin}`);
}

async function result(args) {
  applyRuntimeEnv(args);
  const runId = args.runId || await latestRunId();
  const { state, source, text, parsed } = await readFinalResult(runId);
  const { summaryOfRun } = await import('../src/orchestrator.js');
  if (args.copy) {
    await copyToClipboard(text);
    if (args.json) { printJson({ ok: true, command: 'result', run: summaryOfRun(state), source, copied: true }); return; }
    console.log(`已复制最终结果: ${runId}`);
    return;
  }
  if (args.json) {
    printJson({ ok: true, command: 'result', run: summaryOfRun(state), source, result: parsed, text: parsed ? null : text });
    return;
  }
  console.log(text);
}

async function retry(args) {
  applyRuntimeEnv(args);
  if (!args.runId) throw new Error('retry requires a runId');
  const { retryRun, summaryOfRun } = await import('../src/orchestrator.js');
  const state = await retryRun(args.runId, { taskId: args.taskId, reason: args.reason, maxRetries: args.maxRetries });
  if (args.json) { printJson({ ok: true, command: 'retry', run: summaryOfRun(state), retriedTaskIds: state.retriedTaskIds || [] }); return; }
  console.log(`已重试任务: ${(state.retriedTaskIds || []).join(', ') || '-'}`);
}

async function stop(args) {
  applyRuntimeEnv(args);
  if (!args.runId) throw new Error('stop requires a runId');
  const { stopRun, summaryOfRun } = await import('../src/orchestrator.js');
  const state = await stopRun(args.runId, { reason: args.reason });
  if (args.json) { printJson({ ok: true, command: 'stop', run: summaryOfRun(state), reason: args.reason }); return; }
  console.log(`已停止任务批次: ${state.runId}`);
}

async function autoRun(args) {
  applyRuntimeEnv(args);
  applyRunnerEnv(args);
  if (!args.runId) throw new Error('auto requires a runId');
  const { loadRun, startPlanner, summaryOfRun } = await import('../src/orchestrator.js');
  const state = await loadRun(args.runId);
  if (!state) throw new Error(`run not found: ${args.runId}`);
  if (state.status === 'created') await startPlanner(args.runId);
  const finalState = await watchRun(args.runId, { auto: true, pollMs: args.pollMs, quiet: args.json, maxRetries: args.maxRetries });
  if (isFailureTerminal(finalState)) process.exitCode = 1;
  if (args.json) { printJson({ ok: true, command: 'auto', run: summaryOfRun(finalState) }); return; }
}

async function submit(args) {
  if (args.detach && !args.auto) throw new Error('--detach requires auto mode; remove --no-auto');
  applyRuntimeEnv(args);
  const taskText = await readTaskText(args);
  const { createRun, startPlanner, summaryOfRun } = await import('../src/orchestrator.js');
  // Keep submit's one-off runner choice local to run creation.
  const state = await createRun({
    label: args.label,
    taskText,
    workspace: process.env.KANBAN_DEFAULT_WORKSPACE || process.env.KANBAN_DEFAULT_REPO,
    repo: process.env.KANBAN_DEFAULT_REPO,
    maxParallel: args.maxParallel,
    workerSandbox: args.workerSandbox,
    workerBackend: args.workerBackend,
    codexSkipGitRepoCheck: args.codexSkipGitRepoCheck,
    planApproval: args.planApproval,
    runner: args.runner
  });
  if (!args.json) {
    console.log(`已创建任务批次: ${state.runId}`);
    console.log(`看板地址: ${webUrl(args, state.runId)}`);
    console.log(`终端查看: input-kanban status ${state.runId} --watch`);
  }
  if (args.detach) {
    const pid = startDetachedAuto(state.runId, args);
    if (args.json) { printJson({ ok: true, command: 'submit', phase: 'detached', url: baseUrl(args), supervisorPid: pid, run: summaryOfRun(state) }); return; }
    console.log(`后台执行中: supervisor pid ${pid}`);
    return;
  }
  if (!args.json) console.log('发起任务拆分...');
  const plannedState = await startPlanner(state.runId);
  if (!args.watch && !args.auto) {
    if (args.json) { printJson({ ok: true, command: 'submit', phase: 'planned', url: baseUrl(args), auto: args.auto, watch: args.watch, run: summaryOfRun(plannedState || state) }); }
    return;
  }
  const finalState = await watchRun(state.runId, { auto: args.auto, pollMs: args.pollMs, quiet: args.json, maxRetries: args.maxRetries });
  if (isFailureTerminal(finalState)) process.exitCode = 1;
  if (args.json) { printJson({ ok: true, command: 'submit', phase: 'final', url: baseUrl(args), auto: args.auto, watch: args.watch, run: summaryOfRun(finalState) }); return; }
  console.log(`最终状态: ${finalState.status}`);
}

try {
  const { command, rest, globals = {} } = splitCommand(process.argv.slice(2));
  if (command === 'serve') {
    const args = parseServeArgs(rest);
    args.json = args.json || globals.json;
    if (args.help) { printHelp(); process.exit(0); }
    await serve(args);
  } else if (command === 'version') {
    printVersion();
  } else if (command === 'submit') {
    const args = parseSubmitArgs(rest);
    args.json = args.json || globals.json;
    if (args.help) { printSubmitHelp(); process.exit(0); }
    await submit(args);
  } else if (command === 'guide') {
    const args = parseGuideArgs(rest);
    args.json = args.json || globals.json;
    if (args.help) { printAgentGuide(args.json); process.exit(0); }
    printAgentGuide(args.json);
  } else if (command === 'install-skill') {
    const args = parseInstallSkillArgs(rest);
    args.json = args.json || globals.json;
    if (args.help) { printInstallSkillHelp(); process.exit(0); }
    await installSkill(args);
  } else if (command === 'deps') {
    const args = parseDepsArgs(rest);
    args.json = args.json || globals.json;
    if (args.help) { printDepsHelp(); process.exit(0); }
    await deps(args);
  } else if (command === 'runs') {
    const args = parseRunsArgs(rest);
    args.json = args.json || globals.json;
    if (args.help) { printRunsHelp(); process.exit(0); }
    await runs(args);
  } else if (command === 'status') {
    const args = parseStatusArgs(rest);
    args.json = args.json || globals.json;
    if (args.help) { printStatusHelp(); process.exit(0); }
    await status(args);
  } else if (command === 'result') {
    const args = parseResultArgs(rest);
    args.json = args.json || globals.json;
    if (args.help) { printResultHelp(); process.exit(0); }
    await result(args);
  } else if (command === 'retry') {
    const args = parseRetryArgs(rest);
    args.json = args.json || globals.json;
    if (args.help) { printRetryHelp(); process.exit(0); }
    await retry(args);
  } else if (command === 'stop') {
    const args = parseStopArgs(rest);
    args.json = args.json || globals.json;
    if (args.help) { printStopHelp(); process.exit(0); }
    await stop(args);
  } else if (command === 'auto') {
    const args = parseAutoArgs(rest);
    args.json = args.json || globals.json;
    if (args.help) { printAutoHelp(); process.exit(0); }
    await autoRun(args);
  }
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}
