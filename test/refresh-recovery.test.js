import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-refresh-recovery-'));
process.env.KANBAN_RUNS_DIR = tmp;
process.env.KANBAN_RUNNER = 'tmux';

const { refreshRun, retryRun } = await import(`../src/orchestrator.js?refresh-recovery=${Date.now()}`);

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2));
}

test('refreshRun materializes a completed planner when tmux exit_code arrived before callback', async () => {
  const runId = 'run_recover_planner';
  const runDir = path.join(tmp, runId);
  const plannerDir = path.join(runDir, 'planner');
  await fsp.mkdir(plannerDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, 'task.md'), 'recover planner');
  await writeJson(path.join(runDir, 'run_state.json'), {
    runId,
    label: 'recover planner',
    repo: tmp,
    maxParallel: 1,
    runner: 'tmux',
    status: 'planning',
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z',
    planner: { status: 'running', dir: plannerDir },
    batches: [],
    tasks: [],
    judge: { status: 'pending' }
  });
  await fsp.writeFile(path.join(plannerDir, 'exit_code'), '0');
  await fsp.writeFile(path.join(plannerDir, 'last_message.md'), JSON.stringify({
    tasks: [{ id: 'T-01', name: 'task', prompt: 'do task', sandbox: 'read-only', expectedArtifacts: ['result.json'] }]
  }));

  const state = await refreshRun(runId);

  assert.equal(state.status, 'planned');
  assert.equal(state.planner.status, 'completed');
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].id, 'T-01');
  const plan = JSON.parse(await fsp.readFile(path.join(runDir, 'plan.json'), 'utf8'));
  assert.equal(plan.tasks[0].id, 'T-01');
  assert.equal(plan.tasks[0].expectedArtifacts[0], '.orchestrator/run_recover_planner/T-01/result.json');
});

test('refreshRun gives a missing worker runner a grace period before unknown', async () => {
  const runId = 'run_missing_worker_grace';
  const runDir = path.join(tmp, runId);
  const workerDir = path.join(runDir, 'workers', 'T-01');
  await fsp.mkdir(workerDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, 'task.md'), 'missing worker grace');
  const task = { id: 'T-01', batchId: 'batch-1', name: 'task', prompt: 'do task', sandbox: 'read-only', expectedArtifacts: [], status: 'running' };
  await writeJson(path.join(runDir, 'run_state.json'), {
    runId,
    label: 'missing worker grace',
    repo: tmp,
    maxParallel: 1,
    runner: 'tmux',
    status: 'running',
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z',
    planner: { status: 'completed' },
    batches: [{ id: 'batch-1', name: 'batch', maxParallel: 1, status: 'running', tasks: [task] }],
    tasks: [task],
    judge: { status: 'pending' }
  });

  const state = await refreshRun(runId);

  assert.equal(state.tasks[0].status, 'running');
  assert.ok(state.tasks[0].missingRunnerAt);
});

test('refreshRun reports backend-specific tmux run script files', async () => {
  const runId = 'run_tmux_powershell_script_file';
  const runDir = path.join(tmp, runId);
  const workerDir = path.join(runDir, 'workers', 'T-01');
  const runScript = path.join(workerDir, 'run.ps1');
  await fsp.mkdir(workerDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, 'task.md'), 'tmux script file');
  await fsp.writeFile(runScript, 'Write-Host run');
  await writeJson(path.join(workerDir, 'tmux.json'), { runScript, status: 'ready' });
  const task = { id: 'T-01', batchId: 'batch-1', name: 'task', prompt: 'do task', sandbox: 'read-only', expectedArtifacts: [], status: 'running' };
  await writeJson(path.join(runDir, 'run_state.json'), {
    runId,
    label: 'tmux script file',
    repo: tmp,
    maxParallel: 1,
    runner: 'tmux',
    status: 'running',
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z',
    planner: { status: 'completed' },
    batches: [{ id: 'batch-1', name: 'batch', maxParallel: 1, status: 'running', tasks: [task] }],
    tasks: [task],
    judge: { status: 'pending' }
  });

  const state = await refreshRun(runId);

  assert.equal(state.tasks[0].files.runScript.exists, true);
  assert.equal(state.tasks[0].files.runScript.size, 'Write-Host run'.length);
  assert.equal(state.tasks[0].files.tmux.exists, true);
});

