import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = await fsp.readFile(new URL('../bin/input-kanban.js', import.meta.url), 'utf8');
const orchestrator = await fsp.readFile(new URL('../src/orchestrator.js', import.meta.url), 'utf8');
const readme = await fsp.readFile(new URL('../README.md', import.meta.url), 'utf8');
const packageJson = JSON.parse(await fsp.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const cliPath = fileURLToPath(new URL('../bin/input-kanban.js', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const versionOnly = execFileSync(process.execPath, [cliPath, '--version'], { env: { ...process.env, NODE_NO_WARNINGS: '1' }, encoding: 'utf8' }).trim();

async function writeRunState(runsDir, runId, state, extraFiles = []) {
  const runDir = path.join(runsDir, runId);
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, 'run_state.json'), JSON.stringify(state, null, 2));
  for (const [relativePath, content] of extraFiles) {
    const filePath = path.join(runDir, relativePath);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, content);
  }
}

function runCli(args, env = {}) {
  return execFileSync(process.execPath, [cliPath, ...args], { env: { ...process.env, NODE_NO_WARNINGS: '1', ...env }, encoding: 'utf8' });
}

test('CLI exposes version output', () => {
  assert.equal(versionOnly, `input-kanban v${packageJson.version}`);
  assert.match(cli, /printVersion\(\)/);
  assert.match(cli, /Input Kanban v\$\{PACKAGE_VERSION\} started/);
  assert.match(packageJson.scripts.check, /node --check src\/config\.js/);
  assert.match(packageJson.scripts.check, /node --check src\/deps\.js/);
});

test('CLI help exposes the agent guide entry point', () => {
  const helpOutput = runCli(['--help']);
  assert.match(helpOutput, /input-kanban guide \[options\]/);
  assert.match(helpOutput, /input-kanban install-skill codex \[options\]/);
  assert.match(helpOutput, /input-kanban deps \[install\] tmux \[options\]/);
  assert.match(helpOutput, /Agent guide:/);
});

test('CLI guide prints the agent quick start and JSON form', () => {
  const guideOutput = runCli(['guide']);
  assert.match(guideOutput, /Input Kanban Agent Guide/);
  assert.match(guideOutput, /Quick start:/);
  assert.match(guideOutput, /Expected Artifacts/);
  assert.match(guideOutput, /\.tmp\/input-kanban\/YYYYMMDD-HHmm-<short-slug>-task\.md/);
  assert.match(guideOutput, /input-kanban retry run_1234567890/);

  const jsonOutput = runCli(['--json', 'guide']);
  const parsed = JSON.parse(jsonOutput);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'guide');
  assert.equal(parsed.templates.length, 11);
  assert.deepEqual(parsed.handoffSections, ['Goal', 'Acceptance Criteria', 'Expected Artifacts', 'Context References', 'Risks']);
  assert.equal(parsed.preferredTaskFilePattern, '.tmp/input-kanban/YYYYMMDD-HHmm-<short-slug>-task.md');
  assert.equal(parsed.preferredTaskFileExample, '.tmp/input-kanban/20260601-1909-p0-precompute-input-copy-boundary-task.md');
  assert.equal(parsed.skillInstall, 'input-kanban install-skill codex');
  assert.match(parsed.templates[0], /input-kanban submit --task/);
  assert.ok(parsed.templates.includes('input-kanban submit --task-file task.md --codex-skip-git-repo-check'));
});

