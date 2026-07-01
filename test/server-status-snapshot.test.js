import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-server-status-snapshot-'));
process.env.KANBAN_RUNS_DIR = tmp;
process.env.KANBAN_STATUS_REFRESH_LOCK_TIMEOUT_MS = '5';

const { acquireRunStateLock } = await import(`../src/orchestrator.js?server-status-snapshot=${Date.now()}`);
const { startServer } = await import(`../src/server.js?server-status-snapshot=${Date.now()}`);

async function writeRunState(runId) {
  const runDir = path.join(tmp, runId);
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, 'run_state.json'), JSON.stringify({
    runId,
    label: 'server status snapshot',
    repo: tmp,
    workspacePath: tmp,
    runner: 'headless',
    workerSandbox: 'workspace-write',
    status: 'running',
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    planner: { status: 'completed' },
    tasks: [{ id: 'T-01', status: 'running' }],
    batches: [],
    judge: { status: 'pending' }
  }, null, 2));
}

test('server status endpoint reads snapshots by default and refreshes only when requested', async () => {
  const runId = 'run_server_status_snapshot';
  await writeRunState(runId);
  const release = await acquireRunStateLock(runId, { timeoutMs: 1000, staleMs: 100000 });
  const instance = await startServer({ host: '127.0.0.1', port: 0, log: false, scheduler: false });
  const address = instance.server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const snapshotResponse = await fetch(`${baseUrl}/api/runs/${runId}/status`);
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.runId, runId);
    assert.equal(snapshot.statusRefreshError, undefined);

    const refreshResponse = await fetch(`${baseUrl}/api/runs/${runId}/status?refresh=1`);
    assert.equal(refreshResponse.status, 200);
    const refreshed = await refreshResponse.json();
    assert.equal(refreshed.runId, runId);
    assert.equal(refreshed.statusRefreshError, `run state lock busy: ${runId}`);
  } finally {
    await release();
    await instance.stop();
  }
});
