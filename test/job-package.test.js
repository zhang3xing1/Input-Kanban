import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JOB_PACKAGE_SCHEMA, appendStandaloneJobEvent, createStandaloneJobSpec, writeStandaloneArtifactManifest, writeStandaloneJobPackage } from '../src/jobPackage.js';

test('standalone job package records portable job metadata without environment secrets', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-job-package-'));
  const spec = writeStandaloneJobPackage({
    runId: 'run_job_package',
    taskId: 'T-01',
    batchId: 'batch-1',
    prompt: 'do the task',
    sandbox: 'workspace-write',
    cwd: tmp,
    outDir: tmp,
    runner: 'headless',
    agentRuntime: 'codex',
    skipGitRepoCheck: true,
    expectedArtifacts: ['result.json']
  });

  assert.equal(spec.schema, JOB_PACKAGE_SCHEMA);
  assert.equal(spec.mode, 'standalone');
  assert.equal(spec.role, 'worker');
  assert.equal(spec.workspace.type, 'localPath');
  assert.equal(spec.execution.backend, 'headless');
  assert.equal(spec.execution.agentRuntime, 'codex');
  assert.equal(spec.execution.environment.inherited, true);
  assert.deepEqual(spec.execution.environment.variables, []);
  assert.deepEqual(spec.expectedArtifacts, ['result.json']);

  const job = JSON.parse(await fsp.readFile(path.join(tmp, 'package', 'job.json'), 'utf8'));
  assert.equal(job.runId, 'run_job_package');
  assert.equal(job.artifacts.files.lastMessage, 'last_message.md');
  assert.equal(job.artifacts.files.job, 'package/job.json');
  assert.equal(await fsp.readFile(path.join(tmp, 'package', 'prompt.md'), 'utf8'), 'do the task');
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(tmp, 'package', 'workspace.json'), 'utf8')), { type: 'localPath', path: tmp });

  const events = (await fsp.readFile(path.join(tmp, 'package', 'job_events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].type, 'job.packaged');
  const manifest = JSON.parse(await fsp.readFile(path.join(tmp, 'package', 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema, 'input-kanban.artifact-manifest.v1');
  assert.equal(manifest.files.find(item => item.name === 'job').exists, true);
});

test('standalone job manifest and events can be updated after artifacts change', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-job-manifest-'));
  await fsp.mkdir(path.join(tmp, 'package'), { recursive: true });
  await fsp.writeFile(path.join(tmp, 'last_message.md'), 'done');
  appendStandaloneJobEvent(tmp, { type: 'job.completed', runId: 'r', taskId: 'T-01', role: 'worker', exitCode: 0 });
  const manifest = writeStandaloneArtifactManifest(tmp, { runId: 'r', taskId: 'T-01', role: 'worker' });
  assert.equal(manifest.files.find(item => item.name === 'lastMessage').exists, true);
  assert.equal(JSON.parse((await fsp.readFile(path.join(tmp, 'package', 'job_events.jsonl'), 'utf8')).trim()).type, 'job.completed');
});

test('standalone job spec derives planner and judge roles', () => {
  assert.equal(createStandaloneJobSpec({ runId: 'r', taskId: 'planner', prompt: '', sandbox: 'read-only', cwd: '/', outDir: '/', runner: 'headless' }).role, 'planner');
  assert.equal(createStandaloneJobSpec({ runId: 'r', taskId: 'judge', prompt: '', sandbox: 'read-only', cwd: '/', outDir: '/', runner: 'headless' }).role, 'judge');
});
