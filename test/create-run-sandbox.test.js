import { execFile } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-create-sandbox-'));
const repo = path.join(tmp, 'repo');
const nonGitRepo = path.join(tmp, 'not-git');
const tmuxInstalled = async () => ({ installed: true, available: true, version: 'tmux 3.4' });
const tmuxMissing = async () => ({ installed: false, available: false, installAvailable: false });
await fsp.mkdir(repo, { recursive: true });
await fsp.mkdir(nonGitRepo, { recursive: true });
await execFileAsync('git', ['init'], { cwd: repo });
process.env.KANBAN_RUNS_DIR = path.join(tmp, 'runs');
process.env.KANBAN_RUNNER = 'headless';
const { autoAdvanceActiveRuns, createRun, listRuns, loadRun, markTaskCompleted, readRunFile, renameRun } = await import(`../src/orchestrator.js?create-sandbox=${Date.now()}`);

test('createRun derives a label from task text when omitted', async () => {
  const state = await createRun({ repo, taskText: '请修复登录问题，并补充回归测试\n\n更多细节' });
  assert.equal(state.label, '请修复登录问题，并补充回归测试');
  assert.match(state.runId, /^run_.*_run_/);
});

test('createRun truncates derived labels by display width', async () => {
  const state = await createRun({ repo, taskText: '请按两批完成任务：第一批并行生成三个随机整数，第二批求和并判断是否为十的倍数' });
  assert.equal(state.label, '请按两批完成任务：第一批并行生成三个随机…');
});

test('createRun stores default worker sandbox', async () => {
  const state = await createRun({ label: 'default sandbox', repo, taskText: 'noop' });
  assert.equal(state.workerSandbox, 'workspace-write');
  assert.equal(state.codexSkipGitRepoCheck, false);
  assert.equal(state.workerBackend, 'codex');
});

test('createRun stores optional Codex git repo check bypass', async () => {
  const state = await createRun({ label: 'codex bypass', repo, taskText: 'noop', codexSkipGitRepoCheck: true });
  assert.equal(state.codexSkipGitRepoCheck, true);
});

test('createRun stores optional plan approval gate', async () => {
  const open = await createRun({ label: 'open gate', repo, taskText: 'noop' });
  assert.deepEqual(open.gates.planApproval, { required: false, approved: true, approvedAt: null, approvedBy: null });

  const gated = await createRun({ label: 'plan gate', repo, taskText: 'noop', planApproval: true });
  assert.equal(gated.gates.planApproval.required, true);
  assert.equal(gated.gates.planApproval.approved, false);
  assert.equal(gated.gates.planApproval.approvedAt, null);
});

test('createRun stores explicit danger-full-access worker sandbox', async () => {
  const state = await createRun({ label: 'danger sandbox', repo, taskText: 'noop', workerSandbox: 'danger-full-access' });
  assert.equal(state.workerSandbox, 'danger-full-access');
});

test('createRun stores an explicit runner for the run', async () => {
  const previousRunner = process.env.KANBAN_RUNNER;
  delete process.env.KANBAN_RUNNER;
  try {
    const state = await createRun({ label: 'tmux runner', repo, taskText: 'noop', runner: 'tmux', tmuxDependencyChecker: tmuxInstalled });
    assert.equal(state.runner, 'tmux');
    const persisted = await loadRun(state.runId);
    assert.equal(persisted.runner, 'tmux');
  } finally {
    if (previousRunner === undefined) delete process.env.KANBAN_RUNNER;
    else process.env.KANBAN_RUNNER = previousRunner;
  }
});

test('createRun blocks tmux runner when tmux is unavailable', async () => {
  const previousRunner = process.env.KANBAN_RUNNER;
  delete process.env.KANBAN_RUNNER;
  try {
    await assert.rejects(
      () => createRun({ label: 'missing tmux', repo, taskText: 'noop', runner: 'tmux', tmuxDependencyChecker: tmuxMissing }),
      error => error.statusCode === 400 && /tmux runner requires tmux/.test(error.message) && error.tmux?.installed === false
    );
  } finally {
    if (previousRunner === undefined) delete process.env.KANBAN_RUNNER;
    else process.env.KANBAN_RUNNER = previousRunner;
  }
});

