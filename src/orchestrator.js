import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  DEFAULT_WORKSPACE, DEFAULT_REPO, RUNS_DIR, ensureDir, nowIso, makeRunId, readJson,
  writeJsonAtomic, fileInfo, readTextMaybe, extractFirstJsonObject, listRunDirs,
  pathForRun, roleDir, safeIdPart, normalizeRunner, normalizeWorkerBackend
} from './utils.js';
import { matchThreadToMarkers } from './appServerClient.js';
import { formatCodexEventsJsonl } from './eventFormatter.js';
import { createDefaultRunner } from './runners/index.js';
import { effectiveRunner } from './config.js';
import { detectTmuxDependency } from './deps.js';
import { normalizeTmuxShellConfig } from './tmuxShell.js';
import { isAutoAdvanceableRunStatus, isFailureRunStatus, isTerminalRunStatus } from './status.js';
import { tmuxHasSession } from './tmux.js';

const execFileAsync = promisify(execFile);
const runnerCache = new Map(); // Bounded by normalizeRunner/VALID_RUNNERS and tmux shell choices.
const VALID_SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const MISSING_RUNNER_GRACE_MS = 10000;
const MAX_DERIVED_LABEL_DISPLAY_WIDTH = 40;
const RUN_STATE_LOCK_NAME = 'run_state.lock';
const RUN_STATE_LOCK_STALE_MS = 30000;
const RUN_STATE_LOCK_TIMEOUT_MS = 30000;
const LEGACY_DEFAULT_RUNNER = 'headless';
const CODEX_TRUST_DIRECTORY_PATTERN = /Not inside a trusted directory and --skip-git-repo-check was not specified/i;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function assertWorkerBackendCompatible(runnerMode, workerBackend) {
  if (runnerMode === 'tmux' && workerBackend === 'pi') {
    const error = new Error('pi worker backend currently supports headless runner only; choose headless runner or Codex worker backend');
    error.statusCode = 400;
    throw error;
  }
}

async function assertRunnerDependencies(runnerMode, { tmuxShell = 'auto', tmuxDependencyChecker = detectTmuxDependency } = {}) {
  if (runnerMode !== 'tmux') return;
  const tmux = await tmuxDependencyChecker({ tmuxShell });
  if (!tmux.installed) {
    const error = new Error('tmux runner requires tmux to be installed');
    error.statusCode = 400;
    error.tmux = tmux;
    throw error;
  }
  if (!tmux.shellAvailable) {
    const error = new Error(`tmux runner requires a usable shell backend: ${tmux.shell?.reason || 'shell backend unavailable'}`);
    error.statusCode = 400;
    error.tmux = tmux;
    throw error;
  }
}

function normalizeSandbox(value, fallback = 'workspace-write') {
  const sandbox = String(value || '').trim();
  if (VALID_SANDBOXES.has(sandbox)) return sandbox;
  return fallback;
}

function statePath(runDir) { return path.join(runDir, 'run_state.json'); }
function planPath(runDir) { return path.join(runDir, 'plan.json'); }
function lockPath(runDir) { return path.join(runDir, RUN_STATE_LOCK_NAME); }
function workspacePathOf(state) { return path.resolve(state?.workspacePath || state?.repo || DEFAULT_WORKSPACE || DEFAULT_REPO); }
function workspaceNameOf(state) { return state?.workspaceName || path.basename(workspacePathOf(state)) || workspacePathOf(state); }
function addRunWarning(state, warning) {
  const warnings = Array.isArray(state.warnings) ? state.warnings : [];
  if (!warnings.some(item => item?.kind === warning.kind)) warnings.push({ ...warning, createdAt: nowIso() });
  state.warnings = warnings;
}
function jobWorkspaceRef(state) {
  const workspacePath = workspacePathOf(state);
  return {
    type: 'localPath',
    path: workspacePath,
    name: state?.workspaceName || path.basename(workspacePath || ''),
    git: state?.git || state?.workspace?.git || null
  };
}
function jobSecurityPolicy(state, sandbox) {
  return {
    sandbox,
    network: 'inherit',
    secrets: [],
    allowedPaths: [workspacePathOf(state)],
    maxRuntimeMs: null,
    codexSkipGitRepoCheck: !!state?.codexSkipGitRepoCheck
  };
}
function jobRetryMetadata(task) {
  const retryCount = Number(task?.retryCount || 0);
  if (!retryCount) return null;
  const history = Array.isArray(task.retryHistory) ? task.retryHistory : [];
  const last = history.at(-1) || null;
  return { retryCount, retryOfAttempt: retryCount, lastReason: last?.reason || null, history };
}
async function hasCodexTrustDirectoryError(dir) {
  const stderr = await readTextMaybe(path.join(dir, 'stderr.log'), 20000);
  return CODEX_TRUST_DIRECTORY_PATTERN.test(stderr || '');
}
function runnerForMode(mode = LEGACY_DEFAULT_RUNNER, { workerBackend = process.env.KANBAN_WORKER_BACKEND || process.env.KANBAN_AGENT_BACKEND || 'codex', tmuxShell = 'auto' } = {}) {
  const normalized = normalizeRunner(mode || LEGACY_DEFAULT_RUNNER, 'runner');
  const normalizedWorkerBackend = normalizeWorkerBackend(workerBackend, 'KANBAN_WORKER_BACKEND');
  const normalizedTmuxShell = normalized === 'tmux' ? normalizeTmuxShellConfig(tmuxShell, 'tmuxShell', { fallback: 'auto' }) : '';
  const cacheKey = `${normalized}:${normalizedWorkerBackend}:${normalizedTmuxShell}`;
  if (!runnerCache.has(cacheKey)) runnerCache.set(cacheKey, createDefaultRunner(normalized, { workerBackend: normalizedWorkerBackend, tmuxShell: normalizedTmuxShell }));
  return runnerCache.get(cacheKey);
}
function runnerForState(state) {
  return runnerForMode(state?.runner || LEGACY_DEFAULT_RUNNER, {
    workerBackend: state?.workerBackend || process.env.KANBAN_WORKER_BACKEND || process.env.KANBAN_AGENT_BACKEND || 'codex',
    tmuxShell: state?.tmuxShell || 'auto'
  });
}

function agentBackendForRole(state, role) {
  if (role !== 'worker') return 'codex';
  const runner = normalizeRunner(state?.runner || LEGACY_DEFAULT_RUNNER, 'runner');
  if (runner !== 'headless') return 'codex';
  return normalizeWorkerBackend(state?.workerBackend || 'codex', 'workerBackend');
}

function applyRunAgentBackends(state) {
  if (!state) return state;
  if (state.planner) state.planner.agentBackend = agentBackendForRole(state, 'planner');
  if (state.judge) state.judge.agentBackend = agentBackendForRole(state, 'judge');
  for (const task of state.tasks || []) task.agentBackend = agentBackendForRole(state, 'worker');
  for (const batch of state.batches || []) {
    for (const task of batch.tasks || []) task.agentBackend = agentBackendForRole(state, 'worker');
  }
  return state;
}
async function resolveRunRunner(requestedRunner) {
  if (process.env.KANBAN_RUNNER) {
    const envRunner = normalizeRunner(process.env.KANBAN_RUNNER, 'KANBAN_RUNNER');
    if (requestedRunner) {
      const normalizedRequest = normalizeRunner(requestedRunner, 'runner');
      if (normalizedRequest !== envRunner) {
        const error = new Error(`KANBAN_RUNNER is set to ${envRunner}; requested runner ${normalizedRequest} is not allowed`);
        error.statusCode = 400;
        throw error;
      }
    }
    return envRunner;
  }
  return requestedRunner ? normalizeRunner(requestedRunner, 'runner') : await effectiveRunner();
}

async function resolveRunTmuxShell(requestedTmuxShell) {
  return requestedTmuxShell ? normalizeTmuxShellConfig(requestedTmuxShell, 'tmuxShell') : 'auto';
}
async function detectWorkspaceMetadata(workspacePath) {
  const resolvedWorkspace = path.resolve(workspacePath || DEFAULT_WORKSPACE || DEFAULT_REPO || process.cwd());
  const metadata = {
    path: resolvedWorkspace,
    name: path.basename(resolvedWorkspace) || resolvedWorkspace,
    isGit: false
  };
  try {
    const { stdout: rootStdout } = await execFileAsync('git', ['-C', resolvedWorkspace, 'rev-parse', '--show-toplevel'], { timeout: 5000 });
    const gitRoot = rootStdout.trim();
    if (gitRoot) {
      metadata.isGit = true;
      metadata.gitRoot = gitRoot;
      try {
        const { stdout: branchStdout } = await execFileAsync('git', ['-C', resolvedWorkspace, 'branch', '--show-current'], { timeout: 5000 });
        metadata.branch = branchStdout.trim() || 'detached';
      } catch {
        metadata.branch = 'unknown';
      }
      try {
        const { stdout: dirtyStdout } = await execFileAsync('git', ['-C', resolvedWorkspace, 'status', '--porcelain'], { timeout: 5000 });
        metadata.dirty = dirtyStdout.trim().length > 0;
      } catch {
        metadata.dirty = null;
      }
    }
  } catch {}
  return metadata;
}
async function assertWorkspacePath(workspace) {
  const resolvedWorkspace = path.resolve(workspace || DEFAULT_WORKSPACE || DEFAULT_REPO || process.cwd());
  let stat;
  try { stat = await fsp.stat(resolvedWorkspace); }
  catch { throw userInputError(`workspace does not exist: ${resolvedWorkspace}`); }
  if (!stat.isDirectory()) throw userInputError(`workspace is not a directory: ${resolvedWorkspace}`);
  return resolvedWorkspace;
}
function normalizeWorkspaceState(state) {
  const workspacePath = path.resolve(state?.workspacePath || state?.repo || DEFAULT_WORKSPACE || DEFAULT_REPO);
  const workspaceName = state.workspaceName || path.basename(workspacePath) || workspacePath;
  const git = state.git || state.workspace?.git || null;
  state.workspacePath = workspacePath;
  state.workspaceName = workspaceName;
  state.repo = state.repo || workspacePath;
  state.git = git;
  state.workspace = state.workspace || {
    path: workspacePath,
    name: workspaceName,
    git
  };
  if (!state.workspace.git && git) state.workspace.git = git;
  return state;
}