test('refreshRun marks a missing worker unknown after the grace period', async () => {
  const runId = 'run_missing_worker_after_grace';
  const runDir = path.join(tmp, runId);
  const workerDir = path.join(runDir, 'workers', 'T-01');
  await fsp.mkdir(workerDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, 'task.md'), 'missing worker after grace');
  const task = { id: 'T-01', batchId: 'batch-1', name: 'task', prompt: 'do task', sandbox: 'read-only', expectedArtifacts: [], status: 'running', missingRunnerAt: '2026-06-09T00:00:00.000Z' };
  await writeJson(path.join(runDir, 'run_state.json'), {
    runId,
    label: 'missing worker after grace',
    repo: tmp,
    maxParallel: 1,
    runner: 'tmux',
    status: 'running',
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z',
    planner: { status: 'completed' },
    batches: [{ id: 'batch-1', name: 'batch', maxParallel: 1, status: 'running', tasks: [task] }],
    tasks: [task],
    judge: { status: 'pending' }
  });

  const state = await refreshRun(runId);

  assert.equal(state.tasks[0].status, 'unknown');
  assert.equal(state.status, 'batch_blocked');
});

test('refreshRun recovers an unknown worker when its pid is still alive', async () => {
  const runId = 'run_recover_unknown_worker_live_pid';
  const runDir = path.join(tmp, runId);
  const workerDir = path.join(runDir, 'workers', 'T-01');
  await fsp.mkdir(workerDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, 'task.md'), 'recover live pid');
  const task = { id: 'T-01', batchId: 'batch-1', name: 'task', prompt: 'do task', sandbox: 'read-only', expectedArtifacts: [], status: 'unknown', pid: process.pid };
  await writeJson(path.join(runDir, 'run_state.json'), {
    runId,
    label: 'recover live pid',
    repo: tmp,
    maxParallel: 1,
    runner: 'tmux',
    status: 'batch_blocked',
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z',
    planner: { status: 'completed' },
    batches: [{ id: 'batch-1', name: 'batch', maxParallel: 1, status: 'failed', tasks: [task] }],
    tasks: [task],
    judge: { status: 'pending' }
  });

  const state = await refreshRun(runId);

  assert.equal(state.tasks[0].status, 'running');
  assert.equal(state.status, 'running');
});

test('retryRun does not archive any worker when one selected task is still live', async () => {
  const runId = 'run_retry_live_task_atomic';
  const runDir = path.join(tmp, runId);
  const firstWorkerDir = path.join(runDir, 'workers', 'T-01');
  const liveWorkerDir = path.join(runDir, 'workers', 'T-02');
  await fsp.mkdir(firstWorkerDir, { recursive: true });
  await fsp.mkdir(liveWorkerDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, 'task.md'), 'retry should be atomic');
  await fsp.writeFile(path.join(firstWorkerDir, 'stderr.log'), 'first failed');
  const failedTask = { id: 'T-01', batchId: 'batch-1', name: 'first', prompt: 'first', sandbox: 'read-only', expectedArtifacts: [], status: 'failed', exitCode: 1 };
  const liveTask = { id: 'T-02', batchId: 'batch-1', name: 'live', prompt: 'live', sandbox: 'read-only', expectedArtifacts: [], status: 'unknown', pid: process.pid };
  await writeJson(path.join(runDir, 'run_state.json'), {
    runId,
    label: 'retry live task atomic',
    repo: tmp,
    maxParallel: 1,
    runner: 'tmux',
    status: 'batch_blocked',
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z',
    planner: { status: 'completed' },
    batches: [{ id: 'batch-1', name: 'batch', maxParallel: 1, status: 'failed', tasks: [failedTask, liveTask] }],
    tasks: [failedTask, liveTask],
    judge: { status: 'pending' }
  });

  await assert.rejects(() => retryRun(runId), /task still has a live process: T-02/);
  assert.equal(await fsp.readFile(path.join(firstWorkerDir, 'stderr.log'), 'utf8'), 'first failed');
  await assert.rejects(() => fsp.access(path.join(runDir, 'worker_attempts', 'T-01', 'attempt-01')), { code: 'ENOENT' });
});