test('CLI installs bundled prepare and execute skills for Codex', async () => {
  const targetRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-codex-skills-'));
  const dryRunOutput = runCli(['--json', 'install-skill', 'codex', '--target-dir', targetRoot, '--dry-run']);
  const dryRun = JSON.parse(dryRunOutput);
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.provider, 'codex');
  assert.equal(dryRun.installed, false);
  assert.deepEqual(dryRun.skills.map(item => item.skill), ['input-kanban-prepare', 'input-kanban-execute']);
  assert.equal(dryRun.skills.find(item => item.skill === 'input-kanban-prepare').targetDir, path.join(targetRoot, 'input-kanban-prepare'));
  assert.equal(dryRun.skills.find(item => item.skill === 'input-kanban-execute').targetDir, path.join(targetRoot, 'input-kanban-execute'));

  const installOutput = runCli(['--json', 'install-skill', 'codex', '--target-dir', targetRoot]);
  const installed = JSON.parse(installOutput);
  assert.equal(installed.installed, true);
  assert.equal(installed.replaced, false);
  const prepareSkillText = await fsp.readFile(path.join(targetRoot, 'input-kanban-prepare', 'SKILL.md'), 'utf8');
  assert.match(prepareSkillText, /# input-kanban-prepare/);
  assert.match(prepareSkillText, /\.tmp\/input-kanban\/YYYYMMDD-HHmm-<short-slug>-task\.md/);
  const executeSkillText = await fsp.readFile(path.join(targetRoot, 'input-kanban-execute', 'SKILL.md'), 'utf8');
  assert.match(executeSkillText, /# input-kanban-execute/);
  assert.match(executeSkillText, /complete it in this conversation/);
});

test('planner prompt consumes structured handoff sections as execution contract', () => {
  assert.match(orchestrator, /structured handoff sections such as Goal, Acceptance Criteria, Expected Artifacts/);
  assert.match(orchestrator, /treat them as the execution contract/);
  assert.match(orchestrator, /Do not change the user's goal or acceptance criteria/);
});

test('CLI emits JSON runs output for active discovery', async () => {
  const runsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-json-runs-'));
  await writeRunState(runsDir, 'run_active', {
    runId: 'run_active',
    label: 'active run',
    repo: repoRoot,
    workspacePath: repoRoot,
    workspaceName: path.basename(repoRoot),
    git: { isGit: true, gitRoot: repoRoot, branch: 'main', dirty: false },
    workspace: { path: repoRoot, name: path.basename(repoRoot), git: { isGit: true, gitRoot: repoRoot, branch: 'main', dirty: false } },
    runner: 'headless',
    workerSandbox: 'workspace-write',
    status: 'running',
    createdAt: '2026-06-10T00:00:01.000Z',
    updatedAt: '2026-06-10T00:00:01.000Z',
    planner: { status: 'completed' },
    tasks: [{ id: 'T-01', status: 'running' }],
    batches: [],
    judge: { status: 'pending' }
  });
  await writeRunState(runsDir, 'run_done', {
    runId: 'run_done',
    label: 'done run',
    repo: repoRoot,
    workspacePath: repoRoot,
    workspaceName: path.basename(repoRoot),
    git: { isGit: true, gitRoot: repoRoot, branch: 'main', dirty: false },
    workspace: { path: repoRoot, name: path.basename(repoRoot), git: { isGit: true, gitRoot: repoRoot, branch: 'main', dirty: false } },
    runner: 'headless',
    workerSandbox: 'workspace-write',
    status: 'judged',
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    planner: { status: 'completed' },
    tasks: [],
    batches: [],
    judge: { status: 'completed' }
  });
  await writeRunState(runsDir, 'run_blocked', {
    runId: 'run_blocked',
    label: 'blocked run',
    repo: repoRoot,
    workspacePath: repoRoot,
    workspaceName: path.basename(repoRoot),
    git: { isGit: true, gitRoot: repoRoot, branch: 'main', dirty: false },
    workspace: { path: repoRoot, name: path.basename(repoRoot), git: { isGit: true, gitRoot: repoRoot, branch: 'main', dirty: false } },
    runner: 'headless',
    workerSandbox: 'workspace-write',
    status: 'batch_blocked',
    createdAt: '2026-06-10T00:00:02.000Z',
    updatedAt: '2026-06-10T00:00:02.000Z',
    planner: { status: 'completed' },
    tasks: [{ id: 'T-02', status: 'failed' }],
    batches: [],
    judge: { status: 'pending' }
  });
  await writeRunState(runsDir, 'run_load_failed', {
    runId: 'run_load_failed',
    label: 'bad state',
    repo: repoRoot,
    workspacePath: repoRoot,
    runner: 'future-runner',
    status: 'created',
    createdAt: '2026-06-10T00:00:03.000Z',
    updatedAt: '2026-06-10T00:00:03.000Z',
    planner: { status: 'pending' },
    tasks: [],
    batches: [],
    judge: { status: 'pending' }
  });
  const output = runCli(['--json', 'runs', '--active', '--runs-dir', runsDir]);
  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'runs');
  assert.equal(parsed.active, true);
  assert.equal(parsed.count, 2);
  assert.deepEqual(parsed.runs.map(run => run.runId), ['run_blocked', 'run_active']);
  assert.equal(parsed.runs.some(run => run.status === 'load_failed'), false);
  assert.equal(parsed.runs[0].status, 'batch_blocked');
  assert.equal(parsed.runs[1].running, 1);
  assert.equal(parsed.runs[1].workspacePath, path.resolve(repoRoot));

  const textOutput = runCli(['runs', '--runs-dir', runsDir]);
  assert.match(textOutput, /run_load_failed｜bad state｜加载失败\(load_failed\)/);
});

test('CLI can filter runs by workspace', async () => {
  const runsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-json-runs-workspace-'));
  const workspaceA = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-workspace-a-'));
  const workspaceB = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-workspace-b-'));
  await writeRunState(runsDir, 'run_workspace_a', {
    runId: 'run_workspace_a',
    label: 'workspace a',
    repo: workspaceA,
    workspacePath: workspaceA,
    workspaceName: path.basename(workspaceA),
    git: { isGit: false },
    workspace: { path: workspaceA, name: path.basename(workspaceA), git: { isGit: false } },
    runner: 'headless',
    workerSandbox: 'workspace-write',
    status: 'running',
    createdAt: '2026-06-10T00:00:01.000Z',
    updatedAt: '2026-06-10T00:00:01.000Z',
    planner: { status: 'completed' },
    tasks: [{ id: 'T-01', status: 'running' }],
    batches: [],
    judge: { status: 'pending' }
  });
  await writeRunState(runsDir, 'run_workspace_b', {
    runId: 'run_workspace_b',
    label: 'workspace b',
    repo: workspaceB,
    workspacePath: workspaceB,
    workspaceName: path.basename(workspaceB),
    git: { isGit: false },
    workspace: { path: workspaceB, name: path.basename(workspaceB), git: { isGit: false } },
    runner: 'headless',
    workerSandbox: 'workspace-write',
    status: 'running',
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    planner: { status: 'completed' },
    tasks: [{ id: 'T-02', status: 'running' }],
    batches: [],
    judge: { status: 'pending' }
  });
  const output = runCli(['--json', 'runs', '--workspace', workspaceA, '--runs-dir', runsDir]);
  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'runs');
  assert.equal(parsed.workspace, workspaceA);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.runs[0].runId, 'run_workspace_a');
  assert.equal(parsed.runs[0].workspacePath, workspaceA);
});

