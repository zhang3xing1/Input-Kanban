import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  TmuxUnavailableError,
  checkTmuxAvailable,
  ensureTmuxAvailable,
  sanitizeTmuxName,
  sanitizeTmuxSessionName,
  sanitizeTmuxWindowName,
  tmuxHasSession,
  tmuxKillSession,
  tmuxKillWindow,
  tmuxNewSession,
  tmuxNewWindow,
  tmuxSelectLayout,
  tmuxSendLine,
  tmuxSplitWindow
} from '../src/tmux.js';
import { shellWord } from '../src/deps.js';
import { createDefaultRunner, createHeadlessRunner, createTmuxRunner, headlessRunner } from '../src/runners/index.js';
import { buildOverviewCommand, buildRunScript } from '../src/runners/tmuxRunner.js';
import { tmuxShellLaunchCommand } from '../src/tmuxShell.js';

function makeRunner(handler) {
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args });
    return handler(command, args);
  };
  return { calls, runner };
}

async function finishTmuxHandle(handle, outDir) {
  const exitCode = await new Promise(resolve => {
    handle.onExit(resolve);
    fsp.writeFile(path.join(outDir, 'exit_code'), '0');
  });
  assert.equal(exitCode, 0);
}

test('sanitizes tmux names deterministically with shell-safe characters', () => {
  assert.equal(sanitizeTmuxSessionName('Run 01/工作'), 'Run-01');
  assert.equal(sanitizeTmuxWindowName('Worker: T-01'), 'Worker-T-01');
  assert.equal(sanitizeTmuxName(''), 'tmux');
  assert.equal(sanitizeTmuxName('////', { fallback: 'fallback' }), 'fallback');

  const longName = sanitizeTmuxName('a'.repeat(120), { maxLength: 32 });
  assert.equal(longName, sanitizeTmuxName('a'.repeat(120), { maxLength: 32 }));
  assert.match(longName, /^[a-zA-Z0-9._-]+$/);
  assert.ok(longName.length <= 32);
});

test('shellWord quotes single quotes for POSIX shells', () => {
  assert.equal(shellWord("it's"), "'it'\\''s'");
});

test('ensureTmuxAvailable returns a clear error when tmux cannot run', async () => {
  const { runner } = makeRunner(() => ({ code: 127, stderr: 'tmux: command not found' }));

  await assert.rejects(
    () => ensureTmuxAvailable({ tmuxBin: 'missing-tmux', runner }),
    error => error instanceof TmuxUnavailableError &&
      /tmux is unavailable/.test(error.message) &&
      /missing-tmux -V/.test(error.message)
  );
});

test('checkTmuxAvailable rejects non-tmux binaries that return success', async () => {
  const { runner } = makeRunner(() => ({ code: 0, stdout: 'PowerShell 7.6.1\n' }));

  const status = await checkTmuxAvailable({ tmuxBin: 'pwsh', runner });

  assert.equal(status.available, false);
  assert.equal(status.version, '');
  assert.match(status.result.stdout, /PowerShell/);
});

test('checkTmuxAvailable accepts psmux tmux-compatible version output', async () => {
  const { runner } = makeRunner(() => ({ code: 0, stdout: 'psmux 3.3.6\n' }));

  const status = await checkTmuxAvailable({ tmuxBin: 'tmux', runner });

  assert.equal(status.available, true);
  assert.equal(status.version, 'psmux 3.3.6');
});

test('tmuxHasSession checks availability before checking the session', async () => {
  const { calls, runner } = makeRunner((_command, args) => {
    if (args[0] === '-V') return { code: 0, stdout: 'tmux 3.4\n' };
    return { code: 1, stderr: 'no such session' };
  });

  assert.equal(await tmuxHasSession('Run 01/工作', { runner }), false);
  assert.deepEqual(calls.map(call => call.args), [
    ['-V'],
    ['has-session', '-t', 'Run-01']
  ]);
});