test('createRun enforces KANBAN_RUNNER over explicit runner requests', async () => {
  const previousRunner = process.env.KANBAN_RUNNER;
  process.env.KANBAN_RUNNER = 'headless';
  try {
    await assert.rejects(
      () => createRun({ label: 'env runner wins', repo, taskText: 'noop', runner: 'tmux', tmuxDependencyChecker: tmuxInstalled }),
      error => error.statusCode === 400 && /KANBAN_RUNNER is set to headless/.test(error.message)
    );
  } finally {
    if (previousRunner === undefined) delete process.env.KANBAN_RUNNER;
    else process.env.KANBAN_RUNNER = previousRunner;
  }
});

test('createRun reads the current local default runner when no runner is passed', async () => {
  const previousRunner = process.env.KANBAN_RUNNER;
  const previousConfigPath = process.env.KANBAN_CONFIG_PATH;
  const configPath = path.join(tmp, 'runner-config.json');
  delete process.env.KANBAN_RUNNER;
  process.env.KANBAN_CONFIG_PATH = configPath;
  await fsp.writeFile(configPath, JSON.stringify({ defaultRunner: 'tmux' }));
  try {
    const state = await createRun({ label: 'configured runner', repo, taskText: 'noop', tmuxDependencyChecker: tmuxInstalled });
    assert.equal(state.runner, 'tmux');
  } finally {
    if (previousRunner === undefined) delete process.env.KANBAN_RUNNER;
    else process.env.KANBAN_RUNNER = previousRunner;
    if (previousConfigPath === undefined) delete process.env.KANBAN_CONFIG_PATH;
    else process.env.KANBAN_CONFIG_PATH = previousConfigPath;
  }
});

test('createRun rejects unknown worker sandbox by falling back to workspace-write', async () => {
  const state = await createRun({ label: 'bad sandbox', repo, taskText: 'noop', workerSandbox: 'not-a-sandbox' });
  assert.equal(state.workerSandbox, 'workspace-write');
});

test('createRun accepts a non-git workspace directory', async () => {
  const state = await createRun({ label: 'not git', workspace: nonGitRepo, taskText: 'noop' });
  assert.equal(state.workspacePath, nonGitRepo);
  assert.equal(state.repo, nonGitRepo);
  assert.equal(state.git.isGit, false);
  assert.equal(state.workspace.git.isGit, false);
});

test('createRun marks a git workspace when available', async () => {
  const state = await createRun({ label: 'git workspace', repo, taskText: 'noop' });
  assert.equal(state.workspacePath, repo);
  assert.equal(state.repo, repo);
  assert.equal(state.git.isGit, true);
  assert.equal(state.workspace.git.isGit, true);
  assert.ok(state.git.gitRoot);
});

test('createRun rejects a missing workspace path', async () => {
  await assert.rejects(
    () => createRun({ label: 'missing', workspace: path.join(tmp, 'missing'), taskText: 'noop' }),
    error => error.statusCode === 400 && /does not exist/.test(error.message)
  );
});

test('createRun accepts pi worker backend', async () => {
  const state = await createRun({ label: 'pi worker', repo, taskText: 'noop', workerBackend: 'pi' });
  assert.equal(state.workerBackend, 'pi');
});

test('renameRun updates and trims a run label', async () => {
  const state = await createRun({ label: 'old label', repo, taskText: 'noop' });
  const renamed = await renameRun(state.runId, { label: '  new label  ' });
  assert.equal(renamed.label, 'new label');
  assert.ok(renamed.renamedAt);
  const persisted = await loadRun(state.runId);
  assert.equal(persisted.label, 'new label');
});

test('renameRun rejects an empty run label', async () => {
  const state = await createRun({ label: 'keep label', repo, taskText: 'noop' });
  await assert.rejects(
    () => renameRun(state.runId, { label: '   ' }),
    error => error.statusCode === 400 && /label cannot be empty/.test(error.message)
  );
});

test('listRuns freezes duration after run is judged', async () => {
  const state = await createRun({ label: 'judged duration', repo, taskText: 'noop' });
  const runDir = path.join(process.env.KANBAN_RUNS_DIR, state.runId);
  state.status = 'judged';
  state.createdAt = '2026-06-10T08:00:00.000Z';
  state.updatedAt = '2026-06-10T08:07:00.000Z';
  state.planner = { id: 'planner', status: 'completed', endedAt: '2026-06-10T08:01:00.000Z' };
  state.tasks = [{ id: 'T-01', status: 'completed', endedAt: '2026-06-10T08:05:00.000Z' }];
  state.batches = [{ id: 'batch-1', name: 'batch', status: 'completed', tasks: state.tasks }];
  state.judge = { id: 'judge', status: 'completed', endedAt: '2026-06-10T08:06:00.000Z' };
  await fsp.writeFile(path.join(runDir, 'run_state.json'), JSON.stringify(state, null, 2));

  const listed = await listRuns();
  const summary = listed.find(run => run.runId === state.runId);

  assert.equal(summary.durationEnd, '2026-06-10T08:06:00.000Z');
});