test('CLI emits JSON status output', async () => {
  const runsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-json-status-'));
  const runId = 'run_json_status';
  await writeRunState(runsDir, runId, {
    runId,
    label: 'json status',
    repo: repoRoot,
    runner: 'headless',
    workerSandbox: 'workspace-write',
    status: 'created',
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    planner: { status: 'pending' },
    tasks: [],
    batches: [],
    judge: { status: 'pending' }
  });
  const output = runCli(['--json', 'status', runId, '--runs-dir', runsDir]);
  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'status');
  assert.equal(parsed.run.runId, runId);
  assert.equal(parsed.run.status, 'created');
  assert.equal(parsed.run.total, 0);
});

test('CLI emits JSON result output', async () => {
  const runsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-json-result-'));
  const runId = 'run_json_result';
  await writeRunState(runsDir, runId, {
    runId,
    label: 'json result',
    repo: repoRoot,
    runner: 'headless',
    workerSandbox: 'workspace-write',
    status: 'judged',
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    planner: { status: 'completed' },
    tasks: [],
    batches: [],
    judge: { status: 'completed' }
  }, [['judge/verdict.json', JSON.stringify({ verdict: 'passed', completedTasks: ['T-01'] }, null, 2)]]);
  const output = runCli(['--json', 'result', runId, '--runs-dir', runsDir]);
  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'result');
  assert.equal(parsed.run.runId, runId);
  assert.equal(parsed.source, 'judge/verdict.json');
  assert.deepEqual(parsed.result, { verdict: 'passed', completedTasks: ['T-01'] });
});