test('tmux wrappers invoke tmux with argument arrays and sanitized names', async () => {
  const { calls, runner } = makeRunner((_command, args) => {
    if (args[0] === '-V') return { code: 0, stdout: 'tmux 3.4\n' };
    return { code: 0, stdout: '' };
  });

  await tmuxNewSession('Run 01/工作', { runner, windowName: 'Planner: 1', cwd: '/repo' });
  await tmuxNewWindow('Run 01/工作', 'Worker: T-01', { runner, cwd: '/repo' });
  await tmuxKillSession('Run 01/工作', { runner });
  await tmuxKillWindow('Run 01/工作', 'Worker: T-01', { runner });
  await tmuxSplitWindow('Run 01/工作', 'Worker: T-01', { runner, cwd: '/repo', command: 'echo pane' });
  await tmuxSelectLayout('Run 01/工作', 'Worker: T-01', 'tiled', { runner });

  assert.deepEqual(calls.map(call => call.args), [
    ['-V'],
    ['new-session', '-d', '-s', 'Run-01', '-n', 'Planner-1', '-c', '/repo'],
    ['-V'],
    ['new-window', '-t', 'Run-01', '-n', 'Worker-T-01', '-c', '/repo'],
    ['-V'],
    ['kill-session', '-t', 'Run-01'],
    ['-V'],
    ['kill-window', '-t', 'Run-01:Worker-T-01'],
    ['-V'],
    ['split-window', '-t', 'Run-01:Worker-T-01', '-h', '-c', '/repo', 'echo pane'],
    ['-V'],
    ['select-layout', '-t', 'Run-01:Worker-T-01', 'tiled']
  ]);
});

test('tmux windows can start with commands without send-keys', async () => {
  const { calls, runner } = makeRunner((_command, args) => {
    if (args[0] === '-V') return { code: 0, stdout: 'tmux 3.4\n' };
    return { code: 0, stdout: '' };
  });

  await tmuxNewSession('Run 01', { runner, windowName: 'Planner', cwd: '/repo', command: 'echo planner' });
  await tmuxNewWindow('Run 01', 'Worker', { runner, cwd: '/repo', command: 'echo worker' });

  assert.deepEqual(calls.map(call => call.args), [
    ['-V'],
    ['new-session', '-d', '-s', 'Run-01', '-n', 'Planner', '-c', '/repo', 'echo planner'],
    ['-V'],
    ['new-window', '-t', 'Run-01', '-n', 'Worker', '-c', '/repo', 'echo worker']
  ]);
  assert.equal(calls.some(call => call.args.includes('send-keys')), false);
});

test('tmuxSendLine injects a literal command and enter key', async () => {
  const { calls, runner } = makeRunner((_command, args) => {
    if (args[0] === '-V') return { code: 0, stdout: 'tmux 3.4\n' };
    return { code: 0, stdout: '' };
  });

  await tmuxSendLine('Run 01', 'Planner', 'pwsh -File "run.ps1"', { runner });

  assert.deepEqual(calls.map(call => call.args), [
    ['-V'],
    ['send-keys', '-t', 'Run-01:Planner', '-l', 'pwsh -File "run.ps1"'],
    ['-V'],
    ['send-keys', '-t', 'Run-01:Planner', 'C-m']
  ]);
});

test('tmux shell helpers launch only native auto-selected scripts', () => {
  assert.equal(
    tmuxShellLaunchCommand({ resolved: 'powershell', scriptKind: 'powershell', command: 'powershell' }, 'D:\\UGit\\Input-Kanban\\run.ps1'),
    'powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "D:\\UGit\\Input-Kanban\\run.ps1"'
  );
  assert.equal(
    tmuxShellLaunchCommand({ resolved: 'cmd', scriptKind: 'cmd', command: 'cmd.exe' }, 'D:\\UGit\\Input-Kanban\\run.cmd'),
    'cmd.exe /d /s /c ""D:\\UGit\\Input-Kanban\\run.cmd""'
  );
  assert.equal(
    tmuxShellLaunchCommand({ resolved: 'posix', scriptKind: 'bash', command: 'bash' }, '/tmp/input-kanban/run.sh'),
    '/tmp/input-kanban/run.sh'
  );
});

