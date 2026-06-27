import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { closeHttpServerGracefully, startServer } from '../src/server.js';

test('server graceful close waits before forcing active connections', async () => {
  const calls = [];
  let closeCallback = null;
  const fakeServer = {
    close(callback) { calls.push('close'); closeCallback = callback; },
    closeIdleConnections() { calls.push('idle'); },
    closeAllConnections() { calls.push('all'); }
  };

  const closing = closeHttpServerGracefully(fakeServer, { forceAfterMs: 20 });
  await sleep(5);
  assert.deepEqual(calls, ['close', 'idle']);
  await sleep(30);
  assert.deepEqual(calls, ['close', 'idle', 'all']);
  closeCallback();
  await closing;
});

test('server graceful close skips force close when close completes within grace', async () => {
  const calls = [];
  let closeCallback = null;
  const fakeServer = {
    close(callback) { calls.push('close'); closeCallback = callback; },
    closeIdleConnections() { calls.push('idle'); },
    closeAllConnections() { calls.push('all'); }
  };

  const closing = closeHttpServerGracefully(fakeServer, { forceAfterMs: 50 });
  await sleep(5);
  closeCallback();
  await closing;
  await sleep(60);
  assert.deepEqual(calls, ['close', 'idle']);
});

test('server serves index.html at root and reports a valid app root', async () => {
  const instance = await startServer({ host: '127.0.0.1', port: 0, log: false, scheduler: false });
  const address = instance.server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const rootResponse = await fetch(`${baseUrl}/`);
    const rootHtml = await rootResponse.text();
    assert.equal(rootResponse.status, 200);
    assert.match(rootHtml, /<title>Input 看板<\/title>/);
    assert.match(rootHtml, /<h1 class="brand">/);
    assert.match(rootHtml, /<footer class="page-footer">/);
    assert.match(rootHtml, /id="sessionManagementTrigger"/);
    assert.match(rootHtml, /id="sessionManagementModal"/);
    assert.match(rootHtml, /id="processManagementList"/);

    const healthResponse = await fetch(`${baseUrl}/api/health`);
    const health = await healthResponse.json();
    assert.equal(healthResponse.status, 200);
    assert.equal(health.appRoot, process.cwd());
    assert.equal(typeof health.codexBin, 'string');
    assert.equal(typeof health.piBin, 'string');

    const codexResponse = await fetch(`${baseUrl}/api/codex`);
    const codex = await codexResponse.json();
    assert.equal(codexResponse.status, 200);
    assert.equal(codex.ok, true);
    assert.equal(codex.codex.packageName, '@openai/codex');
    assert.match(codex.codex.installCommand, /npm install -g @openai\/codex/);

    const piResponse = await fetch(`${baseUrl}/api/pi`);
    const pi = await piResponse.json();
    assert.equal(piResponse.status, 200);
    assert.equal(pi.ok, true);
    assert.equal(pi.pi.packageName, '@earendil-works/pi-coding-agent');
    assert.match(pi.pi.installCommand, /npm install -g --ignore-scripts @earendil-works\/pi-coding-agent/);
  } finally {
    await instance.stop();
  }
});

test('server exposes session management threads with board-managed metadata', async () => {
  const instance = await startServer({ host: '127.0.0.1', port: 0, log: false, scheduler: false });
  const address = instance.server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  instance.appClient.listThreads = async () => ({
    data: [
      { id: 'thread-board', sessionId: 'input-kanban-run_01', status: 'running', source: 'appServer', preview: 'ORCHESTRATOR_RUN_ID: run_01\nORCHESTRATOR_TASK_ID: T-01', created_at: '2026-06-20T00:00:00.000Z', updated_at: '2026-06-20T00:10:00.000Z' },
      { id: 'thread-local-1', sessionId: 'local-session-1', status: 'running', source: 'exec', preview: 'plain local thread', created_at: '2026-06-20T00:01:00.000Z', updated_at: '2026-06-20T00:11:00.000Z' },
      { id: 'thread-local-2', sessionId: 'local-session-2', status: { label: 'completed' }, source: { label: 'exec' }, preview: 'another thread', startedAt: '2026-06-20T00:02:00.000Z', lastActiveAt: '2026-06-20T00:12:00.000Z' }
    ]
  });

  try {
    const response = await fetch(`${baseUrl}/api/session-management?limit=10`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.total, 3);
    assert.deepEqual(payload.threads.map(thread => thread.sessionId), ['local-session-2', 'local-session-1', 'input-kanban-run_01']);
    assert.equal(payload.threads[0].startedAt, '2026-06-20T00:02:00.000Z');
    assert.equal(payload.threads[0].updatedAt, '2026-06-20T00:12:00.000Z');
    assert.equal(payload.threads[0].title, 'another thread');
    assert.equal(payload.threads[2].title, '会话');
    assert.equal(payload.threads[2].boardManaged, true);
  } finally {
    await instance.stop();
  }
});