test('CLI emits JSON retry output and preserves failed attempt', async () => {
  const runsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-json-retry-'));
  const runId = 'run_json_retry';
  const failedTask = { id: 'T-01', batchId: 'batch-1', name: 'task', prompt: 'retry me', sandbox: 'read-only', expectedArtifacts: [], status: 'failed', exitCode: 1 };
  await writeRunState(runsDir, runId, {
    runId,
    label: 'json retry',
    repo: runsDir,
    runner: 'headless',
    workerSandbox: 'workspace-write',
    status: 'batch_blocked',
    maxParallel: 1,
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    planner: { status: 'completed' },
    batches: [{ id: 'batch-1', name: 'batch', maxParallel: 1, status: 'failed', tasks: [failedTask] }],
    tasks: [failedTask],
    judge: { status: 'pending' }
  }, [['workers/T-01/stderr.log', 'boom'], ['workers/T-01/exit_code', '1']]);
  const output = runCli(['--json', 'retry', runId, 'T-01', '--runs-dir', runsDir], { KANBAN_CODEX_BIN: '/bin/echo' });
  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'retry');
  assert.deepEqual(parsed.retriedTaskIds, ['T-01']);
  assert.equal(parsed.run.runId, runId);
  assert.equal(parsed.run.running, 1);
  const archivedStderr = await fsp.readFile(path.join(runsDir, runId, 'worker_attempts', 'T-01', 'attempt-01', 'stderr.log'), 'utf8');
  assert.equal(archivedStderr, 'boom');
});

test('CLI emits JSON stop output', async () => {
  const runsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-json-stop-'));
  const runId = 'run_json_stop';
  await writeRunState(runsDir, runId, {
    runId,
    label: 'json stop',
    repo: repoRoot,
    runner: 'headless',
    workerSandbox: 'workspace-write',
    status: 'created',
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    planner: { status: 'pending' },
    tasks: [],
    batches: [],
    judge: { status: 'pending' }
  });
  const output = runCli(['--json', 'stop', runId, '--runs-dir', runsDir]);
  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'stop');
  assert.equal(parsed.run.runId, runId);
  assert.equal(parsed.run.status, 'stopped');
  assert.equal(parsed.reason, 'stopped from CLI');
});

test('CLI reports tmux dependency status and dry-run install plan', () => {
  const statusOutput = runCli(['--json', 'deps', 'tmux']);
  const status = JSON.parse(statusOutput);
  assert.equal(status.ok, true);
  assert.equal(status.command, 'deps');
  assert.equal(status.dependency, 'tmux');
  assert.equal(status.status.dependency, 'tmux');
  assert.equal(status.status.cliInstallCommand, 'input-kanban deps install tmux');

  const dryRunOutput = runCli(['--json', 'deps', 'install', 'tmux', '--dry-run']);
  const dryRun = JSON.parse(dryRunOutput);
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.action, 'install');
  assert.equal(dryRun.result.dryRun, true);
  assert.equal(typeof dryRun.result.installPlan.available, 'boolean');
  assert.equal(typeof dryRun.result.installPlan.displayCommand, 'string');
  assert.match(cli, /function printTmuxInstallGuidance/);
  assert.match(cli, /手动安装指引:/);
});