test('tmux overview command follows native shell backends', () => {
  const windowsStatePath = 'D:\\UGit\\Input-Kanban\\run_state.json';
  const posixStatePath = '/tmp/input-kanban/run_state.json';

  assert.match(buildOverviewCommand(windowsStatePath, { resolved: 'powershell', scriptKind: 'powershell' }), /Clear-Host; node '.*input-kanban-tmux-overview\.js' 'D:\\UGit\\Input-Kanban\\run_state\.json'; Start-Sleep -Seconds 2/);
  assert.match(buildOverviewCommand(windowsStatePath, { resolved: 'cmd', scriptKind: 'cmd' }), /cmd\.exe \/d \/s \/c "for \/l %i in \(0,0,1\) do @\(cls & node \^".*input-kanban-tmux-overview\.js\^" \^"D:\\UGit\\Input-Kanban\\run_state\.json\^" & timeout \/t 2 \/nobreak >nul\)"/);
  assert.match(buildOverviewCommand(posixStatePath, { resolved: 'posix', scriptKind: 'bash' }), /while true; do clear; node '.*input-kanban-tmux-overview\.js' '\/tmp\/input-kanban\/run_state\.json'; sleep 2; done/);
});

test('tmux run script generation covers native Windows and POSIX backends', () => {
  const windowsBase = {
    codexCommand: 'D:\\Tools\\codex.cmd',
    codexArgsPrefix: ['D:\\Tools\\node_modules\\@openai\\codex\\bin\\codex.js'],
    sandbox: 'workspace-write',
    cwd: 'D:\\UGit\\Input-Kanban',
    outDir: 'D:\\UGit\\Input-Kanban\\.runs\\planner',
    runId: 'run_backend',
    taskId: 'planner',
    role: 'planner'
  };

  const ps = buildRunScript({ backend: { resolved: 'powershell', scriptKind: 'powershell', command: 'powershell' }, ...windowsBase });
  assert.match(ps, /\$CodexLauncher = @\('D:\\Tools\\codex\.cmd', 'D:\\Tools\\node_modules\\@openai\\codex\\bin\\codex\.js'\)/);
  assert.match(ps, /\$Helper = Join-Path \$OutDir 'run-powershell-helper\.mjs'/);
  assert.match(ps, /\[System\.IO\.File\]::WriteAllText\(\$Helper, \[System\.Text\.Encoding\]::UTF8\.GetString/);
  assert.match(ps, /node \$Helper 1>> \$Events 2>> \$StderrLog/);
  assert.doesNotMatch(ps, /& \$CodexLauncher\[0\]/);
  assert.match(ps, /& 'powershell' -NoLogo -NoProfile -NoExit/);
  assert.match(ps, /Get-Content -LiteralPath \$Events -Raw \| node \$TimestampBin --timed-only \$Events \$TimedEvents \| node \$FormatterBin/);

  const cmd = buildRunScript({ backend: { resolved: 'cmd', scriptKind: 'cmd', command: 'cmd.exe' }, ...windowsBase });
  assert.match(cmd, /set "CWD=D:\\UGit\\Input-Kanban"/);
  assert.match(cmd, /set "HELPER=%OUT_DIR%\\run-cmd-helper\.mjs"/);
  assert.match(cmd, /cmd\.exe \/d \/k/);

  const bash = buildRunScript({
    backend: { resolved: 'posix', scriptKind: 'bash', command: 'bash' },
    codexCommand: '/usr/local/bin/codex',
    codexArgsPrefix: ['/opt/codex/bin/codex.js'],
    sandbox: 'workspace-write',
    cwd: '/tmp/input-kanban',
    outDir: '/tmp/input-kanban/.runs/planner',
    runId: 'run_backend',
    taskId: 'planner',
    role: 'planner'
  });
  assert.match(bash, /CODEX_LAUNCHER=\('\/usr\/local\/bin\/codex' '\/opt\/codex\/bin\/codex\.js'\)/);
  assert.match(bash, /CWD='\/tmp\/input-kanban'/);
  assert.match(bash, /OUT_DIR='\/tmp\/input-kanban\/\.runs\/planner'/);
  assert.match(bash, /FORMATTER_BIN='/);
});

test('default runner selects tmux only when requested', () => {
  assert.equal(createDefaultRunner('headless'), headlessRunner);
  assert.equal(createDefaultRunner('tmux').kind, 'tmux');
});

test('tmux stop kills only the exact input-kanban run session', async () => {
  const { calls, runner: commandRunner } = makeRunner((_command, args) => {
    if (args[0] === '-V') return { code: 0, stdout: 'tmux 3.4\n' };
    if (args[0] === 'has-session') return { code: 0, stdout: '' };
    return { code: 0, stdout: '' };
  });
  const runner = createTmuxRunner({ tmuxOptions: { runner: commandRunner } });

  await runner.stopRun('run_20260608T174108Z_tmux-support_6fc244');

  assert.deepEqual(calls.map(call => call.args), [
    ['-V'],
    ['has-session', '-t', 'input-kanban-run_20260608T174108Z_tmux-support_6fc244'],
    ['-V'],
    ['kill-session', '-t', 'input-kanban-run_20260608T174108Z_tmux-support_6fc244']
  ]);
});

test('tmux stop tolerates already-missing matching session', async () => {
  const { calls, runner: commandRunner } = makeRunner((_command, args) => {
    if (args[0] === '-V') return { code: 0, stdout: 'tmux 3.4\n' };
    return { code: 1, stderr: 'no such session' };
  });
  const runner = createTmuxRunner({ tmuxOptions: { runner: commandRunner } });

  await runner.stopRun('missing-run');

  assert.deepEqual(calls.map(call => call.args), [
    ['-V'],
    ['has-session', '-t', 'input-kanban-missing-run']
  ]);
});

test('tmux runner writes run script, metadata, and observes exit_code', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-tmux-runner-'));
  const outDir = path.join(tmp, 'planner');
  const { calls, runner: commandRunner } = makeRunner((_command, args) => {
    if (args[0] === '-V') return { code: 0, stdout: 'tmux 3.4\n' };
    if (args[0] === 'has-session') return { code: 1, stderr: 'no such session' };
    if (args[0] === 'split-window') return { code: 0, stdout: '%12\n' };
    return { code: 0, stdout: '' };
  });
  const runner = createTmuxRunner({
    codexBin: '/usr/local/bin/codex',
    tmuxOptions: { runner: commandRunner },
    pollMs: 100
  });

  const handle = await runner.startCodexTask({
    runId: 'run_01',
    taskId: 'planner',
    batchId: 'planner',
    runStatePath: path.join(tmp, 'run_state.json'),
    prompt: 'plan this',
    sandbox: 'read-only',
    cwd: tmp,
    outDir
  });
  try {
    assert.equal(runner.hasRunning('run_01', 'planner'), true);
    assert.equal(await fsp.readFile(path.join(outDir, 'prompt.md'), 'utf8'), 'plan this');

    const metadata = JSON.parse(await fsp.readFile(path.join(outDir, 'tmux.json'), 'utf8'));
    const script = await fsp.readFile(metadata.runScript, 'utf8');
    if (metadata.tmuxShell.scriptKind === 'bash') {
      assert.match(script, /CODEX_LAUNCHER=\('\/usr\/local\/bin\/codex'\)/);
      assert.match(script, /SKIP_GIT_REPO_CHECK=''/);
      assert.match(script, /"\$\{CODEX_LAUNCHER\[@\]\}" exec \$\{SKIP_GIT_REPO_CHECK:\+"\$SKIP_GIT_REPO_CHECK"\} --json --sandbox/);
      assert.doesNotMatch(script, /CODEX_BIN=/);
      assert.match(script, /touch "\$EVENTS" "\$TIMED_EVENTS" "\$STDERR_LOG"/);
      assert.match(script, /FORMATTER_BIN='/);
      assert.match(script, /TIMESTAMP_BIN='/);
      assert.match(script, />> "\$EVENTS" 2> >\(tee -a "\$STDERR_LOG" >&2\)/);
      assert.match(script, /node "\$TIMESTAMP_BIN" --timed-only "\$EVENTS" "\$TIMED_EVENTS" < "\$EVENTS" \| node "\$FORMATTER_BIN"/);
      assert.match(script, /printf '%s' "\$code" > "\$EXIT_CODE"/);
      assert.match(script, /RUN_ID='run_01'/);
      assert.match(script, /TASK_ID='planner'/);
      assert.match(script, /ROLE='planner'/);
      assert.match(script, /Type exit or press Ctrl-D to close this tmux window/);
      assert.match(script, /exec "\$\{SHELL:-\/bin\/sh\}" -i/);
      assert.ok(script.indexOf(`printf '%s' "$code" > "$EXIT_CODE"`) < script.indexOf('Input Kanban tmux task completed'));
      assert.ok(script.indexOf('Input Kanban tmux task completed') < script.indexOf('exec "${SHELL:-/bin/sh}" -i'));
    } else if (metadata.tmuxShell.scriptKind === 'powershell') {
      assert.match(script, /\$CodexLauncher = @\('\/usr\/local\/bin\/codex'\)/);
      assert.match(script, /\$SkipGitRepoCheck = @\(\)/);
      assert.match(script, /\$Helper = Join-Path \$OutDir 'run-powershell-helper\.mjs'/);
      assert.match(script, /node \$Helper 1>> \$Events 2>> \$StderrLog/);
      assert.match(script, /Input Kanban tmux task completed/);
    } else {
      assert.match(script, /set "HELPER=%OUT_DIR%\\run-cmd-helper\.mjs"/);
      assert.match(script, /node "%HELPER%" 1>> "%EVENTS%" 2>> "%STDERR_LOG%"/);
      assert.match(script, /Input Kanban tmux task completed/);
    }

    assert.equal(metadata.type, 'input_kanban_tmux_task');
    assert.equal(metadata.runner, 'tmux');
    assert.equal(metadata.ready, true);
    assert.equal(metadata.status, 'ready');
    assert.equal(metadata.sessionName, 'input-kanban-run_01');
    assert.equal(metadata.windowName, 'planner');
    assert.equal(metadata.target, 'input-kanban-run_01:planner');
    assert.equal(metadata.attachCommand, 'tmux attach-session -t input-kanban-run_01');
    assert.equal(metadata.selectWindowCommand, 'tmux select-window -t input-kanban-run_01:planner');
    assert.equal(metadata.selectCommand, metadata.selectWindowCommand);
    assert.equal(metadata.paneId, '%12');
    assert.equal(metadata.paneTarget, '%12');
    const paneJoiner = metadata.tmuxShell.scriptKind === 'cmd' ? ' & ' : '; ';
    assert.equal(metadata.selectPaneCommand, `tmux select-window -t input-kanban-run_01:planner${paneJoiner}tmux select-pane -t %12`);
    assert.equal(metadata.paneCommand, metadata.selectPaneCommand);
    assert.equal(metadata.attachPaneCommand, `tmux select-window -t input-kanban-run_01:planner${paneJoiner}tmux select-pane -t %12${paneJoiner}tmux attach-session -t input-kanban-run_01`);
    assert.ok(metadata.readyAt);

    assert.deepEqual(calls[0].args, ['-V']);
    assert.deepEqual(calls[1].args, ['has-session', '-t', 'input-kanban-run_01']);
    assert.deepEqual(calls[2].args, ['-V']);
    assert.deepEqual(calls[3].args.slice(0, -1), ['new-session', '-d', '-s', 'input-kanban-run_01', '-n', 'planner', '-c', tmp]);
    assert.deepEqual(calls[4].args, ['-V']);
    assert.deepEqual(calls[6].args, ['-V']);
    assert.match(calls[3].args.at(-1), /input-kanban-tmux-overview\.js/);
    assert.match(calls[3].args.at(-1), /run_state\.json/);
    assert.deepEqual(calls[5].args.slice(0, 8), ['split-window', '-t', 'input-kanban-run_01:planner', '-v', '-P', '-F', '#{pane_id}', '-c']);
    assert.equal(calls[5].args[8], tmp);
    if (metadata.tmuxShell.scriptKind === 'powershell' || metadata.tmuxShell.scriptKind === 'cmd') {
      assert.deepEqual(calls[7].args.slice(0, 4), ['send-keys', '-t', '%12', '-l']);
      assert.match(calls[7].args.at(-1), /run\.(ps1|cmd)/);
      assert.deepEqual(calls[9].args, ['send-keys', '-t', '%12', 'C-m']);
      assert.deepEqual(calls[11].args, ['select-layout', '-t', 'input-kanban-run_01:planner', 'tiled']);
    } else {
      assert.equal(calls[5].args.at(-1), metadata.runScript);
      assert.deepEqual(calls[7].args, ['select-layout', '-t', 'input-kanban-run_01:planner', 'tiled']);
      assert.equal(calls.some(call => call.args.includes('send-keys')), false);
    }
  } finally {
    await finishTmuxHandle(handle, outDir);
  }
  assert.equal(runner.hasRunning('run_01', 'planner'), false);
});

test('tmux run script quotes codex launcher arrays with spaces and shell characters', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-tmux-quote-'));
  const outDir = path.join(tmp, 'planner');
  const codexStub = path.join(tmp, "Codex Dir", "codex user's stub.js");
  await fsp.mkdir(path.dirname(codexStub), { recursive: true });
  await fsp.writeFile(codexStub, 'console.log("codex");\n');
  const { runner: commandRunner } = makeRunner((_command, args) => {
    if (args[0] === '-V') return { code: 0, stdout: 'tmux 3.4\n' };
    if (args[0] === 'has-session') return { code: 1, stderr: 'no such session' };
    if (args[0] === 'split-window') return { code: 0, stdout: '%13\n' };
    return { code: 0, stdout: '' };
  });
  const runner = createTmuxRunner({
    codexBin: codexStub,
    tmuxOptions: { runner: commandRunner },
    pollMs: 20
  });

  const handle = await runner.startCodexTask({
    runId: 'run_quote',
    taskId: 'planner',
    prompt: 'plan this',
    sandbox: 'read-only',
    cwd: tmp,
    outDir
  });

  try {
    const metadata = JSON.parse(await fsp.readFile(path.join(outDir, 'tmux.json'), 'utf8'));
    const script = await fsp.readFile(metadata.runScript, 'utf8');
    if (metadata.tmuxShell.scriptKind === 'bash') {
      assert.match(script, /CODEX_LAUNCHER=\('/);
      assert.match(script, /codex user'\\''s stub\.js/);
      assert.match(script, /"\$\{CODEX_LAUNCHER\[@\]\}" exec \$\{SKIP_GIT_REPO_CHECK:\+"\$SKIP_GIT_REPO_CHECK"\} --json --sandbox/);
    } else if (metadata.tmuxShell.scriptKind === 'powershell') {
      assert.match(script, /\$CodexLauncher = @\(/);
      assert.match(script, /codex user''s stub\.js/);
    } else {
      assert.match(script, /run-cmd-helper\.mjs/);
    }
  } finally {
    await finishTmuxHandle(handle, outDir);
  }
});

test('tmux runner records failed metadata without ready commands when tmux creation fails', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-tmux-failed-metadata-'));
  const outDir = path.join(tmp, 'planner');
  const { runner: commandRunner } = makeRunner((_command, args) => {
    if (args[0] === '-V') return { code: 0, stdout: 'tmux 3.4\n' };
    if (args[0] === 'has-session') return { code: 1, stderr: 'no such session' };
    if (args[0] === 'new-session') return { code: 1, stderr: 'Operation not permitted' };
    return { code: 0, stdout: '' };
  });
  const runner = createTmuxRunner({
    codexBin: '/usr/local/bin/codex',
    tmuxOptions: { runner: commandRunner },
    pollMs: 20
  });

  await assert.rejects(
    () => runner.startCodexTask({
      runId: 'run_failed_metadata',
      taskId: 'planner',
      prompt: 'plan this',
      sandbox: 'read-only',
      cwd: tmp,
      outDir
    }),
    /Operation not permitted/
  );

  const metadata = JSON.parse(await fsp.readFile(path.join(outDir, 'tmux.json'), 'utf8'));
  assert.equal(metadata.runner, 'tmux');
  assert.equal(metadata.ready, false);
  assert.equal(metadata.status, 'failed');
  assert.match(metadata.error, /Operation not permitted/);
  assert.equal(metadata.attachCommand, undefined);
  assert.equal(metadata.selectWindowCommand, undefined);
});

test('tmux run script keep-open summary is generated for worker and judge roles', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-tmux-roles-'));
  const { runner: commandRunner } = makeRunner((_command, args) => {
    if (args[0] === '-V') return { code: 0, stdout: 'tmux 3.4\n' };
    if (args[0] === 'has-session') return { code: 0, stdout: '' };
    if (args[0] === 'split-window') return { code: 0, stdout: '%14\n' };
    return { code: 0, stdout: '' };
  });
  const runner = createTmuxRunner({
    codexBin: '/usr/local/bin/codex',
    tmuxOptions: { runner: commandRunner },
    pollMs: 20
  });

  for (const taskId of ['T-01', 'judge']) {
    const outDir = path.join(tmp, taskId);
    const handle = await runner.startCodexTask({
      runId: 'run_roles',
      taskId,
      prompt: `prompt for ${taskId}`,
      sandbox: 'read-only',
      cwd: tmp,
      outDir
    });
    try {
      const metadata = JSON.parse(await fsp.readFile(path.join(outDir, 'tmux.json'), 'utf8'));
      const script = await fsp.readFile(metadata.runScript, 'utf8');
      const expectedRole = taskId === 'judge' ? 'judge' : 'worker';
      if (metadata.tmuxShell.scriptKind === 'bash') {
        assert.match(script, new RegExp(`RUN_ID='run_roles'`));
        assert.match(script, new RegExp(`TASK_ID='${taskId}'`));
        assert.match(script, new RegExp(`ROLE='${expectedRole}'`));
        assert.match(script, /Type exit or press Ctrl-D to close this tmux window/);
        assert.ok(script.indexOf(`printf '%s' "$code" > "$EXIT_CODE"`) < script.indexOf('Input Kanban tmux task completed'));
      } else if (metadata.tmuxShell.scriptKind === 'powershell') {
        assert.match(script, /\$RunId = 'run_roles'/);
        assert.match(script, new RegExp(`\\$TaskId = '${taskId}'`));
        assert.match(script, new RegExp(`\\$Role = '${expectedRole}'`));
        assert.match(script, /Type exit to close this tmux window/);
      } else {
        assert.match(script, /set "RUN_ID=run_roles"/);
        assert.match(script, new RegExp(`set "TASK_ID=${taskId}"`));
        assert.match(script, new RegExp(`set "ROLE=${expectedRole}"`));
        assert.match(script, /Type exit to close this tmux window/);
      }
    } finally {
      await finishTmuxHandle(handle, outDir);
    }
  }
});

test('tmux runner can include Codex git repo check bypass in run script', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-tmux-skip-git-'));
  const outDir = path.join(tmp, 'planner');
  const { runner: commandRunner } = makeRunner((_command, args) => {
    if (args[0] === '-V') return { code: 0, stdout: 'tmux 3.4\n' };
    if (args[0] === 'has-session') return { code: 1, stderr: 'no such session' };
    if (args[0] === 'split-window') return { code: 0, stdout: '%15\n' };
    return { code: 0, stdout: '' };
  });
  const runner = createTmuxRunner({
    codexBin: '/usr/local/bin/codex',
    tmuxOptions: { runner: commandRunner },
    pollMs: 100
  });

  const handle = await runner.startCodexTask({
    runId: 'run_skip_git',
    taskId: 'planner',
    batchId: 'planner',
    runStatePath: path.join(tmp, 'run_state.json'),
    prompt: 'plan this',
    sandbox: 'read-only',
    cwd: tmp,
    outDir,
    skipGitRepoCheck: true
  });

  try {
    const metadata = JSON.parse(await fsp.readFile(path.join(outDir, 'tmux.json'), 'utf8'));
    const script = await fsp.readFile(metadata.runScript, 'utf8');
    if (metadata.tmuxShell.scriptKind === 'bash') {
      assert.match(script, /SKIP_GIT_REPO_CHECK='--skip-git-repo-check'/);
      assert.match(script, /exec \$\{SKIP_GIT_REPO_CHECK:\+"\$SKIP_GIT_REPO_CHECK"\} --json --sandbox/);
    } else if (metadata.tmuxShell.scriptKind === 'powershell') {
      assert.match(script, /\$SkipGitRepoCheck = @\('--skip-git-repo-check'\)/);
    } else {
      assert.match(script, /run-cmd-helper\.mjs/);
    }
  } finally {
    await finishTmuxHandle(handle, outDir);
  }
});

test('headless runner passes Codex git repo check bypass when requested', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-headless-skip-git-'));
  const outDir = path.join(tmp, 'worker');
  const argvFile = path.join(tmp, 'argv.json');
  const codexStub = path.join(tmp, 'codex-stub.js');
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(codexStub, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`);
  await fsp.chmod(codexStub, 0o755);
  const runner = createHeadlessRunner({ codexBin: codexStub });

  const handle = runner.startCodexTask({
    runId: 'run_headless_skip_git',
    taskId: 'T-01',
    prompt: 'headless prompt',
    sandbox: 'read-only',
    cwd: tmp,
    outDir,
    skipGitRepoCheck: true
  });
  const exitCode = await new Promise(resolve => handle.onExit(resolve));

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(await fsp.readFile(argvFile, 'utf8')).slice(0, 4), ['exec', '--skip-git-repo-check', '--json', '--sandbox']);
});

test('headless runner does not generate tmux keep-open run script', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-headless-runner-'));
  const outDir = path.join(tmp, 'worker');
  const codexStub = path.join(tmp, 'codex-stub.js');
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(codexStub, 'process.stdout.write(JSON.stringify({ type: "session.created" }) + "\\n");\n');
  const runner = createHeadlessRunner({ codexBin: codexStub });

  const handle = runner.startCodexTask({
    runId: 'run_headless',
    taskId: 'T-01',
    prompt: 'headless prompt',
    sandbox: 'read-only',
    cwd: tmp,
    outDir
  });
  const exitCode = await new Promise(resolve => handle.onExit(resolve));

  assert.equal(exitCode, 0);
  assert.equal(await fsp.readFile(path.join(outDir, 'prompt.md'), 'utf8'), 'headless prompt');
  await assert.rejects(() => fsp.readFile(path.join(outDir, 'run.sh'), 'utf8'), { code: 'ENOENT' });
  const events = await fsp.readFile(path.join(outDir, 'events.jsonl'), 'utf8');
  assert.doesNotMatch(events, /Type exit or press Ctrl-D to close this tmux window/);
  const timedEvents = await fsp.readFile(path.join(outDir, 'events_timed.jsonl'), 'utf8');
  assert.match(timedEvents, /"receivedAt"/);
  assert.equal(await fsp.readFile(path.join(outDir, 'exit_code'), 'utf8'), '0');
});

test('headless runner records spawn failures for missing custom launcher', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-headless-spawn-fail-'));
  const outDir = path.join(tmp, 'worker');
  await fsp.mkdir(outDir, { recursive: true });
  const runner = createHeadlessRunner({ codexBin: 'input-kanban-missing-codex-bin' });

  const handle = runner.startCodexTask({
    runId: 'run_spawn_fail',
    taskId: 'T-01',
    prompt: 'headless prompt',
    sandbox: 'read-only',
    cwd: tmp,
    outDir
  });
  const exitCode = await new Promise(resolve => handle.onExit(resolve));

  assert.equal(handle.pid, null);
  assert.equal(exitCode, 127);
  assert.equal(await fsp.readFile(path.join(outDir, 'exit_code'), 'utf8'), '127');
  assert.match(await fsp.readFile(path.join(outDir, 'stderr.log'), 'utf8'), /input-kanban-missing-codex-bin|ENOENT|not found/i);
});