test('refreshRun recovers an unknown worker when exit_code arrives later', async () => {
  const runId = 'run_recover_unknown_worker';
  const runDir = path.join(tmp, runId);
  const workerDir = path.join(runDir, 'workers', 'T-01');
  await fsp.mkdir(workerDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, 'task.md'), 'recover unknown worker');
  const task = { id: 'T-01', batchId: 'batch-1', name: 'task', prompt: 'do task', sandbox: 'read-only', expectedArtifacts: [], status: 'unknown' };
  await writeJson(path.join(runDir, 'run_state.json'), {
    runId,
    label: 'recover unknown worker',
    repo: tmp,
    maxParallel: 1,
    runner: 'tmux',
    status: 'running',
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z',
    planner: { status: 'completed' },
    batches: [{ id: 'batch-1', name: 'batch', maxParallel: 1, status: 'running', tasks: [task] }],
    tasks: [task],
    judge: { status: 'pending' }
  });
  await fsp.writeFile(path.join(workerDir, 'exit_code'), '0');
  await fsp.writeFile(path.join(workerDir, 'last_message.md'), 'done');

  const state = await refreshRun(runId);

  assert.equal(state.tasks[0].status, 'completed');
  assert.equal(state.batches[0].tasks[0].status, 'completed');
  assert.equal(state.status, 'batches_completed');
});

test('refreshRun writes verdict.json for a completed judge when callback was missed', async () => {
  const runId = 'run_recover_judge';
  const runDir = path.join(tmp, runId);
  const judgeDir = path.join(runDir, 'judge');
  await fsp.mkdir(judgeDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, 'task.md'), 'recover judge');
  await writeJson(path.join(runDir, 'run_state.json'), {
    runId,
    label: 'recover judge',
    repo: tmp,
    maxParallel: 1,
    runner: 'tmux',
    status: 'judging',
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z',
    planner: { status: 'completed' },
    batches: [{ id: 'batch-1', name: 'batch', maxParallel: 1, status: 'completed', tasks: [{ id: 'T-01', batchId: 'batch-1', name: 'task', prompt: 'do task', sandbox: 'read-only', expectedArtifacts: [], status: 'completed' }] }],
    tasks: [{ id: 'T-01', batchId: 'batch-1', name: 'task', prompt: 'do task', sandbox: 'read-only', expectedArtifacts: [], status: 'completed' }],
    judge: { status: 'running', dir: judgeDir }
  });
  await fsp.writeFile(path.join(judgeDir, 'exit_code'), '0');
  await fsp.writeFile(path.join(judgeDir, 'last_message.md'), JSON.stringify({
    verdict: 'passed',
    completedTasks: ['T-01'],
    failedTasks: [],
    blockedTasks: [],
    missingArtifacts: [],
    scopeViolations: [],
    residualRisk: [],
    recommendedNextActions: []
  }));

  const state = await refreshRun(runId);

  assert.equal(state.status, 'judged');
  assert.equal(state.judge.status, 'completed');
  assert.equal(state.judge.verdict.verdict, 'passed');
  const verdict = JSON.parse(await fsp.readFile(path.join(judgeDir, 'verdict.json'), 'utf8'));
  assert.equal(verdict.verdict, 'passed');
});
