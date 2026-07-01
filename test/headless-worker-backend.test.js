import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHeadlessRunner } from '../src/runners/headlessRunner.js';

test('headless runner uses pi backend for workers only', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-headless-pi-'));
  const outDir = path.join(tmp, 'worker');
  await fsp.mkdir(outDir, { recursive: true });
  const argvPath = path.join(tmp, 'argv.json');
  const piStub = path.join(tmp, 'pi-stub.js');
  await fsp.writeFile(piStub, String.raw`#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ type: 'session', version: 3 }) + '\n');
process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'pi worker ready' } }) + '\n');
process.exit(0);
`);
  await fsp.chmod(piStub, 0o755);
  const runner = createHeadlessRunner({ workerBackend: 'pi', piBin: piStub });
  const handle = runner.startAgentTask({
    runId: 'run-1',
    taskId: 'T-01',
    prompt: 'hello pi worker',
    sandbox: 'workspace-write',
    cwd: tmp,
    outDir
  });
  const exitCode = await new Promise(resolve => handle.onExit(resolve));
  assert.equal(exitCode, 0);
  const argv = JSON.parse(await fsp.readFile(argvPath, 'utf8'));
  assert.deepEqual(argv.slice(0, 2), ['--mode', 'json']);
  assert.equal(argv[2], 'hello pi worker');
  assert.equal(await fsp.readFile(path.join(outDir, 'last_message.md'), 'utf8'), 'pi worker ready');
  const job = JSON.parse(await fsp.readFile(path.join(outDir, 'package', 'job.json'), 'utf8'));
  assert.equal(job.mode, 'standalone');
  assert.equal(job.execution.backend, 'headless');
  assert.equal(job.execution.agentRuntime, 'pi');
  assert.equal(job.artifacts.files.lastMessage, 'last_message.md');
  const jobEvents = (await fsp.readFile(path.join(outDir, 'package', 'job_events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(jobEvents.map(event => event.type), ['job.packaged', 'job.started', 'job.completed']);
  const manifest = JSON.parse(await fsp.readFile(path.join(outDir, 'package', 'manifest.json'), 'utf8'));
  assert.equal(manifest.files.find(item => item.name === 'lastMessage').exists, true);
});