test('server exposes local codex process list', async () => {
  const instance = await startServer({ host: '127.0.0.1', port: 0, log: false, scheduler: false });
  const address = instance.server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/api/session-management/processes`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.ok(Array.isArray(payload.processes));
    assert.equal(payload.total, payload.processes.length);
  } finally {
    await instance.stop();
  }
});

test('server exposes local config and tmux dependency status', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-server-config-'));
  const previousConfigPath = process.env.KANBAN_CONFIG_PATH;
  const previousRunner = process.env.KANBAN_RUNNER;
  process.env.KANBAN_CONFIG_PATH = path.join(tmp, 'config.json');
  delete process.env.KANBAN_RUNNER;
  const instance = await startServer({ host: '127.0.0.1', port: 0, log: false, scheduler: false });
  const address = instance.server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const initial = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.equal(initial.ok, true);
    assert.equal(initial.effective.runner, 'headless');
    assert.equal(initial.effective.runnerEnvOverride, false);

    const updated = await (await fetch(`${baseUrl}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultRunner: 'tmux' })
    })).json();
    assert.equal(updated.config.defaultRunner, 'tmux');
    assert.equal(updated.effective.runner, 'tmux');

    const malformedResponse = await fetch(`${baseUrl}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json'
    });
    const malformed = await malformedResponse.json();
    assert.equal(malformedResponse.status, 400);
    assert.match(malformed.error, /invalid JSON request body/);

    const unknownKeyResponse = await fetch(`${baseUrl}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runner: 'headless' })
    });
    const unknownKey = await unknownKeyResponse.json();
    assert.equal(unknownKeyResponse.status, 400);
    assert.match(unknownKey.error, /unsupported config key: runner/);

    for (const invalidBody of ['null', '[]', '"runner"']) {
      const invalidShapeResponse = await fetch(`${baseUrl}/api/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: invalidBody
      });
      const invalidShape = await invalidShapeResponse.json();
      assert.equal(invalidShapeResponse.status, 400);
      assert.match(invalidShape.error, /JSON request body must be an object/);
    }

    const invalidRunResponse = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[]'
    });
    const invalidRun = await invalidRunResponse.json();
    assert.equal(invalidRunResponse.status, 400);
    assert.match(invalidRun.error, /JSON request body must be an object/);

    const emptyRunnerResponse = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runner: '', taskText: 'noop', repo: tmp })
    });
    const emptyRunner = await emptyRunnerResponse.json();
    assert.equal(emptyRunnerResponse.status, 400);
    assert.match(emptyRunner.error, /runner cannot be empty/);

    const internalHookResponse = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runner: 'tmux', tmuxDependencyChecker: {}, taskText: 'noop', repo: tmp })
    });
    const internalHook = await internalHookResponse.json();
    assert.equal(internalHookResponse.status, 400);
    assert.match(internalHook.error, /unsupported create run key: tmuxDependencyChecker/);

    const tmux = await (await fetch(`${baseUrl}/api/tmux`)).json();
    assert.equal(tmux.ok, true);
    assert.equal(tmux.tmux.dependency, 'tmux');
    assert.equal(tmux.tmux.cliInstallCommand, 'input-kanban deps install tmux');
  } finally {
    await instance.stop();
    if (previousConfigPath === undefined) delete process.env.KANBAN_CONFIG_PATH;
    else process.env.KANBAN_CONFIG_PATH = previousConfigPath;
    if (previousRunner === undefined) delete process.env.KANBAN_RUNNER;
    else process.env.KANBAN_RUNNER = previousRunner;
  }
});

test('server reports a corrupted local config instead of silently falling back', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-server-bad-config-'));
  const previousConfigPath = process.env.KANBAN_CONFIG_PATH;
  const previousRunner = process.env.KANBAN_RUNNER;
  process.env.KANBAN_CONFIG_PATH = path.join(tmp, 'config.json');
  delete process.env.KANBAN_RUNNER;
  await fsp.writeFile(process.env.KANBAN_CONFIG_PATH, '{bad json');
  const instance = await startServer({ host: '127.0.0.1', port: 0, log: false, scheduler: false });
  const address = instance.server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/api/config`);
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.match(body.error, /invalid Input Kanban config/);
  } finally {
    await instance.stop();
    if (previousConfigPath === undefined) delete process.env.KANBAN_CONFIG_PATH;
    else process.env.KANBAN_CONFIG_PATH = previousConfigPath;
    if (previousRunner === undefined) delete process.env.KANBAN_RUNNER;
    else process.env.KANBAN_RUNNER = previousRunner;
  }
});

