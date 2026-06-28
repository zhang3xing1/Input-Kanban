import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-server-status-cache-'));
process.env.KANBAN_RUNS_DIR = tmp;
process.env.KANBAN_STATUS_APP_SERVER_TIMEOUT_MS = '20';
process.env.KANBAN_STATUS_APP_SERVER_ERROR_TTL_MS = '5000';

const { startServer } = await import(`../src/server.js?server-status-cache=${Date.now()}`);

test('status endpoint caches slow app-server enrichment failures', async () => {
  const runId = 'run_status_cache';
  const runDir = path.join(tmp, runId);
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, 'task.md'), 'status cache task');
  await fsp.writeFile(path.join(runDir, 'run_state.json'), JSON.stringify({
    runId,
    label: 'Status cache',
    status: 'judged',
    createdAt: '2026-06-10T00:00:00.000Z',
    repo: tmp,
    workspacePath: tmp,
    runner: 'headless',
    planner: { status: 'completed' },
    tasks: [{ id: 'T-01', name: 'Worker', status: 'completed' }],
    batches: [],
    judge: { status: 'completed' }
  }, null, 2));

  let calls = 0;
  const instance = await startServer({ host: '127.0.0.1', port: 0, log: false, scheduler: false });
  instance.appClient.listThreads = async ({ timeoutMs } = {}) => {
    calls += 1;
    await sleep(Number(timeoutMs || 20) + 5);
    throw new Error('thread/list too slow');
  };
  const address = instance.server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const firstStartedAt = Date.now();
    const firstResponse = await fetch(`${baseUrl}/api/runs/${runId}/status`);
    const first = await firstResponse.json();
    assert.equal(firstResponse.status, 200);
    assert.equal(first.appServerError, 'thread/list too slow');
    assert.ok(Date.now() - firstStartedAt < 500);
    assert.equal(calls, 1);

    const secondStartedAt = Date.now();
    const secondResponse = await fetch(`${baseUrl}/api/runs/${runId}/status`);
    const second = await secondResponse.json();
    assert.equal(secondResponse.status, 200);
    assert.equal(second.appServerError, 'thread/list too slow');
    assert.ok(Date.now() - secondStartedAt < 100);
    assert.equal(calls, 1);
  } finally {
    await instance.stop();
  }
});