test('listRuns surfaces a load_failed summary for a run with an invalid runner', async () => {
  const runId = 'run_invalid_runner_state';
  const runDir = path.join(process.env.KANBAN_RUNS_DIR, runId);
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, 'run_state.json'), JSON.stringify({
    runId,
    label: 'invalid runner state',
    repo,
    workspacePath: repo,
    runner: 'future-runner',
    status: 'created',
    createdAt: '2026-06-10T08:00:00.000Z',
    updatedAt: '2026-06-10T08:01:00.000Z',
    planner: { status: 'pending' },
    batches: [],
    tasks: [],
    judge: { status: 'pending' }
  }, null, 2));

  await assert.rejects(() => loadRun(runId), /invalid runner: future-runner/);
  const listed = await listRuns({ includeArchived: true });
  const summary = listed.find(run => run.runId === runId);

  assert.equal(summary.status, 'load_failed');
  assert.equal(summary.runner, 'future-runner');
  assert.equal(summary.failed, 1);
  assert.match(summary.loadError, /invalid runner: future-runner/);
});

test('autoAdvanceActiveRuns skips runs that cannot be loaded', async () => {
  const runId = 'run_auto_advance_invalid_runner_state';
  const runDir = path.join(process.env.KANBAN_RUNS_DIR, runId);
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, 'run_state.json'), JSON.stringify({
    runId,
    label: 'invalid scheduler state',
    repo,
    workspacePath: repo,
    runner: 'future-runner',
    status: 'created',
    createdAt: '2026-06-10T08:00:00.000Z',
    updatedAt: '2026-06-10T08:01:00.000Z',
    planner: { status: 'pending' },
    batches: [],
    tasks: [],
    judge: { status: 'pending' }
  }, null, 2));

  await assert.rejects(() => loadRun(runId), /invalid runner: future-runner/);
  const results = await autoAdvanceActiveRuns();

  assert.equal(results.some(result => result.runId === runId), false);
  assert.equal(results.some(result => result.ok === false && /invalid runner/.test(result.error || '')), false);
});

test('autoAdvanceActiveRuns still surfaces unexpected load failures', async () => {
  const runId = 'run_auto_advance_bad_workspace_state';
  const runDir = path.join(process.env.KANBAN_RUNS_DIR, runId);
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, 'run_state.json'), JSON.stringify({
    runId,
    label: 'bad workspace state',
    repo: 42,
    workspacePath: 42,
    runner: 'headless',
    status: 'created',
    createdAt: '2026-06-10T08:00:00.000Z',
    updatedAt: '2026-06-10T08:01:00.000Z',
    planner: { status: 'pending' },
    batches: [],
    tasks: [],
    judge: { status: 'pending' }
  }, null, 2));

  await assert.rejects(() => loadRun(runId));
  const results = await autoAdvanceActiveRuns();
  const result = results.find(item => item.runId === runId);

  assert.equal(result?.ok, false);
  assert.ok(result.error);
  assert.doesNotMatch(result.error, /invalid runner/);
});

test('markTaskCompleted stores manual success result text', async () => {
  const state = await createRun({ label: 'manual result', repo, taskText: 'noop' });
  const runDir = path.join(process.env.KANBAN_RUNS_DIR, state.runId);
  const workerDir = path.join(runDir, 'workers', 'T-01');
  await fsp.mkdir(workerDir, { recursive: true });
  state.status = 'batch_blocked';
  state.batches = [{ id: 'batch-1', name: 'batch', maxParallel: 1, status: 'failed', tasks: [{ id: 'T-01', batchId: 'batch-1', name: 'task', status: 'failed', exitCode: 1, expectedArtifacts: [] }] }];
  state.tasks = state.batches[0].tasks;
  await fsp.writeFile(path.join(runDir, 'run_state.json'), JSON.stringify(state, null, 2));

  const marked = await markTaskCompleted(state.runId, 'T-01', { resultText: 'manual success evidence' });

  assert.equal(marked.tasks[0].status, 'completed');
  assert.equal(marked.tasks[0].manualCompletion.hasManualResult, true);
  assert.equal(await readRunFile(state.runId, 'T-01', 'manual_result.md'), 'manual success evidence');
  const completion = JSON.parse(await readRunFile(state.runId, 'T-01', 'manual_completion.json'));
  assert.equal(completion.manualResultFile, 'manual_result.md');
});
