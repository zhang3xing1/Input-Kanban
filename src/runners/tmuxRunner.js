import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  CODEX_BIN,
  ensureDir,
  nowIso,
  readTextMaybe,
  writeJsonAtomic
} from '../utils.js';
import { resolveCodexLauncher } from '../codexLauncher.js';
import { pathForTmuxShellBackend, resolveTmuxShellBackend, scriptPathForBackend, tmuxShellLaunchCommand } from '../tmuxShell.js';
import { appendStandaloneJobEvent, writeStandaloneArtifactManifest, writeStandaloneJobPackage } from '../jobPackage.js';
import {
  DEFAULT_TMUX_BIN,
  sanitizeTmuxSessionName,
  sanitizeTmuxWindowName,
  tmuxHasSession,
  tmuxKillSession,
  tmuxNewSession,
  tmuxNewWindow,
  tmuxSelectLayout,
  tmuxSendLine,
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

function bashArrayAssignment(name, values) {
  return `${name}=(${values.map(value => shellQuote(value)).join(' ')})`;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function cmdCaretQuote(value) {
  return `^"${String(value).replace(/"/g, '^"')}^"`;
}

function usesWindowsTmuxShellBackend(backend) {
  return ['powershell', 'cmd'].includes(backend?.scriptKind);
}

function tmuxCommandJoiner(backend) {
  return backend?.scriptKind === 'cmd' ? ' & ' : '; ';
}

const BIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin');
const FORMATTER_BIN = path.join(BIN_DIR, 'input-kanban-format-events.js');
const TIMESTAMP_BIN = path.join(BIN_DIR, 'input-kanban-timestamp-events.js');
const OVERVIEW_BIN = path.join(BIN_DIR, 'input-kanban-tmux-overview.js');

export function buildOverviewCommand(runStatePath, backend) {
  const overviewBin = pathForTmuxShellBackend(OVERVIEW_BIN, backend);
  const statePath = pathForTmuxShellBackend(runStatePath, backend);
  if (backend?.scriptKind === 'powershell') {
    return `while ($true) { Clear-Host; node ${psQuote(overviewBin)} ${psQuote(statePath)}; Start-Sleep -Seconds 2 }`;
  }
  if (backend?.scriptKind === 'cmd') {
    return `cmd.exe /d /s /c "for /l %i in (0,0,1) do @(cls & node ${cmdCaretQuote(overviewBin)} ${cmdCaretQuote(statePath)} & timeout /t 2 /nobreak >nul)"`;
  }
  const quotedStatePath = shellQuote(statePath);
  const quotedOverviewBin = shellQuote(overviewBin);
  return `while true; do clear; node ${quotedOverviewBin} ${quotedStatePath}; sleep 2; done`;
}

function codexArgList(codexCommand, codexArgsPrefix = [], backend) {
  return [pathForTmuxShellBackend(codexCommand, backend), ...codexArgsPrefix.map(value => pathForTmuxShellBackend(value, backend))];
}

function buildBashRunScript({ backend, codexCommand, codexArgsPrefix = [], sandbox, cwd, outDir, runId, taskId, role, skipGitRepoCheck = false }) {
  const codexLauncher = bashArrayAssignment('CODEX_LAUNCHER', codexArgList(codexCommand, codexArgsPrefix, backend));
  const skipGitRepoCheckArg = skipGitRepoCheck ? "SKIP_GIT_REPO_CHECK='--skip-git-repo-check'" : "SKIP_GIT_REPO_CHECK=''";
  const scriptCwd = pathForTmuxShellBackend(cwd, backend);
  const scriptOutDir = pathForTmuxShellBackend(outDir, backend);
  const formatterBin = pathForTmuxShellBackend(FORMATTER_BIN, backend);
  const timestampBin = pathForTmuxShellBackend(TIMESTAMP_BIN, backend);
  return `#!/usr/bin/env bash
set -u

${codexLauncher}
${skipGitRepoCheckArg}
SANDBOX=${shellQuote(sandbox)}
CWD=${shellQuote(scriptCwd)}
OUT_DIR=${shellQuote(scriptOutDir)}
RUN_ID=${shellQuote(runId)}
TASK_ID=${shellQuote(taskId)}
ROLE=${shellQuote(role)}
PROMPT_FILE="$OUT_DIR/prompt.md"
EVENTS="$OUT_DIR/events.jsonl"
TIMED_EVENTS="$OUT_DIR/events_timed.jsonl"
STDERR_LOG="$OUT_DIR/stderr.log"
FORMATTER_BIN=${shellQuote(formatterBin)}
TIMESTAMP_BIN=${shellQuote(timestampBin)}
LAST_MESSAGE="$OUT_DIR/last_message.md"
EXIT_CODE="$OUT_DIR/exit_code"

cd "$CWD"
rm -f "$EXIT_CODE"
touch "$EVENTS" "$TIMED_EVENTS" "$STDERR_LOG"
"\${CODEX_LAUNCHER[@]}" exec \${SKIP_GIT_REPO_CHECK:+"$SKIP_GIT_REPO_CHECK"} --json --sandbox "$SANDBOX" -C "$CWD" -o "$LAST_MESSAGE" "$(<"$PROMPT_FILE")" >> "$EVENTS" 2> >(tee -a "$STDERR_LOG" >&2)
code=$?
node "$TIMESTAMP_BIN" --timed-only "$EVENTS" "$TIMED_EVENTS" < "$EVENTS" | node "$FORMATTER_BIN" || true
printf '%s' "$code" > "$EXIT_CODE"
printf '\\nInput Kanban tmux task completed.\\n'
printf 'runId: %s\\n' "$RUN_ID"
printf 'taskId: %s\\n' "$TASK_ID"
printf 'role: %s\\n' "$ROLE"
printf 'exit code: %s\\n' "$code"
printf 'artifact dir: %s\\n' "$OUT_DIR"
printf 'Type exit or press Ctrl-D to close this tmux window.\\n'
exec "\${SHELL:-/bin/sh}" -i
`;
}

function buildPowerShellRunScript({ backend, codexCommand, codexArgsPrefix = [], sandbox, cwd, outDir, runId, taskId, role, skipGitRepoCheck = false }) {
  const launcher = codexArgList(codexCommand, codexArgsPrefix).map(psQuote).join(', ');
  const skip = skipGitRepoCheck ? "@('--skip-git-repo-check')" : '@()';
  const keepOpenShell = psQuote(backend?.command || 'powershell');
  const helper = `import fs from 'node:fs';
import { spawn } from 'node:child_process';
const launcher = ${JSON.stringify(codexArgList(codexCommand, codexArgsPrefix))};
const skip = ${JSON.stringify(skipGitRepoCheck ? ['--skip-git-repo-check'] : [])};
const prompt = fs.readFileSync(process.env.PROMPT_FILE, 'utf8');
const args = [...launcher.slice(1), 'exec', ...skip, '--json', '--sandbox', process.env.SANDBOX, '-C', process.env.CWD, '-o', process.env.LAST_MESSAGE, prompt];
const child = spawn(launcher[0], args, { cwd: process.env.CWD, stdio: ['ignore', 'inherit', 'inherit'] });
child.on('exit', code => process.exit(code ?? 1));
`;
  const helperBase64 = Buffer.from(helper, 'utf8').toString('base64');
  return `$ErrorActionPreference = 'Continue'
$CodexLauncher = @(${launcher})
$SkipGitRepoCheck = ${skip}
$Sandbox = ${psQuote(sandbox)}
$Cwd = ${psQuote(cwd)}
$OutDir = ${psQuote(outDir)}
$RunId = ${psQuote(runId)}
$TaskId = ${psQuote(taskId)}
$Role = ${psQuote(role)}
$PromptFile = Join-Path $OutDir 'prompt.md'
$Events = Join-Path $OutDir 'events.jsonl'
$TimedEvents = Join-Path $OutDir 'events_timed.jsonl'
$StderrLog = Join-Path $OutDir 'stderr.log'
$FormatterBin = ${psQuote(FORMATTER_BIN)}
$TimestampBin = ${psQuote(TIMESTAMP_BIN)}
$LastMessage = Join-Path $OutDir 'last_message.md'
$ExitCode = Join-Path $OutDir 'exit_code'
$Helper = Join-Path $OutDir 'run-powershell-helper.mjs'

Set-Location -LiteralPath $Cwd
Remove-Item -LiteralPath $ExitCode -Force -ErrorAction SilentlyContinue
New-Item -ItemType File -Path $Events,$TimedEvents,$StderrLog -Force | Out-Null
$env:SANDBOX = $Sandbox
$env:CWD = $Cwd
$env:PROMPT_FILE = $PromptFile
$env:LAST_MESSAGE = $LastMessage
[System.IO.File]::WriteAllText($Helper, [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${helperBase64}')))
node $Helper 1>> $Events 2>> $StderrLog
$Code = $LASTEXITCODE
Get-Content -LiteralPath $Events -Raw | node $TimestampBin --timed-only $Events $TimedEvents | node $FormatterBin
Set-Content -LiteralPath $ExitCode -Value ([string]$Code) -NoNewline
Write-Host ''
Write-Host 'Input Kanban tmux task completed.'
Write-Host "runId: $RunId"
Write-Host "taskId: $TaskId"
Write-Host "role: $Role"
Write-Host "exit code: $Code"
Write-Host "artifact dir: $OutDir"
Write-Host 'Type exit to close this tmux window.'
& ${keepOpenShell} -NoLogo -NoProfile -NoExit -Command "Set-Location -LiteralPath '$($PWD.Path)'"
`;
}

function buildCmdRunScript({ codexCommand, codexArgsPrefix = [], sandbox, cwd, outDir, runId, taskId, role, skipGitRepoCheck = false }) {
  const helper = `import fs from 'node:fs';
import { spawn } from 'node:child_process';
const launcher = ${JSON.stringify(codexArgList(codexCommand, codexArgsPrefix))};
const skip = ${JSON.stringify(skipGitRepoCheck ? ['--skip-git-repo-check'] : [])};
const prompt = fs.readFileSync(process.env.PROMPT_FILE, 'utf8');
const args = [...launcher.slice(1), 'exec', ...skip, '--json', '--sandbox', process.env.SANDBOX, '-C', process.env.CWD, '-o', process.env.LAST_MESSAGE, prompt];
const child = spawn(launcher[0], args, { cwd: process.env.CWD, stdio: ['ignore', 'inherit', 'inherit'] });
child.on('exit', code => process.exit(code ?? 1));
`;
  const helperBase64 = Buffer.from(helper, 'utf8').toString('base64');
  return `@echo off
setlocal
set "SANDBOX=${sandbox}"
set "CWD=${cwd}"
set "OUT_DIR=${outDir}"
set "RUN_ID=${runId}"
set "TASK_ID=${taskId}"
set "ROLE=${role}"
set "PROMPT_FILE=%OUT_DIR%\\prompt.md"
set "EVENTS=%OUT_DIR%\\events.jsonl"
set "TIMED_EVENTS=%OUT_DIR%\\events_timed.jsonl"
set "STDERR_LOG=%OUT_DIR%\\stderr.log"
set "FORMATTER_BIN=${FORMATTER_BIN}"
set "TIMESTAMP_BIN=${TIMESTAMP_BIN}"
set "LAST_MESSAGE=%OUT_DIR%\\last_message.md"
set "EXIT_CODE=%OUT_DIR%\\exit_code"
set "HELPER=%OUT_DIR%\\run-cmd-helper.mjs"

cd /d "%CWD%"
del /f /q "%EXIT_CODE%" >nul 2>nul
type nul >> "%EVENTS%"
type nul >> "%TIMED_EVENTS%"
type nul >> "%STDERR_LOG%"
node -e "require('fs').writeFileSync(process.env.HELPER, Buffer.from('${helperBase64}', 'base64').toString('utf8'))"
node "%HELPER%" 1>> "%EVENTS%" 2>> "%STDERR_LOG%"
set "CODE=%ERRORLEVEL%"
node "%TIMESTAMP_BIN%" --timed-only "%EVENTS%" "%TIMED_EVENTS%" < "%EVENTS%" | node "%FORMATTER_BIN%"
<nul set /p "=%CODE%" > "%EXIT_CODE%"
echo.
echo Input Kanban tmux task completed.
echo runId: %RUN_ID%
echo taskId: %TASK_ID%
echo role: %ROLE%
echo exit code: %CODE%
echo artifact dir: %OUT_DIR%
echo Type exit to close this tmux window.
cmd.exe /d /k
endlocal
`;
}

export function buildRunScript({ backend, ...options }) {
  if (backend?.scriptKind === 'powershell') return buildPowerShellRunScript({ backend, ...options });
  if (backend?.scriptKind === 'cmd') return buildCmdRunScript(options);
  return buildBashRunScript({ backend, ...options });
}

export function createTmuxRunner({
  codexBin = CODEX_BIN,
  tmuxBin = DEFAULT_TMUX_BIN,
  tmuxShell = 'auto',
  tmuxOptions = {},
  pollMs = 1000
} = {}) {
  const runningWindows = new Map();

  async function startAgentTask({ runId, taskId, batchId = null, runStatePath = null, prompt, sandbox, cwd, outDir, skipGitRepoCheck = false, expectedArtifacts = [], attempt = 1, retry = null, workspace = null, security = null }) {
    await ensureDir(outDir);
    const sessionName = sessionNameForRun(runId);
    const role = roleForTask(taskId);
    const windowName = windowNameForTask(taskId, batchId);
    const key = processKey(runId, taskId);
    const promptFile = path.join(outDir, 'prompt.md');
    const shellBackend = await resolveTmuxShellBackend(tmuxShell);
    if (!shellBackend.available) throw new Error(`tmux shell backend unavailable: ${shellBackend.reason || tmuxShell}`);
    const runScript = scriptPathForBackend(outDir, shellBackend);
    const exitFile = path.join(outDir, 'exit_code');
    const metadataFile = path.join(outDir, 'tmux.json');
    const startedAt = nowIso();

    writeStandaloneJobPackage({ runId, taskId, batchId, role, prompt, sandbox, cwd, outDir, runner: 'tmux', agentRuntime: 'codex', skipGitRepoCheck, expectedArtifacts, attempt, retry, workspace, security });
    await fsp.writeFile(promptFile, prompt);
    const { command: codexCommand, argsPrefix: codexArgsPrefix } = resolveCodexLauncher(codexBin);
    await fsp.writeFile(runScript, buildRunScript({ backend: shellBackend, codexCommand, codexArgsPrefix, sandbox, cwd, outDir, runId, taskId, role, skipGitRepoCheck }));
    if (shellBackend.scriptKind === 'bash') await fsp.chmod(runScript, 0o755);

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
      tmuxShell: shellBackend,
      promptFile,
      cwd,
      sandbox,
      startedAt,
      ready: false,
      status: 'pending'
    };
    await writeJsonAtomic(metadataFile, metadata);

    const overviewCommand = buildOverviewCommand(runStatePath || path.join(path.dirname(path.dirname(outDir)), 'run_state.json'), shellBackend);
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
      const launchCommand = tmuxShellLaunchCommand(shellBackend, runScript);
      let taskPaneTarget = '';
      if (usesWindowsTmuxShellBackend(shellBackend)) {
        const split = await tmuxSplitWindow(sessionName, windowName, { ...tmuxCommandOptions, vertical: true, printPane: true });
        taskPaneTarget = String(split.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
        await tmuxSendLine(sessionName, windowName, launchCommand, { ...tmuxCommandOptions, target: taskPaneTarget });
      } else {
        const split = await tmuxSplitWindow(sessionName, windowName, { ...tmuxCommandOptions, vertical: true, printPane: true, command: launchCommand });
        taskPaneTarget = String(split.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
      }
      await tmuxSelectLayout(sessionName, windowName, 'tiled', tmuxCommandOptions);
      const selectWindowCommand = `${tmuxBin} select-window -t ${sessionName}:${windowName}`;
      const paneJoiner = tmuxCommandJoiner(shellBackend);
      const selectPaneCommand = taskPaneTarget
        ? `${selectWindowCommand}${paneJoiner}${tmuxBin} select-pane -t ${taskPaneTarget}`
        : selectWindowCommand;
      const attachPaneCommand = taskPaneTarget
        ? `${selectPaneCommand}${paneJoiner}${tmuxBin} attach-session -t ${sessionName}`
        : `${tmuxBin} attach-session -t ${sessionName}`;
      await writeJsonAtomic(metadataFile, {
        ...metadata,
        ready: true,
        status: 'ready',
        attachCommand: `${tmuxBin} attach-session -t ${sessionName}`,
        selectWindowCommand,
        selectCommand: selectWindowCommand,
        paneId: taskPaneTarget,
        paneTarget: taskPaneTarget,
        selectPaneCommand,
        paneCommand: selectPaneCommand,
        attachPaneCommand,
        readyAt: nowIso()
      });
      appendStandaloneJobEvent(outDir, { type: 'job.started', runId, taskId, role, backend: 'tmux', agentRuntime: 'codex', sessionName, windowName, paneTarget: taskPaneTarget });
      writeStandaloneArtifactManifest(outDir, { runId, taskId, role });
    } catch (error) {
      await writeJsonAtomic(metadataFile, {
        ...metadata,
        ready: false,
        status: 'failed',
        error: error?.message || String(error),
        failedAt: nowIso()
      });
      appendStandaloneJobEvent(outDir, { type: 'job.start_failed', runId, taskId, role, backend: 'tmux', agentRuntime: 'codex', error: error?.message || String(error) });
      writeStandaloneArtifactManifest(outDir, { runId, taskId, role });
      throw error;
    }

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
      appendStandaloneJobEvent(outDir, { type: exitCode === 0 ? 'job.completed' : 'job.failed', runId, taskId, role, exitCode });
      writeStandaloneArtifactManifest(outDir, { runId, taskId, role });
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
    runningWindows.set(key, { sessionName, windowName, timer, outDir, runId, taskId, role });
    return handle;
  }

  async function stopRun(runId) {
    for (const [key, value] of runningWindows.entries()) {
      if (!key.startsWith(`${runId}:`)) continue;
      if (value.outDir) appendStandaloneJobEvent(value.outDir, { type: 'job.stop_requested', runId: value.runId || runId, taskId: value.taskId || '', role: value.role || '', backend: 'tmux', agentRuntime: 'codex' });
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

  return { kind: 'tmux', sessionNameForRun, startAgentTask, startCodexTask: startAgentTask, stopRun, hasRunning };
}
