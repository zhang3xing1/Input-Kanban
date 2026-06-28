import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-planner-auto-skip-'));
const codexStub = path.join(tmp, 'codex-trust-stub.js');
await fsp.writeFile(codexStub, String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('-o');
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : '';
if (!args.includes('--skip-git-repo-check')) {
  process.stderr.write('Reading additional input from stdin...\n');
  process.stderr.write('Not inside a trusted directory and --skip-git-repo-check was not specified.\n');
  process.exit(1);
}
if (outputPath) {
  fs.writeFileSync(outputPath, JSON.stringify({
    batches: [{
      id: 'batch-1',
      name: 'Recovered batch',
      maxParallel: 1,
      tasks: [{ id: 'T-01', name: 'Recovered task', prompt: 'do work', expectedArtifacts: [] }]
    }]
  }));
}
process.stdout.write(JSON.stringify({ type: 'session', version: 1 }) + '\n');
process.exit(0);
`);
await fsp.chmod(codexStub, 0o755);
process.env.KANBAN_RUNS_DIR = path.join(tmp, 'runs');
process.env.KANBAN_RUNNER = 'headless';
process.env.KANBAN_CODEX_BIN = codexStub;
const { createRun, startPlanner, loadRun } = await import(`../src/orchestrator.js?planner-auto-skip=${Date.now()}`);

async function waitForPlanned(runId) {
  const deadline = Date.now() + 3000;
  let state;
  while (Date.now() < deadline) {
    state = await loadRun(runId);
    if (state?.status === 'planned') return state;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return state;
}

test('planner auto-enables Codex skip git repo check after trusted directory failure', async () => {
  const repo = path.join(tmp, 'umbrella');
  await fsp.mkdir(repo, { recursive: true });
  const created = await createRun({ label: 'auto skip', repo, taskText: 'plan this', codexSkipGitRepoCheck: false });
  assert.equal(created.codexSkipGitRepoCheck, false);

  await startPlanner(created.runId);
  const state = await waitForPlanned(created.runId);

  assert.equal(state.status, 'planned');
  assert.equal(state.codexSkipGitRepoCheck, true);
  assert.equal(state.planner.status, 'completed');
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].id, 'T-01');
  assert.equal(state.plannerAttempts.length, 1);
  assert.equal(state.plannerAttempts[0].status, 'failed');
  assert.match(state.warnings[0].message, /enabled --skip-git-repo-check and retried the planner/);
});