async function isStaleRunLock(lockFile, staleMs = RUN_STATE_LOCK_STALE_MS) {
  const info = await fileInfo(lockFile);
  if (!info.exists) return false;
  const modifiedAt = Date.parse(info.mtime || '');
  if (!Number.isFinite(modifiedAt)) return true;
  if (Date.now() - modifiedAt < staleMs) return false;
  const lockData = await readJson(lockFile, null);
  const pid = Number(lockData?.pid);
  if (!Number.isFinite(pid) || pid <= 0) return true;
  return !isPidAlive(pid);
}

export async function acquireRunStateLock(runId, { timeoutMs = RUN_STATE_LOCK_TIMEOUT_MS, staleMs = RUN_STATE_LOCK_STALE_MS } = {}) {
  const runDir = pathForRun(runId);
  await ensureDir(runDir);
  const lockFile = lockPath(runDir);
  const startedAt = Date.now();
  let waitMs = 50;
  while (true) {
    try {
      const handle = await fsp.open(lockFile, 'wx');
      try {
        await handle.writeFile(JSON.stringify({ runId, pid: process.pid, createdAt: nowIso() }, null, 2));
        await handle.sync().catch(() => {});
      } catch (error) {
        await handle.close().catch(() => {});
        await fsp.unlink(lockFile).catch(() => {});
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try { await handle.close(); } catch {}
        await fsp.unlink(lockFile).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (await isStaleRunLock(lockFile, staleMs)) {
        await fsp.unlink(lockFile).catch(() => {});
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) throw new Error(`run state lock busy: ${runId}`);
      await sleep(waitMs);
      waitMs = Math.min(waitMs * 1.5, 1000);
    }
  }
}

async function withRunStateLock(runId, fn, options = {}) {
  const release = await acquireRunStateLock(runId, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}

function logAsyncRunStateUpdateError(runId, role, error) {
  const message = error?.message || String(error || 'unknown error');
  console.error(`Input Kanban ${role} state update failed for ${runId}: ${message}`);
}
function isRunStateLockBusyError(error) {
  return /run state lock busy/i.test(error?.message || String(error || ''));
}

function shouldMarkRunnerUnknown(target) {
  const missingSince = Date.parse(target.missingRunnerAt || '');
  if (!Number.isFinite(missingSince)) {
    target.missingRunnerAt = nowIso();
    return false;
  }
  return Date.now() - missingSince >= MISSING_RUNNER_GRACE_MS;
}

function clearMissingRunner(target) {
  delete target.missingRunnerAt;
}

function isPidAlive(pid) {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function hasDurableTmuxSession(state, target, options = {}) {
  const tmux = target?.tmux;
  if ((state.runner || LEGACY_DEFAULT_RUNNER) !== 'tmux' && tmux?.runner !== 'tmux') return false;
  const sessionName = tmux?.sessionName || tmux?.target?.split(':')[0] || state.tmux?.tmuxSessionName || '';
  if (!sessionName) return false;
  const cache = options.tmuxSessionStatusCache;
  if (cache?.has(sessionName)) return cache.get(sessionName);
  try {
    const sessionChecker = options.tmuxSessionChecker || tmuxHasSession;
    const result = await sessionChecker(sessionName, {});
    cache?.set(sessionName, result);
    return result;
  } catch {
    cache?.set(sessionName, false);
    return false;
  }
}

async function hasLiveRunnerProcess(state, id, target, options = {}) {
  return runnerForState(state).hasRunning(state.runId, id) || isPidAlive(target?.pid) || await hasDurableTmuxSession(state, target, options);
}

function stopPid(pid, signal = 'SIGTERM') {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 0) return false;
  try {
    process.kill(value, signal);
    if (signal !== 'SIGKILL') setTimeout(() => { if (isPidAlive(value)) stopPid(value, 'SIGKILL'); }, 1000).unref?.();
    return true;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

function userInputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function charDisplayWidth(char) {
  return char.codePointAt(0) > 0x2e80 ? 2 : 1;
}

function truncateDisplayWidth(text, maxWidth) {
  let width = 0;
  let result = '';
  for (const char of text) {
    const nextWidth = width + charDisplayWidth(char);
    if (nextWidth > maxWidth) return `${result.trimEnd()}…`;
    result += char;
    width = nextWidth;
  }
  return result;
}

function deriveRunLabel(label, taskText) {
  const explicit = String(label || '').trim();
  if (explicit) return explicit;
  const firstLine = String(taskText || '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || 'task';
  const cleaned = firstLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)、]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateDisplayWidth(cleaned, MAX_DERIVED_LABEL_DISPLAY_WIDTH) || 'task';
}

function normalizePlanApprovalGate(value = false) {
  const required = !!value;
  return { required, approved: !required, approvedAt: null, approvedBy: null };
}

function planApprovalGate(state) {
  return state?.gates?.planApproval || { required: false, approved: true, approvedAt: null, approvedBy: null };
}

function requiresPlanApproval(state) {
  const gate = planApprovalGate(state);
  return !!gate.required && !gate.approved;
}

function approvePlanGate(state, approvedBy = 'local-user') {
  const gate = planApprovalGate(state);
  if (!gate.required || gate.approved) return false;
  state.gates = { ...(state.gates || {}), planApproval: { ...gate, approved: true, approvedAt: nowIso(), approvedBy } };
  return true;
}

export async function createRun({ label = '', taskText = '', workspace = '', repo = DEFAULT_REPO, maxParallel = 3, workerSandbox = 'workspace-write', workerBackend = 'codex', planApproval = false, requiresPlanApproval = false, codexSkipGitRepoCheck = false, runner: runRunner, tmuxShell: runTmuxShell, tmuxDependencyChecker = detectTmuxDependency } = {}) {
  const resolvedWorkspace = await assertWorkspacePath(workspace || repo || DEFAULT_WORKSPACE);
  const workspaceMeta = await detectWorkspaceMetadata(resolvedWorkspace);
  const runLabel = deriveRunLabel(label, taskText);
  const runId = makeRunId(runLabel);
  const runDir = pathForRun(runId);
  const selectedRunner = await resolveRunRunner(runRunner);
  const selectedWorkerBackend = normalizeWorkerBackend(workerBackend, 'KANBAN_WORKER_BACKEND');
  assertWorkerBackendCompatible(selectedRunner, selectedWorkerBackend);
  const selectedTmuxShell = selectedRunner === 'tmux' ? await resolveRunTmuxShell(runTmuxShell) : 'auto';
  await assertRunnerDependencies(selectedRunner, { tmuxShell: selectedTmuxShell, tmuxDependencyChecker });
  await ensureDir(runDir);
  await fsp.writeFile(path.join(runDir, 'task.md'), taskText || '');
  const state = {
    runId,
    label: runLabel,
    workspacePath: resolvedWorkspace,
    workspaceName: workspaceMeta.name,
    workspace: {
      path: resolvedWorkspace,
      name: workspaceMeta.name,
      git: workspaceMeta
    },
    git: workspaceMeta,
    repo: resolvedWorkspace,
    maxParallel: Number(maxParallel) || 3,
    workerSandbox: normalizeSandbox(workerSandbox),
    workerBackend: selectedWorkerBackend,
    codexSkipGitRepoCheck: !!codexSkipGitRepoCheck,
    gates: { planApproval: normalizePlanApprovalGate(planApproval || requiresPlanApproval) },
    runner: selectedRunner,
    tmuxShell: selectedTmuxShell,
    status: 'created', createdAt: nowIso(), updatedAt: nowIso(),
    planner: { status: 'pending' }, batches: [], tasks: [], judge: { status: 'pending' }
  };
  await writeJsonAtomic(statePath(runDir), state);
  return state;
}

function normalizeWorkspaceFilter(workspace) {
  const value = String(workspace || '').trim();
  if (!value || value === 'all') return '';
  return path.resolve(value);
}

function runMatchesWorkspace(run, workspaceFilter) {
  if (!workspaceFilter) return true;
  const runWorkspace = path.resolve(run?.workspacePath || run?.repo || '');
  return runWorkspace === workspaceFilter;
}

export { isFailureRunStatus, isTerminalRunStatus };

function isInvalidStoredRunnerError(error) {
  return error?.code === 'INVALID_RUNNER' && error?.source === 'runner';
}

export async function listRuns({ includeArchived = false, workspace = '' } = {}) {
  const workspaceFilter = normalizeWorkspaceFilter(workspace);
  const dirs = await listRunDirs();
  const rows = [];
  for (const dir of dirs) {
    const runId = path.basename(dir);
    let summary;
    try {
      const s = await loadRun(runId);
      if (!s || (!includeArchived && s.archived)) continue;
      summary = summaryOfRun(s);
    } catch (error) {
      const raw = await readJson(statePath(dir), null);
      if (!includeArchived && raw?.archived) continue;
      summary = summaryOfLoadFailedRun(runId, error, raw);
    }
    if (!runMatchesWorkspace(summary, workspaceFilter)) continue;
    rows.push(summary);
  }
  return rows;
}

export async function loadRun(runId) {
  const state = await readJson(statePath(pathForRun(runId)), null);
  if (state) {
    normalizeWorkspaceState(state);
    state.runner = normalizeRunner(state.runner || LEGACY_DEFAULT_RUNNER, 'runner');
    if (!state.git || typeof state.git.isGit !== 'boolean') {
      const workspaceMeta = await detectWorkspaceMetadata(workspacePathOf(state));
      state.git = workspaceMeta;
      state.workspace = state.workspace || { path: workspacePathOf(state), name: state.workspaceName, git: workspaceMeta };
      state.workspace.git = workspaceMeta;
    }
    ensureBatchShape(state);
    applyRunAgentBackends(state);
  }
  return state;
}

async function saveRun(state) {
  normalizeWorkspaceState(state);
  ensureBatchShape(state);
  state.updatedAt = nowIso();
  await writeJsonAtomic(statePath(pathForRun(state.runId)), state);
  return state;
}

function marker(runId, taskId, role) {
  return `ORCHESTRATOR_RUN_ID: ${runId}\nORCHESTRATOR_TASK_ID: ${taskId}\nORCHESTRATOR_ROLE: ${role}`;
}

function defaultPlannerPrompt(state, taskText) {
  return `${marker(state.runId, 'planner', 'planner')}

You are the planner for a local Codex orchestrator dashboard.
Split the user's task into scoped Codex worker tasks.
Return ONLY one JSON object. No markdown.

Preferred schema with blocking batches:
{
  "batches": [
    {
      "id": "batch-1",
      "name": "first batch name",
      "maxParallel": 3,
      "tasks": [
        {
          "id": "T-01",
          "name": "short name",
          "prompt": "complete worker prompt",
          "sandbox": "${state.workerSandbox || 'workspace-write'}",
          "expectedArtifacts": []
        }
      ]
    }
  ],
  "finalJudgeRequired": true
}

Backward-compatible schema also accepted:
{
  "tasks": [
    {
      "id": "T-01",
      "name": "short name",
      "prompt": "complete worker prompt",
      "sandbox": "${state.workerSandbox || 'workspace-write'}",
      "expectedArtifacts": []
    }
  ]
}

Rules:
- Batches are strict barriers: a later batch must not start before all tasks in earlier batches complete.
- Use batch maxParallel to express whether tasks in the same batch may run concurrently or serially.
- Keep tasks scoped and independently executable.
- Include exact output/artifact expectations in each worker prompt.
- Default worker sandbox for this run is ${state.workerSandbox || 'workspace-write'}; use that sandbox unless a task has a specific safety reason to be stricter.
- If the input already contains task sections, preserve their ids when practical.
- If the input contains structured handoff sections such as Goal, Acceptance Criteria, Expected Artifacts, Context References, Execution Hints, Risks, or Suggested Batches, treat them as the execution contract.
- Do not change the user's goal or acceptance criteria. Convert the contract into safe batches, concrete worker prompts, and expectedArtifacts.
- Use provided expected artifacts and verification notes to make each worker task and the final judge easier to verify.
- If a handoff is incomplete, make conservative assumptions explicit inside worker prompts instead of silently inventing scope.

User task:
${taskText}
`;
}

function defaultJudgePrompt(state, judgeInputPath) {
  return `${marker(state.runId, 'judge', 'judge')}

You are an independent final judge for a Codex orchestrator run.
Use the judge input manifest as the primary source of truth. Inspect additional run artifacts only if needed.
Do not modify files. Return ONLY JSON with:
{
  "verdict": "passed|partial|failed|blocked",
  "completedTasks": [],
  "failedTasks": [],
  "blockedTasks": [],
  "missingArtifacts": [],
  "scopeViolations": [],
  "residualRisk": [],
  "recommendedNextActions": []
}

Judge input manifest: ${judgeInputPath}
Run directory: ${pathForRun(state.runId)}
Original task: ${path.join(pathForRun(state.runId), 'task.md')}
Plan: ${path.join(pathForRun(state.runId), 'plan.json')}
`;
}

export async function startPlanner(runId) {
  return await withRunStateLock(runId, async () => {
    const state = await loadRun(runId);
    if (!state) throw new Error(`run not found: ${runId}`);
    if (state.archived) throw new Error('archived run cannot be planned');
    if (state.status === 'stopped') throw new Error('stopped run cannot be planned; create a new run after modifications');
    if (state.planner.status === 'running') throw new Error('planner already running');
    if (hasStartedExecution(state)) throw new Error('planner retry is allowed only before any worker/judge starts');
    const runDir = pathForRun(runId);
    const previousPlanner = state.planner;
    if (previousPlanner?.status && previousPlanner.status !== 'pending') await rotatePlannerAttempt(state, runDir);
    state.batches = [];
    state.tasks = [];
    state.judge = { status: 'pending' };
    const outDir = roleDir(runDir, 'planner');
    await ensureDir(outDir);
    await fsp.rm(planPath(runDir), { force: true });
    const taskText = await fsp.readFile(path.join(runDir, 'task.md'), 'utf8');
    const prompt = defaultPlannerPrompt(state, taskText);
    const activeRunner = runnerForState(state);
    const plannerAttempt = (state.plannerAttempts?.length || 0) + 1;
    const child = await activeRunner.startAgentTask({ runId: state.runId, taskId: 'planner', batchId: 'planner', runStatePath: statePath(runDir), prompt, sandbox: 'read-only', cwd: workspacePathOf(state), outDir, skipGitRepoCheck: !!state.codexSkipGitRepoCheck, attempt: plannerAttempt, workspace: jobWorkspaceRef(state), security: jobSecurityPolicy(state, 'read-only') });
    state.status = 'planning';
    state.planner = { status: 'running', pid: child.pid, startedAt: nowIso(), dir: outDir, attempt: plannerAttempt };
    await saveRun(state);
    child.onExit(async code => {
      try {
        let shouldRetryWithSkipGitRepoCheck = false;
        await withRunStateLock(runId, async () => {
          const s = await loadRun(runId); if (!s || s.status === 'stopped') return;
          s.planner.exitCode = code; s.planner.endedAt = nowIso(); s.planner.status = code === 0 ? 'completed' : 'failed';
          if (code !== 0 && !s.codexSkipGitRepoCheck && await hasCodexTrustDirectoryError(roleDir(pathForRun(runId), 'planner'))) {
            s.codexSkipGitRepoCheck = true;
            addRunWarning(s, {
              kind: 'codex_skip_git_repo_check_auto_enabled',
              severity: 'warning',
              message: 'Codex refused to run because the workspace is not a trusted Git directory; enabled --skip-git-repo-check and retried the planner.',
              role: 'planner'
            });
            shouldRetryWithSkipGitRepoCheck = true;
            await saveRun(s);
            return;
          }
          const planResult = await materializePlan(s);
          if (s.planner.status !== 'completed') s.status = 'plan_failed';
          else if (planResult.ok) s.status = 'planned';
          else if (planResult.empty) s.status = 'plan_empty';
          else s.status = 'plan_failed';
          await saveRun(s);
        });
        if (shouldRetryWithSkipGitRepoCheck) await startPlanner(runId);
      } catch (error) {
        logAsyncRunStateUpdateError(runId, 'planner', error);
      }
    });
    return state;
  });
}

function normalizeExpectedArtifacts(value, runId, taskId) {
  const artifacts = Array.isArray(value) ? value : [];
  return artifacts.map(item => String(item || '').trim()).filter(Boolean).map(item => {
    if (path.isAbsolute(item)) return item;
    const normalized = item.replace(/^\.\//, '');
    if (normalized.includes(runId)) return normalized;
    return path.posix.join('.orchestrator', runId, taskId, normalized);
  });
}

function normalizeTask(t, i, batch, defaultSandbox = 'workspace-write', runId = '') {
  const id = safeIdPart(t.id || `T-${String(i + 1).padStart(2, '0')}`);
  return {
    id,
    batchId: batch.id,
    name: t.name || t.id || `Task ${i + 1}`,
    prompt: t.prompt || t.instructions || '',
    sandbox: normalizeSandbox(t.sandbox, defaultSandbox),
    expectedArtifacts: normalizeExpectedArtifacts(t.expectedArtifacts, runId, id),
    status: 'pending'
  };
}

function hasStartedExecution(state) {
  return (state.tasks || []).some(t => ['running', 'completed', 'failed', 'unknown', 'stopped'].includes(t.status)) ||
    ['running', 'completed', 'failed', 'unknown', 'stopped'].includes(state.judge?.status);
}

async function rotatePlannerAttempt(state, runDir) {
  const plannerDir = roleDir(runDir, 'planner');
  if (!fs.existsSync(plannerDir)) return;
  const attemptsDir = path.join(runDir, 'planner_attempts');
  await ensureDir(attemptsDir);
  const attempt = (state.plannerAttempts?.length || 0) + 1;
  const archivedDir = path.join(attemptsDir, `attempt-${String(attempt).padStart(2, '0')}`);
  await fsp.rm(archivedDir, { recursive: true, force: true });
  await fsp.rename(plannerDir, archivedDir);
  state.plannerAttempts = [...(state.plannerAttempts || []), {
    attempt,
    status: state.planner?.status,
    exitCode: state.planner?.exitCode ?? null,
    startedAt: state.planner?.startedAt,
    endedAt: state.planner?.endedAt,
    archivedDir,
    archivedAt: nowIso(),
    planParseError: state.planner?.planParseError,
    planEmpty: !!state.planner?.planEmpty
  }];
}

async function rotateJudgeAttempt(state, runDir) {
  const judgeDir = roleDir(runDir, 'judge');
  if (!fs.existsSync(judgeDir)) return;
  const attemptsDir = path.join(runDir, 'judge_attempts');
  await ensureDir(attemptsDir);
  const previousAttempts = (state.judgeAttempts || []).map(item => Number(item.attempt || 0)).filter(Number.isFinite);
  const attempt = Number(state.judge?.attempt || 0) || Math.max(1, 1 + Math.max(0, ...previousAttempts));
  const archivedDir = path.join(attemptsDir, `attempt-${String(attempt).padStart(2, '0')}`);
  await fsp.rm(archivedDir, { recursive: true, force: true });
  await fsp.rename(judgeDir, archivedDir);
  state.judgeAttempts = [...(state.judgeAttempts || []), {
    attempt,
    status: state.judge?.status,
    exitCode: state.judge?.exitCode ?? null,
    startedAt: state.judge?.startedAt,
    endedAt: state.judge?.endedAt,
    archivedDir,
    archivedAt: nowIso()
  }];
}

async function rotateWorkerAttempt(state, task) {
  const runDir = pathForRun(state.runId);
  const workerDir = roleDir(runDir, 'worker', task.id);
  if (!fs.existsSync(workerDir)) return null;
  const attemptsDir = path.join(runDir, 'worker_attempts', task.id);
  await ensureDir(attemptsDir);
  const attempt = Number(task.retryCount || 0) + 1;
  const archivedDir = path.join(attemptsDir, `attempt-${String(attempt).padStart(2, '0')}`);
  await fsp.rm(archivedDir, { recursive: true, force: true });
  await fsp.rename(workerDir, archivedDir);
  task.retryHistory = [...(task.retryHistory || []), {
    attempt,
    status: task.status,
    exitCode: task.exitCode ?? null,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    archivedDir,
    archivedAt: nowIso(),
    reason: task.retryReason || null
  }];
  task.retryCount = attempt;
  task.retryReason = null;
  delete task.pid;
  delete task.exitCode;
  delete task.startedAt;
  delete task.endedAt;
  delete task.stoppedAt;
  delete task.missingRunnerAt;
  delete task.manualCompletion;
  delete task.originalStatus;
  delete task.originalExitCode;
  delete task.error;
  delete task.tmux;
  task.status = 'pending';
  return archivedDir;
}

function normalizePlan(plan, defaultMaxParallel, defaultSandbox = 'workspace-write', runId = '') {
  if (Array.isArray(plan.batches)) {
    const batches = plan.batches.map((b, bi) => {
      const batch = {
        id: safeIdPart(b.id || `batch-${bi + 1}`),
        name: b.name || `批次 ${bi + 1}`,
        maxParallel: Math.max(1, Number(b.maxParallel || defaultMaxParallel) || 1),
        status: 'pending',
        tasks: []
      };
      batch.tasks = (Array.isArray(b.tasks) ? b.tasks : []).map((t, ti) => normalizeTask(t, ti, batch, defaultSandbox, runId));
      return batch;
    }).filter(b => b.tasks.length);
    return { ...plan, batches, tasks: batches.flatMap(b => b.tasks) };
  }
  if (Array.isArray(plan.tasks)) {
    const batch = { id: 'batch-1', name: '默认批次', maxParallel: Math.max(1, Number(defaultMaxParallel) || 1), status: 'pending', tasks: [] };
    batch.tasks = plan.tasks.map((t, i) => normalizeTask(t, i, batch, defaultSandbox, runId));
    return { ...plan, batches: [batch], tasks: batch.tasks };
  }
  return null;
}

async function materializePlan(state) {
  const last = path.join(roleDir(pathForRun(state.runId), 'planner'), 'last_message.md');
  const lastInfo = await fileInfo(last);
  const text = await readTextMaybe(last, 1000000);
  const plan = extractFirstJsonObject(text);
  if (!plan) {
    const exitCode = state.planner?.exitCode;
    state.planner.planParseError = !lastInfo.exists && exitCode !== undefined && exitCode !== null && Number(exitCode) !== 0
      ? `planner process exited with code ${exitCode} before writing last_message.md; inspect stderr.log`
      : 'planner last_message did not contain a JSON object';
    state.batches = [];
    state.tasks = [];
    return { ok: false, empty: false, error: state.planner.planParseError };
  }
  const normalized = normalizePlan(plan, state.maxParallel, state.workerSandbox || 'workspace-write', state.runId);
  if (!normalized || !Array.isArray(normalized.tasks)) {
    state.planner.planParseError = 'planner JSON did not contain { batches: [...] } or { tasks: [...] }';
    state.batches = [];
    state.tasks = [];
    return { ok: false, empty: false, error: state.planner.planParseError };
  }
  if (!normalized.tasks.length) {
    state.planner.planEmpty = true;
    state.planner.planParseError = 'planner returned zero tasks; retry planning after adjusting the task description or prompt';
    state.batches = [];
    state.tasks = [];
    return { ok: false, empty: true, error: state.planner.planParseError };
  }
  delete state.planner.planEmpty;
  delete state.planner.planParseError;
  await writeJsonAtomic(planPath(pathForRun(state.runId)), normalized);
  state.batches = normalized.batches;
  state.tasks = normalized.tasks;
  return { ok: true, empty: false };
}

export async function dispatchRun(runId) {
  return await withRunStateLock(runId, async () => {
    const state = await loadRun(runId);
    if (!state) throw new Error(`run not found: ${runId}`);
    if (state.archived) throw new Error('archived run cannot be dispatched');
    if (state.status === 'stopped') throw new Error('stopped run cannot be dispatched; create a new run after modifications');
    if (!state.tasks?.length) throw new Error('no tasks in plan');
    if (state.status === 'batch_blocked') throw new Error('current batch is blocked by failed/unknown tasks');
    if (allBatchesCompleted(state)) throw new Error('all batches completed; run final judge next');
    approvePlanGate(state);
    state.status = 'running';
    await scheduleMoreWorkers(state);
    recomputeRunStatus(state);
    await saveRun(state);
    return state;
  });
}

function artifactPathForState(state, rel) {
  return path.isAbsolute(rel) ? rel : path.join(workspacePathOf(state), rel);
}

function workerArtifactInstructions(state, task) {
  const artifacts = task.expectedArtifacts || [];
  if (!artifacts.length) return '';
  const lines = artifacts.map(rel => `- ${artifactPathForState(state, rel)}`);
  return `\n\nRequired output artifacts:\nWrite the following artifact path(s) exactly. Create parent directories if needed.\n${lines.join('\n')}`;
}

function upstreamArtifactInstructions(state, task) {
  const currentBatchIndex = (state.batches || []).findIndex(batch => batch.id === task.batchId);
  if (currentBatchIndex <= 0) return '';
  const previousTaskIds = new Set((state.batches || []).slice(0, currentBatchIndex).flatMap(batch => (batch.tasks || []).map(item => item.id)));
  const lines = (state.tasks || [])
    .filter(item => previousTaskIds.has(item.id))
    .flatMap(item => (item.expectedArtifacts || []).map(rel => `- ${item.id}: ${artifactPathForState(state, rel)}`));
  if (!lines.length) return '';
  return `\n\nAvailable upstream artifacts from completed earlier batches:\n${lines.join('\n')}\nUse only artifacts from this run id: ${state.runId}.`;
}

async function liveStandaloneJobStart(outDir) {
  const exit = await readTextMaybe(path.join(outDir, 'exit_code'), 1000);
  if (exit !== '') return null;
  const text = await readTextMaybe(path.join(outDir, 'package', 'job_events.jsonl'), 200000);
  if (!String(text || '').trim()) return null;
  let lastStarted = null;
  let closedAfterStart = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'job.started') {
      lastStarted = event;
      closedAfterStart = false;
    } else if (lastStarted && ['job.completed', 'job.failed', 'job.start_failed'].includes(event?.type)) {
      closedAfterStart = true;
    }
  }
  const pid = Number(lastStarted?.pid);
  if (!closedAfterStart && Number.isFinite(pid) && pid > 0 && isPidAlive(pid)) return { ...lastStarted, pid };
  return null;
}

async function startWorkerInState(state, task) {
  const runDir = pathForRun(state.runId);
  const outDir = roleDir(runDir, 'worker', task.id);
  await ensureDir(outDir);
  if (task.status === 'running' && await hasLiveRunnerProcess(state, task.id, task)) return;
  const durableStart = await liveStandaloneJobStart(outDir);
  if (durableStart) {
    Object.assign(task, { status: 'running', pid: durableStart.pid, startedAt: durableStart.at || task.startedAt || nowIso(), dir: outDir });
    return;
  }
  const fullPrompt = `${marker(state.runId, task.id, 'worker')}
ORCHESTRATOR_BATCH_ID: ${task.batchId || 'batch-1'}

${task.prompt}${workerArtifactInstructions(state, task)}${upstreamArtifactInstructions(state, task)}
`;
  const activeRunner = runnerForState(state);
  const sandbox = task.sandbox || state.workerSandbox || 'workspace-write';
  const workerAttempt = Number(task.retryCount || 0) + 1;
  const child = await activeRunner.startAgentTask({ runId: state.runId, taskId: task.id, batchId: task.batchId || 'batch-1', runStatePath: statePath(runDir), prompt: fullPrompt, sandbox, cwd: workspacePathOf(state), outDir, skipGitRepoCheck: !!state.codexSkipGitRepoCheck, expectedArtifacts: task.expectedArtifacts || [], attempt: workerAttempt, retry: jobRetryMetadata(task), workspace: jobWorkspaceRef(state), security: jobSecurityPolicy(state, sandbox) });
  Object.assign(task, { status: 'running', pid: child.pid, startedAt: nowIso(), dir: outDir });
}

export async function stopRun(runId, { reason = 'stopped by user' } = {}) {
  return await withRunStateLock(runId, async () => {
    const state = await loadRun(runId);
    if (!state) throw new Error(`run not found: ${runId}`);
    const stoppedAt = nowIso();
    await runnerForState(state).stopRun(runId);
    const stoppedPids = new Set();
    const stopTargetPid = target => {
      const pid = Number(target?.pid);
      if (Number.isFinite(pid) && pid > 0 && !stoppedPids.has(pid)) {
        stoppedPids.add(pid);
        stopPid(pid);
      }
    };
    for (const roleState of [state.planner, state.judge]) {
      if (roleState?.status === 'running') {
        stopTargetPid(roleState);
        Object.assign(roleState, { status: 'stopped', stoppedAt, endedAt: stoppedAt });
      }
    }
    for (const task of state.tasks || []) {
      if (task.status === 'running') {
        stopTargetPid(task);
        Object.assign(task, { status: 'stopped', stoppedAt, endedAt: stoppedAt });
      }
    }
    for (const batch of state.batches || []) {
      for (const task of batch.tasks || []) if (task.status === 'running') stopTargetPid(task);
    }
    for (const batch of state.batches || []) {
      if ((batch.tasks || []).some(t => t.status === 'stopped')) batch.status = 'stopped';
    }
    state.status = 'stopped';
    state.stopInfo = { reason, stoppedAt };
    await saveRun(state);
    return state;
  });
}

export async function archiveRun(runId, { reason = 'archived by user' } = {}) {
  return await withRunStateLock(runId, async () => {
    const state = await loadRun(runId);
    if (!state) throw new Error(`run not found: ${runId}`);
    if ((state.tasks || []).some(t => t.status === 'running') || state.planner?.status === 'running' || state.judge?.status === 'running') {
      throw new Error('cannot archive a run while tasks are running; stop it first');
    }
    state.archived = true;
    state.archivedAt = nowIso();
    state.archiveInfo = { reason, archivedAt: state.archivedAt };
    await saveRun(state);
    return state;
  });
}

export async function renameRun(runId, { label = '' } = {}) {
  return await withRunStateLock(runId, async () => {
    const state = await loadRun(runId);
    if (!state) throw new Error(`run not found: ${runId}`);
    const nextLabel = String(label || '').trim();
    if (!nextLabel) throw userInputError('run label cannot be empty');
    state.label = nextLabel;
    state.renamedAt = nowIso();
    await saveRun(state);
    return state;
  });
}

export async function retryRun(runId, { taskId = '', reason = 'manual retry', maxRetries = 1, auto = false } = {}) {
  return await withRunStateLock(runId, async () => {
    const state = await loadRun(runId);
    if (!state) throw new Error(`run not found: ${runId}`);
    if (state.archived) throw new Error('archived run cannot be retried');
    if (state.status === 'stopped') throw new Error('stopped run cannot be retried');
    const selectedTaskId = String(taskId || '').trim();
    let taskIds = [];
    if (selectedTaskId) {
      const task = (state.tasks || []).find(item => item.id === selectedTaskId);
      if (!task) throw new Error(`task not found: ${selectedTaskId}`);
      taskIds = [task.id];
      if (!['failed', 'unknown'].includes(task.status)) throw new Error(`task is not retryable: ${selectedTaskId}`);
    } else {
      const batch = currentBlockedBatch(state);
      if (!batch) throw new Error('no blocked batch to retry');
      taskIds = (batch.tasks || []).filter(item => ['failed', 'unknown'].includes(item.status) && (!auto || canAutoRetryTask(item, maxRetries))).map(item => item.id);
      if (!taskIds.length) throw new Error('no retryable tasks in blocked batch');
    }
    const result = await retryTasksInState(state, taskIds, { auto, maxRetries, reason });
    if (!result.retried.length) throw new Error('no tasks were retried');
    await saveRun(state);
    return { ...state, retriedTaskIds: result.retried };
  });
}

export async function markTaskCompleted(runId, taskId, { reason = 'manual success confirmed by user', resultText = '' } = {}) {
  return await withRunStateLock(runId, async () => {
    const state = await loadRun(runId);
    if (!state) throw new Error(`run not found: ${runId}`);
    const task = (state.tasks || []).find(t => t.id === taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.status === 'running') throw new Error('cannot mark a running task completed');
    const runDir = pathForRun(runId);
    const outDir = roleDir(runDir, 'worker', task.id);
    await ensureDir(outDir);
    if (task.status !== 'completed') {
      const manualResult = String(resultText || '').trim();
      if (manualResult) await fsp.writeFile(path.join(outDir, 'manual_result.md'), manualResult);
      const override = {
        type: 'manual_task_completed',
        runId,
        taskId,
        originalStatus: task.originalStatus || task.status,
        originalExitCode: task.originalExitCode ?? task.exitCode ?? null,
        previousStatus: task.status,
        previousExitCode: task.exitCode ?? null,
        reason,
        hasManualResult: !!manualResult,
        manualResultFile: manualResult ? 'manual_result.md' : null,
        manualResultPreview: manualResult ? manualResult.slice(0, 500) : '',
        markedAt: nowIso()
      };
      await writeJsonAtomic(path.join(outDir, 'manual_completion.json'), override);
      Object.assign(task, {
        status: 'completed',
        originalStatus: override.originalStatus,
        originalExitCode: override.originalExitCode,
        manualCompletion: override,
        completedAt: override.markedAt
      });
      const batch = (state.batches || []).find(b => b.id === task.batchId);
      if (batch) {
        const batchTask = batch.tasks.find(t => t.id === task.id);
        if (batchTask && batchTask !== task) Object.assign(batchTask, task);
      }
    }
    recomputeRunStatus(state);
    if (hasPendingRunnableBatch(state)) state.status = 'running';
    await scheduleMoreWorkers(state);
    recomputeRunStatus(state);
    await saveRun(state);
    return state;
  });
}

export async function startJudge(runId) {
  return await withRunStateLock(runId, async () => {
    const state = await loadRun(runId);
    if (!state) throw new Error(`run not found: ${runId}`);
    if (state.archived) throw new Error('archived run cannot be judged');
    if (state.status === 'stopped') throw new Error('stopped run cannot be judged');
    recomputeRunStatus(state);
    if (state.judge?.status === 'running') throw new Error('judge already running');
    if (state.judge?.status === 'completed') throw new Error('judge already completed');
    if (!allBatchesCompleted(state) && state.tasks?.length) throw new Error('final judge is allowed only after all batches completed');
    const runDir = pathForRun(runId);
    if (state.judge?.status === 'failed') await rotateJudgeAttempt(state, runDir);
    const outDir = roleDir(runDir, 'judge');
    await ensureDir(outDir);
    const judgeInputPath = path.join(outDir, 'judge_input.json');
    const judgeInput = await buildJudgeInput(state);
    await writeJsonAtomic(judgeInputPath, judgeInput);
    const prompt = defaultJudgePrompt(state, judgeInputPath);
    const activeRunner = runnerForState(state);
    const previousJudgeAttempts = [
      ...(state.judgeAttempts || []).map(item => Number(item.attempt || 0)),
      Number(state.judge?.attempt || 0)
    ].filter(Number.isFinite);
    const judgeAttempt = 1 + Math.max(0, ...previousJudgeAttempts);
    const child = await activeRunner.startAgentTask({ runId: state.runId, taskId: 'judge', batchId: 'judge', runStatePath: statePath(runDir), prompt, sandbox: 'read-only', cwd: workspacePathOf(state), outDir, skipGitRepoCheck: !!state.codexSkipGitRepoCheck, attempt: judgeAttempt, workspace: jobWorkspaceRef(state), security: jobSecurityPolicy(state, 'read-only') });
    state.judge = { status: 'running', pid: child.pid, startedAt: nowIso(), dir: outDir, attempt: judgeAttempt };
    state.status = 'judging';
    await saveRun(state);
    child.onExit(async code => {
      try {
        await withRunStateLock(runId, async () => {
          const s = await loadRun(runId); if (!s || s.status === 'stopped') return;
          s.judge.exitCode = code; s.judge.endedAt = nowIso(); s.judge.status = code === 0 ? 'completed' : 'failed';
          const text = await readTextMaybe(path.join(outDir, 'last_message.md'), 1000000);
          const verdict = extractFirstJsonObject(text);
          if (verdict) { s.judge.verdict = verdict; await writeJsonAtomic(path.join(outDir, 'verdict.json'), verdict); }
          s.status = s.judge.status === 'completed' ? 'judged' : 'judge_failed';
          await saveRun(s);
        });
      } catch (error) {
        logAsyncRunStateUpdateError(runId, 'judge', error);
      }
    });
    return state;
  });
}

export async function snapshotRun(runId) {
  return await loadRun(runId);
}

export async function refreshRun(runId, appClient = null, options = {}) {
  try {
    return await loadAndRefreshRun(runId, appClient, { light: false, ...options });
  } catch (error) {
    if (options.fallbackOnLockBusy && isRunStateLockBusyError(error)) {
      const state = await snapshotRun(runId);
      if (!state) return null;
      state.statusRefreshError = error.message || String(error);
      return state;
    }
    throw error;
  }
}

export async function autoAdvanceRun(runId, { appClient = null, startCreated = false, maxRetries = 1, retryReason = 'auto retry from scheduler' } = {}) {
  let state = await refreshRun(runId, appClient);
  if (!state || state.archived || state.status === 'stopped') return state;
  if (startCreated && state.status === 'created') {
    try { state = await startPlanner(runId); }
    catch (error) { if (!/planner already running/i.test(error.message || '')) throw error; }
    state = await refreshRun(runId, appClient);
  }
  if (!state || state.archived || state.status === 'stopped') return state;
  if (state.status === 'batch_blocked') {
    try { state = await retryRun(runId, { reason: retryReason, maxRetries, auto: true }); }
    catch (error) { state.autoAdvanceError = error.message || String(error); }
    return await refreshRun(runId, appClient) || state;
  }
  if (state.status === 'planned') {
    if (requiresPlanApproval(state)) return state;
    try { state = await dispatchRun(runId); }
    catch (error) { if (!/all batches completed|current batch is blocked/i.test(error.message || '')) throw error; }
    return await refreshRun(runId, appClient) || state;
  }
  if (state.status === 'batches_completed' && state.judge?.status !== 'running' && state.judge?.status !== 'completed') {
    try { state = await startJudge(runId); }
    catch (error) { if (!/final judge is allowed only after all batches completed/i.test(error.message || '')) throw error; }
    return await refreshRun(runId, appClient) || state;
  }
  return state;
}

export async function autoAdvanceActiveRuns({ appClient = null, startCreated = false, maxRetries = 1, retryReason = 'auto retry from scheduler' } = {}) {
  const dirs = await listRunDirs();
  const results = [];
  for (const dir of dirs) {
    const runId = path.basename(dir);
    let initial;
    try {
      initial = await loadRun(runId);
    } catch (error) {
      if (!isInvalidStoredRunnerError(error)) results.push({ runId, ok: false, error: error.message || String(error) });
      continue;
    }
    try {
      if (!initial || initial.archived || !isAutoAdvanceableRunStatus(initial.status)) continue;
      const state = await autoAdvanceRun(runId, { appClient, startCreated, maxRetries, retryReason });
      if (state) results.push({ runId, status: state.status, ok: true });
    } catch (error) {
      results.push({ runId, ok: false, error: error.message || String(error) });
    }
  }
  return results;
}

async function loadAndRefreshRun(runId, appClient = null, { light = false, tmuxSessionChecker = null, lockTimeoutMs = null } = {}) {
  const lockOptions = Number.isFinite(lockTimeoutMs) ? { timeoutMs: lockTimeoutMs } : {};
  return await withRunStateLock(runId, async () => {
    const state = await loadRun(runId);
    if (!state) return null;
    const refreshOptions = { tmuxSessionChecker, tmuxSessionStatusCache: new Map() };
    state.runner = normalizeRunner(state.runner || LEGACY_DEFAULT_RUNNER, 'runner');
    await refreshRole(state, state.planner, roleDir(pathForRun(runId), 'planner'), refreshOptions);
    await recoverCompletedPlanner(state);
    for (const task of state.tasks || []) await refreshTask(state, task, refreshOptions);
    await refreshRole(state, state.judge, roleDir(pathForRun(runId), 'judge'), refreshOptions);
    await recoverCompletedJudge(state);
    await aggregateRunTmuxMetadata(state, refreshOptions);
    recomputeRunStatus(state);
    await scheduleMoreWorkers(state);
    recomputeRunStatus(state);
    if (appClient && !light) await enrichFromAppServer(state, appClient).catch(e => { state.appServerError = e.message; });
    applyRunAgentBackends(state);
    await saveRun(state);
    return state;
  }, lockOptions);
}

async function recoverCompletedPlanner(state) {
  if (state.planner?.status !== 'completed' || state.tasks?.length || state.batches?.length) return;
  const planResult = await materializePlan(state);
  if (planResult.ok) state.status = 'planned';
  else if (planResult.empty) state.status = 'plan_empty';
  else state.status = 'plan_failed';
}

async function recoverCompletedJudge(state) {
  if (!['completed', 'failed'].includes(state.judge?.status)) return;
  if (state.judge.status === 'completed' && !state.judge.verdict) {
    const outDir = roleDir(pathForRun(state.runId), 'judge');
    const text = await readTextMaybe(path.join(outDir, 'last_message.md'), 1000000);
    const verdict = extractFirstJsonObject(text);
    if (verdict) {
      state.judge.verdict = verdict;
      await writeJsonAtomic(path.join(outDir, 'verdict.json'), verdict);
    }
  }
  state.status = state.judge.status === 'completed' ? 'judged' : 'judge_failed';
}

async function refreshRole(state, roleState, dir, options = {}) {
  if (!roleState) return;
  const exitPath = path.join(dir, 'exit_code');
  const exit = await readTextMaybe(exitPath, 1000);
  const exitInfo = await fileInfo(exitPath);
  const key = roleState === state.judge ? 'judge' : 'planner';
  roleState.files = await standardFiles(dir);
  await attachTmuxMetadata(roleState, dir);
  if (exit !== '') {
    roleState.exitCode = Number(exit.trim());
    if (!roleState.endedAt && exitInfo.exists) roleState.endedAt = exitInfo.mtime;
    clearMissingRunner(roleState);
    if (['running', 'unknown'].includes(roleState.status)) roleState.status = roleState.exitCode === 0 ? 'completed' : 'failed';
  } else {
    const shouldCheckLiveRunner = ['running', 'unknown'].includes(roleState.status);
    const hasLiveRunner = shouldCheckLiveRunner ? await hasLiveRunnerProcess(state, key, roleState, options) : false;
    if (shouldCheckLiveRunner && hasLiveRunner) {
      roleState.status = 'running';
      clearMissingRunner(roleState);
    } else if (roleState.status === 'running' && shouldMarkRunnerUnknown(roleState)) {
      roleState.status = 'unknown';
    }
  }
}

function attentionHintExcerpt(content, pattern) {
  const match = pattern.exec(content);
  if (!match) return '';
  const matchStart = match.index;
  const start = Math.max(0, content.lastIndexOf('\n', Math.max(0, matchStart - 240)) + 1);
  const nextBreak = content.indexOf('\n', matchStart + Math.max(match[0].length, 1) + 240);
  const end = nextBreak >= 0 ? nextBreak : content.length;
  return content
    .slice(start, end)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 360);
}

function detectWorkerAttentionHint(text) {
  const content = String(text || '');
  if (!content.trim()) return null;
  const lower = content.toLowerCase();
  const workerIndex = lower.indexOf('worker context');
  const unauthorizedTerms = ['unauthorized', 'not authorized', 'unauthorised', '未授权', '无授权'];
  const unauthorizedIndex = unauthorizedTerms
    .map(term => lower.indexOf(term.toLowerCase()))
    .filter(index => index >= 0)
    .sort((left, right) => left - right)[0];
  if (workerIndex >= 0 && unauthorizedIndex >= 0 && Math.abs(workerIndex - unauthorizedIndex) <= 160) {
    return {
      kind: 'worker_context_unauthorized',
      severity: 'blocked',
      message: 'Worker context 无授权，请检查 Codex/Agent 上下文授权或重新登录后重试。',
      detail: attentionHintExcerpt(content, /worker\s+context|unauthorized|not\s+authorized|unauthorised|未授权|无授权/i)
    };
  }
  const patchContextPattern = /apply_patch verification failed|Failed to find expected lines|patch failed|hunk failed/i;
  if (patchContextPattern.test(content)) {
    return {
      kind: 'patch_context_drift',
      severity: 'warning',
      message: 'Patch 上下文不匹配，可能是并发修改或代码已漂移；建议尽早进入会话调整后继续。',
      detail: attentionHintExcerpt(content, patchContextPattern)
    };
  }
  const toolArgumentPattern = /failed to parse function arguments|invalid function arguments|missing field [`"']?\w+[`"']? at line/i;
  if (toolArgumentPattern.test(content)) {
    return {
      kind: 'tool_argument_error',
      severity: 'warning',
      message: '工具调用参数错误，建议进入会话修正上下文后继续。',
      detail: attentionHintExcerpt(content, toolArgumentPattern)
    };
  }
  const permissionPattern = /sandbox denied|permission denied|operation not permitted|\bEACCES\b/i;
  if (permissionPattern.test(content)) {
    return {
      kind: 'permission_denied',
      severity: 'blocked',
      message: '执行遇到权限或沙箱限制，可调整权限/沙箱后重试或进入会话介入。',
      detail: attentionHintExcerpt(content, permissionPattern)
    };
  }
  const environmentPattern = /\bHTTP\s*(401|403|409)\b|\b(401|403|409)\b[\s\S]{0,160}(unauthorized|forbidden|conflict|unavailable)|values profile unavailable/i;
  if (environmentPattern.test(content)) {
    return {
      kind: 'environment_blocked',
      severity: 'blocked',
      message: '外部环境/接口返回权限或可用性阻塞，建议先处理环境后再继续。',
      detail: attentionHintExcerpt(content, environmentPattern)
    };
  }
  return null;
}

async function taskAttentionHint(dir) {
  const stderr = await readTextMaybe(path.join(dir, 'stderr.log'), 20000);
  const lastMessage = await readTextMaybe(path.join(dir, 'last_message.md'), 20000);
  return detectWorkerAttentionHint(String(stderr || '') + '\n' + String(lastMessage || ''));
}

async function refreshTask(state, task, options = {}) {
  const dir = roleDir(pathForRun(state.runId), 'worker', task.id);
  const exitPath = path.join(dir, 'exit_code');
  const exit = await readTextMaybe(exitPath, 1000);
  const exitInfo = await fileInfo(exitPath);
  task.files = await standardFiles(dir);
  await attachTmuxMetadata(task, dir);
  if (exit !== '') {
    task.exitCode = Number(exit.trim());
    if (!task.endedAt && exitInfo.exists) task.endedAt = exitInfo.mtime;
    clearMissingRunner(task);
    if (['pending', 'running', 'unknown'].includes(task.status)) task.status = task.exitCode === 0 ? 'completed' : 'failed';
  } else {
    const shouldCheckLiveRunner = ['running', 'unknown'].includes(task.status);
    const hasLiveRunner = shouldCheckLiveRunner ? await hasLiveRunnerProcess(state, task.id, task, options) : false;
    if (shouldCheckLiveRunner && hasLiveRunner) {
      task.status = 'running';
      clearMissingRunner(task);
    } else if (task.status === 'running' && shouldMarkRunnerUnknown(task)) {
      task.status = 'unknown';
    }
  }
  const attentionHint = await taskAttentionHint(dir);
  if (attentionHint) task.attentionHint = attentionHint;
  else delete task.attentionHint;
  task.artifacts = [];
  for (const rel of task.expectedArtifacts || []) task.artifacts.push({ path: rel, ...(await fileInfo(path.isAbsolute(rel) ? rel : path.join(workspacePathOf(state), rel))) });
  const batch = (state.batches || []).find(b => b.id === task.batchId);
  if (batch) {
    const bt = batch.tasks.find(t => t.id === task.id);
    if (bt && bt !== task) Object.assign(bt, task);
  }
}

async function attachTmuxMetadata(target, dir) {
  const raw = await readJson(path.join(dir, 'tmux.json'), null);
  if (!raw || raw.runner !== 'tmux') {
    delete target.tmux;
    return;
  }
  if (raw.ready !== true) {
    target.tmux = {
      runner: 'tmux',
      ready: false,
      status: raw.status || 'pending',
      sessionName: raw.sessionName || '',
      windowName: raw.windowName || '',
      target: raw.target || '',
      runScript: raw.runScript || '',
      startedAt: raw.startedAt || '',
      error: raw.error || ''
    };
    return;
  }
  const selectWindowCommand = raw.selectWindowCommand || raw.selectCommand || '';
  target.tmux = {
    runner: 'tmux',
    ready: true,
    status: raw.status || 'ready',
    tmuxShell: raw.tmuxShell || null,
    sessionName: raw.sessionName || '',
    windowName: raw.windowName || '',
    target: raw.target || '',
    attachCommand: raw.attachCommand || '',
    selectWindowCommand,
    paneId: raw.paneId || '',
    paneTarget: raw.paneTarget || raw.paneId || '',
    selectPaneCommand: raw.selectPaneCommand || '',
    paneCommand: raw.paneCommand || raw.selectPaneCommand || selectWindowCommand,
    attachPaneCommand: raw.attachPaneCommand || '',
    runScript: raw.runScript || '',
    startedAt: raw.startedAt || '',
    readyAt: raw.readyAt || ''
  };
}

async function aggregateRunTmuxMetadata(state, options = {}) {
  const roles = [state.planner, ...(state.tasks || []), state.judge].filter(Boolean);
  const entries = roles.map(role => role.tmux).filter(tmux => tmux?.runner === 'tmux');
  const readyEntries = entries.filter(tmux => tmux.ready === true);
  if (!entries.length) {
    if ((state.runner || LEGACY_DEFAULT_RUNNER) === 'tmux') {
      state.tmux = {
        runner: 'tmux',
        hasTmuxSession: false
      };
    } else {
      delete state.tmux;
    }
    return;
  }
  state.runner = 'tmux';
  const withSession = readyEntries.find(tmux => tmux.sessionName || tmux.target || tmux.windowName);
  if (!withSession) {
    state.tmux = {
      runner: 'tmux',
      hasTmuxSession: false
    };
    return;
  }
  const hasTmuxSession = await hasDurableTmuxSession(state, { tmux: withSession }, options);
  state.tmux = {
    runner: 'tmux',
    hasTmuxSession,
    tmuxSessionName: withSession.sessionName || ''
  };
  if (hasTmuxSession && withSession.attachCommand) state.tmux.tmuxAttachCommand = withSession.attachCommand;
}

async function standardFiles(dir) {
  const tmuxPath = path.join(dir, 'tmux.json');
  const tmuxInfo = await fileInfo(tmuxPath);
  const tmuxMetadata = tmuxInfo.exists ? await readJson(tmuxPath, null) : null;
  const runScriptPath = tmuxMetadata?.runScript || await firstExistingRunScript(dir);
  return {
    prompt: await fileInfo(path.join(dir, 'prompt.md')),
    events: await fileInfo(path.join(dir, 'events.jsonl')),
    timedEvents: await fileInfo(path.join(dir, 'events_timed.jsonl')),
    stderr: await fileInfo(path.join(dir, 'stderr.log')),
    lastMessage: await fileInfo(path.join(dir, 'last_message.md')),
    exitCode: await fileInfo(path.join(dir, 'exit_code')),
    runScript: await fileInfo(runScriptPath),
    tmux: tmuxInfo,
    manualResult: await fileInfo(path.join(dir, 'manual_result.md')),
    jobPackage: await fileInfo(path.join(dir, 'package', 'job.json')),
    jobManifest: await fileInfo(path.join(dir, 'package', 'manifest.json')),
    jobEvents: await fileInfo(path.join(dir, 'package', 'job_events.jsonl'))
  };
}

async function firstExistingRunScript(dir) {
  for (const name of ['run.sh', 'run.ps1', 'run.cmd']) {
    const candidate = path.join(dir, name);
    const info = await fileInfo(candidate);
    if (info.exists) return candidate;
  }
  return path.join(dir, 'run.sh');
}

function currentBatch(state) {
  ensureBatchShape(state);
  return (state.batches || []).find(b => b.status !== 'completed');
}

function currentBlockedBatch(state) {
  ensureBatchShape(state);
  return (state.batches || []).find(b => b.status === 'failed' || b.status === 'blocked' || b.status === 'running' && (b.tasks || []).some(t => ['failed', 'unknown'].includes(t.status)));
}

function canAutoRetryTask(task, maxRetries = 1) {
  if (!task) return false;
  if (!['failed', 'unknown'].includes(task.status)) return false;
  if (Number(task.retryCount || 0) >= Number(maxRetries || 1)) return false;
  return true;
}

async function retryTasksInState(state, taskIds = null, { auto = false, maxRetries = 1, reason = 'retry' } = {}) {
  ensureBatchShape(state);
  const selectedTaskIds = taskIds ? new Set(taskIds.map(id => safeIdPart(id))) : null;
  const tasksToRetry = (state.tasks || []).filter(task => {
    if (selectedTaskIds && !selectedTaskIds.has(task.id)) return false;
    if (!['failed', 'unknown'].includes(task.status)) return false;
    if (auto && !canAutoRetryTask(task, maxRetries)) return false;
    return true;
  });
  if (!tasksToRetry.length) return { retried: [], state };
  for (const task of tasksToRetry) {
    if (await hasLiveRunnerProcess(state, task.id, task)) throw new Error(`task still has a live process: ${task.id}`);
  }
  for (const task of tasksToRetry) {
    const batch = (state.batches || []).find(item => item.id === task.batchId);
    task.retryReason = reason;
    await rotateWorkerAttempt(state, task);
    const batchTask = batch?.tasks?.find(item => item.id === task.id);
    if (batchTask && batchTask !== task) Object.assign(batchTask, task);
  }
  recomputeRunStatus(state);
  if (hasPendingRunnableBatch(state)) state.status = 'running';
  await scheduleMoreWorkers(state);
  recomputeRunStatus(state);
  return { retried: tasksToRetry.map(task => task.id), state };
}

async function scheduleMoreWorkers(state) {
  if (state.status !== 'running') return;
  const batch = currentBatch(state);
  if (!batch) return;
  if (batch.status === 'failed' || batch.status === 'blocked') return;
  batch.status = 'running';
  const maxParallel = Math.max(1, Number(batch.maxParallel || state.maxParallel) || 1);
  let active = batch.tasks.filter(t => t.status === 'running').length;
  for (const task of batch.tasks) {
    if (active >= maxParallel) break;
    if (task.status !== 'pending') continue;
    try { await startWorkerInState(state, task); syncFlatTask(state, task); }
    catch (e) { task.status = 'failed'; task.error = e.message; syncFlatTask(state, task); }
    active++;
  }
}

function syncFlatTask(state, task) {
  const i = (state.tasks || []).findIndex(t => t.id === task.id);
  if (i >= 0) state.tasks[i] = task;
}

function recomputeRunStatus(state) {
  ensureBatchShape(state);
  if (state.archived || state.status === 'stopped' || state.status === 'created' || state.status === 'planning' || state.status === 'judging') return;
  for (const batch of state.batches || []) {
    const tasks = batch.tasks || [];
    if (!tasks.length) { batch.status = 'completed'; continue; }
    if (tasks.some(t => t.status === 'running')) { batch.status = 'running'; continue; }
    if (tasks.some(t => ['failed', 'unknown'].includes(t.status))) { batch.status = 'failed'; continue; }
    if (tasks.every(t => t.status === 'completed')) { batch.status = 'completed'; continue; }
    batch.status = 'pending';
  }
  const failedBatch = (state.batches || []).find(b => b.status === 'failed');
  if (failedBatch) { state.status = 'batch_blocked'; return; }
  if (allBatchesCompleted(state)) {
    if (state.judge?.status === 'completed') state.status = 'judged';
    else state.status = 'batches_completed';
    return;
  }
  if ((state.batches || []).some(b => b.status === 'running')) state.status = 'running';
  else if ((state.batches || []).some(b => b.status === 'pending')) {
    state.status = state.status === 'running' ? 'running' : 'planned';
  }
}

function hasPendingRunnableBatch(state) {
  if (state.archived || state.status === 'stopped') return false;
  const batch = currentBatch(state);
  if (!batch) return false;
  if (batch.status === 'failed' || batch.status === 'blocked') return false;
  return (batch.tasks || []).some(t => t.status === 'pending');
}

function allBatchesCompleted(state) {
  return !!(state.batches?.length) && state.batches.every(b => b.status === 'completed');
}

async function buildJudgeInput(state) {
  const runDir = pathForRun(state.runId);
  const taskText = await readTextMaybe(path.join(runDir, 'task.md'), 1000000);
  const plan = await readJson(planPath(runDir), null);
  const tasks = [];
  for (const task of state.tasks || []) {
    const dir = roleDir(runDir, 'worker', task.id);
    tasks.push({
      id: task.id,
      name: task.name,
      batchId: task.batchId,
      status: task.status,
      originalStatus: task.originalStatus,
      exitCode: task.exitCode ?? null,
      originalExitCode: task.originalExitCode ?? null,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      completedAt: task.completedAt,
      expectedArtifacts: task.expectedArtifacts || [],
      artifacts: task.artifacts || [],
      lastMessage: await readTextMaybe(path.join(dir, 'last_message.md'), 200000),
      resultJson: await readJson(path.join(dir, 'result.json'), null),
      evidenceJson: await readJson(path.join(dir, 'evidence.json'), null),
      manualCompletion: task.manualCompletion || await readJson(path.join(dir, 'manual_completion.json'), null),
      manualResult: await readTextMaybe(path.join(dir, 'manual_result.md'), 200000),
      tmux: task.tmux || null,
      stderrTail: await readTextMaybe(path.join(dir, 'stderr.log'), 20000)
    });
  }
  return {
    type: 'codex_orchestrator_judge_input',
    version: 1,
    generatedAt: nowIso(),
    run: {
      runId: state.runId,
      label: state.label,
      repo: workspacePathOf(state),
      workspacePath: workspacePathOf(state),
      workspaceName: state.workspaceName || path.basename(workspacePathOf(state)) || workspacePathOf(state),
      git: state.git || state.workspace?.git || null,
      status: state.status,
      runner: state.runner || LEGACY_DEFAULT_RUNNER,
      tmuxShell: state.tmuxShell || 'auto',
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      maxParallel: state.maxParallel,
      workerSandbox: state.workerSandbox || 'workspace-write',
      codexSkipGitRepoCheck: !!state.codexSkipGitRepoCheck
    },
    taskText,
    plan,
    batches: (state.batches || []).map(batch => ({
      id: batch.id,
      name: batch.name,
      status: batch.status,
      maxParallel: batch.maxParallel,
      taskIds: (batch.tasks || []).map(task => task.id)
    })),
    planner: {
      status: state.planner?.status,
      exitCode: state.planner?.exitCode ?? null,
      planParseError: state.planner?.planParseError,
      planEmpty: !!state.planner?.planEmpty,
      tmux: state.planner?.tmux || null,
      lastMessage: await readTextMaybe(path.join(roleDir(runDir, 'planner'), 'last_message.md'), 200000)
    },
    tasks
  };
}

function ensureBatchShape(state) {
  if (!Array.isArray(state.batches) || !state.batches.length) {
    if (Array.isArray(state.tasks) && state.tasks.length) {
      state.batches = [{ id: 'batch-1', name: '默认批次', maxParallel: Math.max(1, Number(state.maxParallel) || 1), status: 'pending', tasks: state.tasks }];
      for (const t of state.tasks) t.batchId = t.batchId || 'batch-1';
    } else state.batches = [];
  }
  state.tasks = (state.batches || []).flatMap(b => {
    b.tasks = Array.isArray(b.tasks) ? b.tasks : [];
    for (const t of b.tasks) t.batchId = t.batchId || b.id;
    return b.tasks;
  });
}

async function enrichFromAppServer(state, appClient) {
  const res = await appClient.listThreads({ cwd: workspacePathOf(state), limit: 100 });
  const threads = res?.data || [];
  const all = [{ id: 'planner', target: state.planner, role: 'planner' }, ...(state.tasks || []).map(t => ({ id: t.id, target: t, role: 'worker' })), { id: 'judge', target: state.judge, role: 'judge' }];
  for (const item of all) {
    const backend = item.target?.agentBackend || agentBackendForRole(state, item.role);
    if (backend !== 'codex') {
      if (item.target) delete item.target.codexThread;
      continue;
    }
    const thread = threads.find(th => matchThreadToMarkers(th, state.runId, item.id));
    if (thread && item.target) item.target.codexThread = { id: thread.id, sessionId: thread.sessionId, source: thread.source, status: thread.status, preview: thread.preview, updatedAt: thread.updatedAt };
  }
}

function runDurationEndOfState(s) {
  const terminalStatuses = new Set(['judged', 'judge_failed', 'batch_blocked', 'plan_failed', 'plan_empty', 'stopped']);
  if (!terminalStatuses.has(s.status)) return null;
  const times = [
    s.stoppedAt,
    s.stopInfo?.stoppedAt,
    s.judge?.endedAt,
    s.planner?.endedAt,
    ...(s.tasks || []).flatMap(task => [task.endedAt, task.completedAt, task.stoppedAt])
  ].map(value => Date.parse(value || '')).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : s.updatedAt;
}

export function summaryOfRun(s) {
  const tasks = s.tasks || [];
  const workspacePath = s.workspacePath || s.repo || '';
  const git = s.git || s.workspace?.git || null;
  return { runId: s.runId, label: s.label, repo: s.repo || workspacePath, workspacePath, workspaceName: s.workspaceName || path.basename(workspacePath || ''), git, status: s.status, runner: s.runner || LEGACY_DEFAULT_RUNNER, tmuxShell: s.tmuxShell || 'auto', workerSandbox: s.workerSandbox || 'workspace-write', codexSkipGitRepoCheck: !!s.codexSkipGitRepoCheck, gates: s.gates || {}, archived: !!s.archived, createdAt: s.createdAt, updatedAt: s.updatedAt, durationEnd: runDurationEndOfState(s), total: tasks.length, completed: tasks.filter(t => t.status === 'completed').length, failed: tasks.filter(t => ['failed','unknown'].includes(t.status)).length, running: tasks.filter(t => t.status === 'running').length, batches: (s.batches || []).map(b => ({ id: b.id, name: b.name, status: b.status, total: b.tasks?.length || 0, completed: (b.tasks || []).filter(t => t.status === 'completed').length })) };
}

export function summaryOfLoadFailedRun(runId, error, raw = {}) {
  const workspacePath = raw?.workspacePath || raw?.repo || '';
  const git = raw?.git || raw?.workspace?.git || null;
  const updatedAt = raw?.updatedAt || raw?.createdAt || null;
  return { runId, label: raw?.label || runId, repo: raw?.repo || workspacePath, workspacePath, workspaceName: raw?.workspaceName || path.basename(workspacePath || ''), git, status: 'load_failed', runner: raw?.runner || 'unknown', tmuxShell: raw?.tmuxShell || 'auto', workerSandbox: raw?.workerSandbox || 'workspace-write', codexSkipGitRepoCheck: !!raw?.codexSkipGitRepoCheck, gates: raw?.gates || {}, archived: !!raw?.archived, createdAt: raw?.createdAt || updatedAt, updatedAt, durationEnd: updatedAt, total: 0, completed: 0, failed: 1, running: 0, batches: [], loadError: error?.message || String(error || 'failed to load run') };
}

export async function readRunTaskText(runId) {
  return await readTextMaybe(path.join(pathForRun(runId), 'task.md'), 1000000);
}

export async function readRunFile(runId, taskId, name) {
  const runDir = pathForRun(runId);
  const allowed = new Set(['prompt.md','events.jsonl','events_timed.jsonl','events.pretty','stderr.log','last_message.md','exit_code','result.json','evidence.json','verdict.json','judge_input.json','manual_completion.json','manual_result.md','run.sh','run.ps1','run.cmd','run-cmd-helper.mjs','run-powershell-helper.mjs','tmux.json','package/job.json','package/prompt.md','package/workspace.json','package/execution.json','package/artifacts.json','package/manifest.json','package/job_events.jsonl']);
  if (!allowed.has(name)) throw new Error('file not allowed');
  let dir;
  if (taskId === 'planner') dir = roleDir(runDir, 'planner');
  else if (taskId === 'judge') dir = roleDir(runDir, 'judge');
  else dir = roleDir(runDir, 'worker', taskId);
  if (name === 'events.pretty') {
    const text = await readTextMaybe(path.join(dir, 'events.jsonl'), 1000000);
    return formatCodexEventsJsonl(text);
  }
  return await readTextMaybe(path.join(dir, name), 1000000);
}

export { RUNS_DIR };