test('server caches /api/pi detection for a short TTL and reports missing pi', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-server-pi-cache-'));
  const piStub = path.join(tmp, 'missing-pi.js');
  const counterFile = path.join(tmp, 'count.txt');
  await fsp.writeFile(piStub, `#!/usr/bin/env node
const fs = require('fs');
const file = ${JSON.stringify(counterFile)};
let count = 0;
try { count = Number(fs.readFileSync(file, 'utf8')) || 0; } catch {}
fs.writeFileSync(file, String(count + 1));
process.exit(127);
`);
  await fsp.chmod(piStub, 0o755);

  const child = execFile(process.execPath, ['-e', `
process.env.KANBAN_PI_BIN = ${JSON.stringify(piStub)};
process.env.KANBAN_RUNS_DIR = ${JSON.stringify(path.join(tmp, 'runs'))};
const { startServer } = await import(${JSON.stringify(new URL('../src/server.js', import.meta.url).href)});
const instance = await startServer({ host: '127.0.0.1', port: 0, log: false, scheduler: false });
const address = instance.server.address();
console.log('http://127.0.0.1:' + address.port);
process.on('SIGTERM', async () => { await instance.stop(); process.exit(0); });
setInterval(() => {}, 1000);
`], { stdio: ['ignore', 'pipe', 'pipe'] });

  let baseUrl = '';
  try {
    baseUrl = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 5000);
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      child.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`server exited before start: ${code}`));
      });
    });

    const first = await (await fetch(`${baseUrl}/api/pi`)).json();
    const second = await (await fetch(`${baseUrl}/api/pi`)).json();
    assert.equal(first.ok, true);
    assert.equal(first.pi.installed, false);
    assert.match(first.pi.installHint, /Command failed|127|missing-pi/i);
    assert.equal(second.pi.installHint, first.pi.installHint);
    assert.equal(await fsp.readFile(counterFile, 'utf8'), '1');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
  }
});

test('server caches /api/codex detection for a short TTL and reports missing codex', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-server-codex-cache-'));
  const codexStub = path.join(tmp, 'missing-codex.js');
  const counterFile = path.join(tmp, 'count.txt');
  await fsp.writeFile(codexStub, `#!/usr/bin/env node
const fs = require('fs');
const file = ${JSON.stringify(counterFile)};
let count = 0;
try { count = Number(fs.readFileSync(file, 'utf8')) || 0; } catch {}
fs.writeFileSync(file, String(count + 1));
process.exit(127);
`);
  await fsp.chmod(codexStub, 0o755);

  const child = execFile(process.execPath, ['-e', `
process.env.KANBAN_CODEX_BIN = ${JSON.stringify(codexStub)};
process.env.KANBAN_RUNS_DIR = ${JSON.stringify(path.join(tmp, 'runs'))};
const { startServer } = await import(${JSON.stringify(new URL('../src/server.js', import.meta.url).href)});
const instance = await startServer({ host: '127.0.0.1', port: 0, log: false, scheduler: false });
const address = instance.server.address();
console.log('http://127.0.0.1:' + address.port);
process.on('SIGTERM', async () => { await instance.stop(); process.exit(0); });
setInterval(() => {}, 1000);
`], { stdio: ['ignore', 'pipe', 'pipe'] });

  let baseUrl = '';
  try {
    baseUrl = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 5000);
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      child.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`server exited before start: ${code}`));
      });
    });

    const first = await (await fetch(`${baseUrl}/api/codex`)).json();
    const second = await (await fetch(`${baseUrl}/api/codex`)).json();
    assert.equal(first.ok, true);
    assert.equal(first.codex.installed, false);
    assert.match(first.codex.installHint, /Command failed|127|missing-codex/i);
    assert.equal(second.codex.installHint, first.codex.installHint);
    assert.equal(await fsp.readFile(counterFile, 'utf8'), '1');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
  }
});
