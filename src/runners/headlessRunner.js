import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createCodexExecutor } from '../agents/codexExecutor.js';

function processKey(runId, taskId) {
  return `${runId}:${taskId}`;
}

function captureEventsWithTimestamps(stream, eventsFile, timedEventsFile) {
  const events = fs.createWriteStream(eventsFile, { flags: 'a' });
  const timedEvents = fs.createWriteStream(timedEventsFile, { flags: 'a' });
  let buffer = '';
  const writeLine = line => {
    events.write(`${line}\n`);
    const receivedAt = new Date().toISOString();
    try {
      timedEvents.write(`${JSON.stringify({ receivedAt, event: JSON.parse(line) })}\n`);
    } catch {
      timedEvents.write(`${JSON.stringify({ receivedAt, rawLine: line })}\n`);
    }
  };
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      if (line) writeLine(line);
    }
  });
  stream.on('end', () => {
    if (buffer) writeLine(buffer.replace(/\r$/, ''));
    events.end();
    timedEvents.end();
  });
}

export function createHeadlessRunner({ codexBin, agentExecutor = createCodexExecutor({ codexBin }) } = {}) {
  const runningProcesses = new Map();

  function startAgentTask({ runId, taskId, prompt, sandbox, cwd, outDir, skipGitRepoCheck = false }) {
    const prepared = agentExecutor.prepareHeadlessTask({ prompt, sandbox, cwd, outDir, skipGitRepoCheck });
    const child = spawn(prepared.command, prepared.args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    captureEventsWithTimestamps(child.stdout, prepared.paths.events, prepared.paths.timedEvents);
    child.stderr.pipe(fs.createWriteStream(prepared.paths.stderr, { flags: 'a' }));
    const key = processKey(runId, taskId);
    const listeners = [];
    let exited = false;
    let exitCode = null;
    const finish = code => {
      if (exited) return;
      exited = true;
      exitCode = code;
      try { fs.writeFileSync(prepared.paths.exitCode, String(code)); } catch {}
      runningProcesses.delete(key);
      for (const listener of listeners) listener(code);
    };
    runningProcesses.set(key, child);
    child.on('error', error => {
      try { fs.appendFileSync(prepared.paths.stderr, `${error.message || String(error)}\n`); } catch {}
      finish(error?.code === 'ENOENT' ? 127 : 1);
    });
    child.on('exit', code => finish(code));
    return {
      pid: child.pid ?? null,
      onExit(listener) {
        if (exited) listener(exitCode);
        else listeners.push(listener);
      },
      stop(signal = 'TERM') { child.kill(signal); }
    };
  }

  function stopRun(runId, signal = 'TERM') {
    for (const [key, child] of runningProcesses.entries()) {
      if (key.startsWith(`${runId}:`)) {
        try { child.kill(signal); } catch {}
        runningProcesses.delete(key);
      }
    }
  }

  function hasRunning(runId, taskId) {
    return runningProcesses.has(processKey(runId, taskId));
  }

  return { kind: 'headless', startAgentTask, startCodexTask: startAgentTask, stopRun, hasRunning };
}

export const headlessRunner = createHeadlessRunner();