test('tmux dry-run install plan preserves manual install notes', async () => {
  const { installTmux } = await import(`../src/deps.js?manual-notes=${Date.now()}`);
  const result = await installTmux({
    dryRun: true,
    installPlan: {
      available: false,
      packageManager: '',
      displayCommand: '',
      notes: ['Install psmux manually or install winget first.']
    }
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.installPlan.available, false);
  assert.deepEqual(result.installPlan.notes, ['Install psmux manually or install winget first.']);
});

test('tmux installer refuses to run without explicit confirmation', async () => {
  const previousTmuxBin = process.env.KANBAN_TMUX_BIN;
  process.env.KANBAN_TMUX_BIN = 'input-kanban-missing-tmux-for-test';
  const { installTmux } = await import(`../src/deps.js?confirm-gate=${Date.now()}`);
  const calls = [];
  try {
    await assert.rejects(
      () => installTmux({
        installPlan: { available: true, command: 'fake-installer', args: ['tmux'], displayCommand: 'fake-installer tmux', packageManager: 'fake' },
        spawnImpl: (...args) => { calls.push(args); throw new Error('installer should not run'); }
      }),
      /confirmation required/
    );
    assert.deepEqual(calls, []);
  } finally {
    if (previousTmuxBin === undefined) delete process.env.KANBAN_TMUX_BIN;
    else process.env.KANBAN_TMUX_BIN = previousTmuxBin;
  }
});

test('tmux installer --yes reaches the installer branch', async () => {
  const previousTmuxBin = process.env.KANBAN_TMUX_BIN;
  process.env.KANBAN_TMUX_BIN = 'input-kanban-missing-tmux-for-test';
  const { installTmux } = await import(`../src/deps.js?yes-gate=${Date.now()}`);
  const calls = [];
  const spawnImpl = (command, args, opts) => {
    calls.push({ command, args, opts });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  };
  try {
    await assert.rejects(
      () => installTmux({
        yes: true,
        installPlan: { available: true, command: 'fake-installer', args: ['tmux'], displayCommand: 'fake-installer tmux', packageManager: 'fake' },
        spawnImpl,
        log() {}
      }),
      error => {
        assert.match(error.message, /tmux installation command completed, but tmux -V still failed/);
        assert.match(error.message, /open a new terminal/i);
        return true;
      }
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['tmux']);
    assert.equal(calls[0].opts.shell, false);
  } finally {
    if (previousTmuxBin === undefined) delete process.env.KANBAN_TMUX_BIN;
    else process.env.KANBAN_TMUX_BIN = previousTmuxBin;
  }
});

test('tmux installer resolves the Windows winget executable before spawning', async () => {
  const previousTmuxBin = process.env.KANBAN_TMUX_BIN;
  process.env.KANBAN_TMUX_BIN = 'input-kanban-missing-tmux-for-test';
  const { installTmux } = await import(`../src/deps.js?winget-resolve=${Date.now()}`);
  const calls = [];
  const resolvedWinget = 'C:\\Users\\Admin\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe';
  const spawnImpl = (command, args, opts) => {
    calls.push({ command, args, opts });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  };
  try {
    await assert.rejects(
      () => installTmux({
        yes: true,
        platform: 'win32',
        installPlan: { available: true, command: 'winget', args: ['install', '--id', 'marlocarlo.psmux', '-e'], displayCommand: 'winget install --id marlocarlo.psmux -e', packageManager: 'winget' },
        resolveCommandPathImpl: async command => {
          assert.equal(command, 'winget');
          return resolvedWinget;
        },
        spawnImpl,
        log() {}
      }),
      /tmux installation command completed, but tmux -V still failed/
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, resolvedWinget);
    assert.deepEqual(calls[0].args, ['install', '--id', 'marlocarlo.psmux', '-e']);
    assert.equal(calls[0].opts.shell, false);
  } finally {
    if (previousTmuxBin === undefined) delete process.env.KANBAN_TMUX_BIN;
    else process.env.KANBAN_TMUX_BIN = previousTmuxBin;
  }
});

test('tmux installer surfaces Windows winget resolution failures', async () => {
  const previousTmuxBin = process.env.KANBAN_TMUX_BIN;
  process.env.KANBAN_TMUX_BIN = 'input-kanban-missing-tmux-for-test';
  const { installTmux } = await import(`../src/deps.js?winget-resolve-fails=${Date.now()}`);
  const calls = [];
  try {
    await assert.rejects(
      () => installTmux({
        yes: true,
        platform: 'win32',
        installPlan: { available: true, command: 'winget', args: ['install', '--id', 'marlocarlo.psmux', '-e'], displayCommand: 'winget install --id marlocarlo.psmux -e', packageManager: 'winget' },
        resolveCommandPathImpl: async () => { throw new Error('where failed'); },
        spawnImpl: (...args) => {
          calls.push(args);
          throw new Error('installer should not run');
        },
        log() {}
      }),
      /failed to resolve winget executable before installation: where failed/
    );
    assert.deepEqual(calls, []);
  } finally {
    if (previousTmuxBin === undefined) delete process.env.KANBAN_TMUX_BIN;
    else process.env.KANBAN_TMUX_BIN = previousTmuxBin;
  }
});

test('CLI submit keeps runner local instead of exporting KANBAN_RUNNER to the planner', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-submit-runner-'));
  const workspace = path.join(tmp, 'workspace');
  const runsDir = path.join(tmp, 'runs');
  const capturePath = path.join(tmp, 'planner-env.txt');
  const codexStub = path.join(tmp, 'codex-stub.js');
  await fsp.mkdir(workspace, { recursive: true });
  await fsp.writeFile(codexStub, [
    "import fs from 'node:fs';",
    "const outputIndex = process.argv.indexOf('-o');",
    "if (process.env.KANBAN_ENV_CAPTURE) fs.writeFileSync(process.env.KANBAN_ENV_CAPTURE, process.env.KANBAN_RUNNER || '');",
    "if (outputIndex >= 0) fs.writeFileSync(process.argv[outputIndex + 1], JSON.stringify({ tasks: [{ id: 'T-01', name: 'noop', prompt: 'noop' }] }));"
  ].join('\n'));
  const env = { ...process.env, NODE_NO_WARNINGS: '1', KANBAN_ENV_CAPTURE: capturePath };
  delete env.KANBAN_RUNNER;

  const output = execFileSync(process.execPath, [
    cliPath,
    '--json',
    'submit',
    '--task',
    'noop',
    '--workspace',
    workspace,
    '--runs-dir',
    runsDir,
    '--codex-bin',
    codexStub,
    '--runner',
    'headless',
    '--no-auto'
  ], { env, encoding: 'utf8' });
  const parsed = JSON.parse(output);
  const runState = JSON.parse(await fsp.readFile(path.join(runsDir, parsed.run.runId, 'run_state.json'), 'utf8'));

  assert.equal(runState.runner, 'headless');
  assert.equal(await fsp.readFile(capturePath, 'utf8'), '');
});

