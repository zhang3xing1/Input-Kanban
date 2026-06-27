import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CODEX_BIN } from '../utils.js';
import { resolveCodexLauncher } from '../codexLauncher.js';

export function codexTaskPaths(outDir) {
  return {
    prompt: path.join(outDir, 'prompt.md'),
    events: path.join(outDir, 'events.jsonl'),
    timedEvents: path.join(outDir, 'events_timed.jsonl'),
    stderr: path.join(outDir, 'stderr.log'),
    lastMessage: path.join(outDir, 'last_message.md'),
    exitCode: path.join(outDir, 'exit_code'),
    runScript: path.join(outDir, 'run.sh'),
    tmuxMetadata: path.join(outDir, 'tmux.json')
  };
}

export function buildCodexExecArgs({ prompt, sandbox, cwd, lastMessagePath, skipGitRepoCheck = false }) {
  return [
    'exec',
    ...(skipGitRepoCheck ? ['--skip-git-repo-check'] : []),
    '--json',
    '--sandbox', sandbox,
    '-C', cwd,
    '-o', lastMessagePath,
    prompt
  ];
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function bashArrayAssignment(name, values) {
  return `${name}=(${values.map(value => shellQuote(value)).join(' ')})`;
}

export function buildCodexTmuxRunScript({ codexCommand, codexArgsPrefix = [], formatterBin, timestampBin, sandbox, cwd, outDir, runId, taskId, role, skipGitRepoCheck = false }) {
  const codexLauncher = bashArrayAssignment('CODEX_LAUNCHER', [codexCommand, ...codexArgsPrefix]);
  const skipGitRepoCheckArg = skipGitRepoCheck ? "SKIP_GIT_REPO_CHECK='--skip-git-repo-check'" : "SKIP_GIT_REPO_CHECK=''";
  return `#!/usr/bin/env bash
set -u

${codexLauncher}
${skipGitRepoCheckArg}
SANDBOX=${shellQuote(sandbox)}
CWD=${shellQuote(cwd)}
OUT_DIR=${shellQuote(outDir)}
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
"\${CODEX_LAUNCHER[@]}" exec \${SKIP_GIT_REPO_CHECK:+"$SKIP_GIT_REPO_CHECK"} --json --sandbox "$SANDBOX" -C "$CWD" -o "$LAST_MESSAGE" "$(<"$PROMPT_FILE")" > >(node "$TIMESTAMP_BIN" "$EVENTS" "$TIMED_EVENTS" | node "$FORMATTER_BIN") 2> >(tee -a "$STDERR_LOG" >&2)
code=$?
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

export function createCodexExecutor({ codexBin = CODEX_BIN } = {}) {
  function launcher() {
    return resolveCodexLauncher(codexBin);
  }

  function prepareHeadlessTask({ prompt, sandbox, cwd, outDir, skipGitRepoCheck = false }) {
    const paths = codexTaskPaths(outDir);
    fs.writeFileSync(paths.prompt, prompt);
    const { command, argsPrefix } = launcher();
    return {
      kind: 'codex',
      paths,
      command,
      args: [...argsPrefix, ...buildCodexExecArgs({ prompt, sandbox, cwd, lastMessagePath: paths.lastMessage, skipGitRepoCheck })]
    };
  }

  async function prepareTmuxTask({ prompt, formatterBin, timestampBin, sandbox, cwd, outDir, runId, taskId, role, skipGitRepoCheck = false }) {
    const paths = codexTaskPaths(outDir);
    await fsp.writeFile(paths.prompt, prompt);
    const { command: codexCommand, argsPrefix: codexArgsPrefix } = launcher();
    await fsp.writeFile(paths.runScript, buildCodexTmuxRunScript({
      codexCommand,
      codexArgsPrefix,
      formatterBin,
      timestampBin,
      sandbox,
      cwd,
      outDir,
      runId,
      taskId,
      role,
      skipGitRepoCheck
    }));
    await fsp.chmod(paths.runScript, 0o755);
    return { kind: 'codex', paths };
  }

  return { kind: 'codex', codexBin, prepareHeadlessTask, prepareTmuxTask };
}

export const codexExecutor = createCodexExecutor();
