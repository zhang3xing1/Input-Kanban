import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ensureDir,
  nowIso,
  readTextMaybe,
  writeJsonAtomic
} from '../utils.js';
import { createCodexExecutor } from '../agents/codexExecutor.js';
import {
  DEFAULT_TMUX_BIN,
  sanitizeTmuxSessionName,
  sanitizeTmuxWindowName,
  tmuxHasSession,
  tmuxKillSession,
  tmuxNewSession,
  tmuxNewWindow,
  tmuxSelectLayout,
  tmuxSplitWindow
} from '../tmux.js';

function processKey(runId, taskId) {
  return `${runId}:${taskId}`;
}

function roleForTask(taskId) {
  if (taskId === 'planner') return 'planner';
  if (taskId === 'judge') return 'judge';
  return 'worker';
}

function windowNameForTask(taskId, batchId = null) {
  const role = roleForTask(taskId);
  if (role === 'worker') return sanitizeTmuxWindowName(batchId || 'batch-1');
  return sanitizeTmuxWindowName(role);
}

function sessionNameForRun(runId) {
  return sanitizeTmuxSessionName(`input-kanban-${runId}`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const BIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin');
const FORMATTER_BIN = path.join(BIN_DIR, 'input-kanban-format-events.js');
const TIMESTAMP_BIN = path.join(BIN_DIR, 'input-kanban-timestamp-events.js');
const OVERVIEW_BIN = path.join(BIN_DIR, 'input-kanban-tmux-overview.js');

function buildOverviewCommand(runStatePath) {
  const quotedStatePath = shellQuote(runStatePath);
  const quotedOverviewBin = shellQuote(OVERVIEW_BIN);
  return `while true; do clear; node ${quotedOverviewBin} ${quotedStatePath}; sleep 2; done`;
}

export function createTmuxRunner({
  codexBin,
  agentExecutor = createCodexExecutor({ codexBin }),
  tmuxBin = DEFAULT_TMUX_BIN,
  tmuxOptions = {},
  pollMs = 1000
} = {}) {
  const runningWindows = new Map();

  async function startAgentTask({ runId, taskId, batchId = null, runStatePath = null, prompt, sandbox, cwd, outDir, skipGitRepoCheck = false }) {
    await ensureDir(outDir);
    const sessionName = sessionNameForRun(runId);
    const role = roleForTask(taskId);
    const windowName = windowNameForTask(taskId, batchId);
    const key = processKey(runId, taskId);
    const startedAt = nowIso();
    const prepared = await agentExecutor.prepareTmuxTask({ prompt, formatterBin: FORMATTER_BIN, timestampBin: TIMESTAMP_BIN, sandbox, cwd, outDir, runId, taskId, role, skipGitRepoCheck });
    const { prompt: promptFile, runScript, exitCode: exitFile, tmuxMetadata: metadataFile } = prepared.paths;

    const metadata = {
      type: 'input_kanban_tmux_task',
      version: 1,
      runner: 'tmux',
      runId,
      taskId,
      role,
      batchId,
      sessionName,
      windowName,
      target: `${sessionName}:${windowName}`,
      runScript,
      promptFile,
      cwd,
      sandbox,
      startedAt,
      ready: false,
      status: 'pending'
    };
    await writeJsonAtomic(metadataFile, metadata);

    const overviewCommand = buildOverviewCommand(runStatePath || path.join(path.dirname(path.dirname(outDir)), 'run_state.json'));
    const tmuxCommandOptions = { ...tmuxOptions, tmuxBin, cwd };
    try {
      if (await tmuxHasSession(sessionName, tmuxCommandOptions)) {
        if (!runningWindows.has(`${runId}:__window:${windowName}`)) {
          await tmuxNewWindow(sessionName, windowName, { ...tmuxCommandOptions, command: overviewCommand });
          runningWindows.set(`${runId}:__window:${windowName}`, { sessionName, windowName, overview: true });
        }
      } else {
        await tmuxNewSession(sessionName, { ...tmuxCommandOptions, windowName, command: overviewCommand });
        runningWindows.set(`${runId}:__window:${windowName}`, { sessionName, windowName, overview: true });
      }
      await tmuxSplitWindow(sessionName, windowName, { ...tmuxCommandOptions, vertical: true, command: runScript });
      await tmuxSelectLayout(sessionName, windowName, 'tiled', tmuxCommandOptions);
    } catch (error) {
      await writeJsonAtomic(metadataFile, {
        ...metadata,
        ready: false,
        status: 'failed',
        error: error?.message || String(error),
        failedAt: nowIso()
      });
      throw error;
    }

    await writeJsonAtomic(metadataFile, {
      ...metadata,
      ready: true,
      status: 'ready',
      attachCommand: `${tmuxBin} attach-session -t ${sessionName}`,
      selectWindowCommand: `${tmuxBin} select-window -t ${sessionName}:${windowName}`,
      selectCommand: `${tmuxBin} select-window -t ${sessionName}:${windowName}`,
      paneCommand: `${tmuxBin} select-window -t ${sessionName}:${windowName}`,
      readyAt: nowIso()
    });

    const listeners = [];
    let exited = false;
    let exitCode = null;
    const timer = setInterval(async () => {
      const text = await readTextMaybe(exitFile, 1000);
      if (text === '') return;
      clearInterval(timer);
      runningWindows.delete(key);
      const code = Number(text.trim());
      exited = true;
      exitCode = Number.isNaN(code) ? null : code;
      for (const listener of listeners) listener(exitCode);
    }, Math.max(100, Number(pollMs) || 1000));

    const handle = {
      pid: null,
      onExit(listener) {
        if (exited) listener(exitCode);
        else listeners.push(listener);
      },
      stop() {}
    };
    runningWindows.set(key, { sessionName, windowName, timer });
    return handle;
  }

  async function stopRun(runId) {
    for (const [key, value] of runningWindows.entries()) {
      if (!key.startsWith(`${runId}:`)) continue;
      clearInterval(value.timer);
      runningWindows.delete(key);
    }
    const sessionName = sessionNameForRun(runId);
    try {
      if (await tmuxHasSession(sessionName, { ...tmuxOptions, tmuxBin })) {
        await tmuxKillSession(sessionName, { ...tmuxOptions, tmuxBin });
      }
    } catch (error) {
      if (!/no such session/i.test(error?.message || '')) throw error;
    }
  }

  function hasRunning(runId, taskId) {
    return runningWindows.has(processKey(runId, taskId));
  }

  return { kind: 'tmux', startAgentTask, startCodexTask: startAgentTask, stopRun, hasRunning };
}