test('CLI exposes submit auto loop without replacing serve mode', () => {
  assert.match(cli, /COMMANDS = new Set\(\['serve', 'submit', 'runs', 'status', 'result', 'retry', 'stop', 'auto', 'guide', 'install-skill', 'deps'\]\)/);
  assert.match(cli, /input-kanban v\$\{PACKAGE_VERSION\}/);
  assert.match(cli, /input-kanban --version/);
  assert.match(cli, /input-kanban runs \[options\]/);
  assert.match(cli, /function parseRunsArgs\(argv\)/);
  assert.match(cli, /async function runs\(args\)/);
  assert.match(cli, /--active\s+Show only active or pending-action runs/);
  assert.match(cli, /input-kanban retry <runId> \[taskId\]/);
  assert.match(cli, /await retryRun\(args\.runId/);
  assert.match(cli, /input-kanban submit \[options\]/);
  assert.match(cli, /--codex-skip-git-repo-check\s+Pass --skip-git-repo-check to Codex exec/);
  assert.match(cli, /--plan-approval\s+Pause after planning until the generated plan is confirmed/);
  assert.match(cli, /--auto\s+Plan, dispatch all batches, judge, and watch, default for submit/);
  assert.match(cli, /--no-auto\s+Only create the run and start planning/);
  assert.match(cli, /Task batch name, default generated from task text/);
  assert.match(cli, /-d, --detach\s+Run the default auto loop in a background supervisor/);
  assert.match(cli, /codexSkipGitRepoCheck: false, planApproval: false, auto: true, detach: false, watch: true/);
  assert.match(cli, /arg === '--codex-skip-git-repo-check'/);
  assert.match(cli, /arg === '--plan-approval'/);
  assert.match(cli, /codexSkipGitRepoCheck: args\.codexSkipGitRepoCheck/);
  assert.match(cli, /planApproval: args\.planApproval/);
  assert.match(cli, /function applyRunnerEnv\(args\)/);
  assert.match(cli, /async function serve\(args\) \{[\s\S]*?applyRuntimeEnv\(args\);[\s\S]*?applyRunnerEnv\(args\);/);
  assert.match(cli, /async function autoRun\(args\) \{[\s\S]*?applyRuntimeEnv\(args\);[\s\S]*?applyRunnerEnv\(args\);/);
  assert.match(cli, /async function submit\(args\) \{[\s\S]*?applyRuntimeEnv\(args\);[\s\S]*?runner: args\.runner/);
  assert.match(cli, /runner: args\.runner/);
  assert.match(cli, /async function autoRun\(args\)/);
  assert.match(cli, /function startDetachedAuto\(runId, args\)/);
  assert.match(cli, /async function result\(args\)/);
  assert.match(cli, /async function retry\(args\)/);
  assert.match(cli, /async function copyToClipboard\(text\)/);
  assert.match(cli, /await readRunFile\(runId, 'judge', 'verdict\.json'\)/);
  assert.match(cli, /async function stop\(args\)/);
  assert.match(cli, /await stopRun\(args\.runId, \{ reason: args\.reason \}\)/);
  assert.match(cli, /await createRun\(/);
  assert.match(cli, /await startPlanner\(state\.runId\)/);
  assert.match(cli, /const \{ autoAdvanceRun, refreshRun \} = await import\('\.\.\/src\/orchestrator\.js'\)/);
  assert.match(cli, /await autoAdvanceRun\(runId, \{ startCreated: true, maxRetries, retryReason: 'auto retry from CLI' \}\)/);
  assert.doesNotMatch(cli, /await dispatchRun\(runId\)/);
  assert.doesNotMatch(cli, /await startJudge\(runId\)/);
  assert.match(cli, /function hasRecoverableUnknownTask\(state\)/);
  assert.match(cli, /async function confirmFailureTerminal\(runId, state, refreshRun, pollMs\)/);
  assert.match(cli, /Date\.now\(\) \+ 30000/);
  assert.match(cli, /async function latestRunId\(\)/);
  assert.match(cli, /const STATUS_TEXT = \{/);
  assert.match(cli, /任务批次: \$\{state\.label/);
  assert.match(cli, /状态 \$\{displayStatus\(state\.status\)\}/);
  assert.match(cli, /input-kanban status <runId> --watch/);
  assert.match(cli, /function parseDepsArgs\(argv\)/);
  assert.match(cli, /async function deps\(args\)/);
  assert.match(cli, /input-kanban deps install tmux --dry-run/);
});

test('README focuses on friendly usage and structured handoff', () => {
  assert.match(readme, /## 最快开始/);
  assert.match(readme, /## 最常见的 6 个用法/);
  assert.match(readme, /input-kanban submit --task "修复登录问题，并补充回归测试" --label "修复登录问题"/);
  assert.match(readme, /input-kanban submit --task-file task\.md --plan-approval/);
  assert.match(readme, /input-kanban guide/);
  assert.match(readme, /### 外部 Agent 对话交给看板执行/);
  assert.match(readme, /Acceptance Criteria/);
  assert.match(readme, /Expected Artifacts/);
  assert.match(readme, /skills\/input-kanban-prepare\/SKILL\.md/);
  assert.match(readme, /skills\/input-kanban-execute\/SKILL\.md/);
  assert.match(readme, /docs\/input-kanban-prepare\.md/);
  assert.match(readme, /docs\/input-kanban-execute\.md/);
  assert.match(readme, /\.tmp\/input-kanban\/20260601-1909-p0-precompute-input-copy-boundary-task\.md/);
});
