import http from 'node:http';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CodexAppServerClient } from './appServerClient.js';
import { APP_ROOT, CODEX_BIN, DEFAULT_WORKSPACE, DEFAULT_REPO, PACKAGE_VERSION, PI_BIN, RUNS_DIR, detectCodexInfo, detectPiInfo, normalizeRunner } from './utils.js';
import { configPath, effectiveRunner, readLocalConfig, updateLocalConfig } from './config.js';
import { detectTmuxDependency } from './deps.js';
import { createRun, listRuns, startPlanner, dispatchRun, startJudge, refreshRun, snapshotRun, readRunFile, readRunTaskText, markTaskCompleted, stopRun, archiveRun, renameRun, retryRun } from './orchestrator.js';
import { startAutoScheduler } from './scheduler.js';

const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const AGENT_INFO_TTL_MS = 30000;
const STATUS_REFRESH_LOCK_TIMEOUT_MS = Number(process.env.KANBAN_STATUS_REFRESH_LOCK_TIMEOUT_MS || 1200);
const STATUS_APP_SERVER_TIMEOUT_MS = Number(process.env.KANBAN_STATUS_APP_SERVER_TIMEOUT_MS || 300);
const STATUS_APP_SERVER_CACHE_TTL_MS = Number(process.env.KANBAN_STATUS_APP_SERVER_CACHE_TTL_MS || 30000);
const STATUS_APP_SERVER_ERROR_TTL_MS = Number(process.env.KANBAN_STATUS_APP_SERVER_ERROR_TTL_MS || 15000);
const SERVER_CLOSE_FORCE_AFTER_MS = Number(process.env.KANBAN_SERVER_CLOSE_FORCE_AFTER_MS || 3000);
const execFileAsync = promisify(execFile);
let codexInfoCache = null;
let piInfoCache = null;
const statusAppServerCache = new Map();

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body, null, 2) : body;
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8` });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch (error) {
    const invalid = new Error(`invalid JSON request body: ${error.message}`);
    invalid.statusCode = 400;
    throw invalid;
  }
}

async function readJsonObject(req) {
  const body = await readBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('JSON request body must be an object');
    error.statusCode = 400;
    throw error;
  }
  return body;
}

const CREATE_RUN_KEYS = new Set(['label', 'taskText', 'workspace', 'repo', 'maxParallel', 'workerSandbox', 'workerBackend', 'planApproval', 'requiresPlanApproval', 'codexSkipGitRepoCheck', 'runner']);

function sanitizeCreateRunBody(body) {
  for (const key of Object.keys(body)) {
    if (!CREATE_RUN_KEYS.has(key)) {
      const error = new Error(`unsupported create run key: ${key}`);
      error.statusCode = 400;
      throw error;
    }
  }
  return body;
}

function notFound(res) { send(res, 404, { error: 'not found' }); }
function methodNotAllowed(res) { send(res, 405, { error: 'method not allowed' }); }

async function cachedCodexInfo(nowMs = Date.now()) {
  if (codexInfoCache && codexInfoCache.expiresAt > nowMs) return codexInfoCache.value;
  const value = await detectCodexInfo();
  codexInfoCache = { value, expiresAt: nowMs + AGENT_INFO_TTL_MS };
  return value;
}

async function cachedPiInfo(nowMs = Date.now()) {
  if (piInfoCache && piInfoCache.expiresAt > nowMs) return piInfoCache.value;
  const value = await detectPiInfo();
  piInfoCache = { value, expiresAt: nowMs + AGENT_INFO_TTL_MS };
  return value;
}

function statusAppServerCacheKey({ cwd = '', limit = 100, searchTerm = null } = {}) {
  return JSON.stringify({ cwd: cwd || null, limit, searchTerm: searchTerm || null });
}

function cachedStatusAppClient(appClient) {
  return {
    async listThreads(params = {}) {
      const key = statusAppServerCacheKey(params);
      const now = Date.now();
      const cached = statusAppServerCache.get(key);
      if (cached) {
        const ttl = cached.ok ? STATUS_APP_SERVER_CACHE_TTL_MS : STATUS_APP_SERVER_ERROR_TTL_MS;
        if (now - cached.at < ttl) {
          if (cached.ok) return cached.value;
          throw new Error(cached.error);
        }
      }
      try {
        const value = await appClient.listThreads({ ...params, timeoutMs: STATUS_APP_SERVER_TIMEOUT_MS });
        statusAppServerCache.set(key, { ok: true, at: Date.now(), value });
        return value;
      } catch (error) {
        const message = error?.message || String(error || 'unknown app-server error');
        statusAppServerCache.set(key, { ok: false, at: Date.now(), error: message });
        throw new Error(message);
      }
    }
  };
}

function threadTimeValue(thread, keys) {
  for (const key of keys) {
    const value = thread?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function hasAppServerThreadMarkers(thread) {
  const preview = String(thread?.preview || '');
  return preview.includes('ORCHESTRATOR_RUN_ID: ') && preview.includes('ORCHESTRATOR_TASK_ID: ');
}

function previewThreadTitle(preview) {
  const lines = String(preview || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^ORCHESTRATOR_[A-Z_]+:\s*/.test(line)) continue;
    if (/^[A-Z0-9_]+:\s*/.test(line)) continue;
    if (line === '{' || line === '}' || line === '[' || line === ']') continue;
    return line;
  }
  return '';
}

function normalizeStringField(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeThreadStatus(thread) {
  const rawStatus = thread?.status;
  if (typeof rawStatus === 'string' && rawStatus.trim()) return rawStatus.trim();
  if (rawStatus && typeof rawStatus === 'object') {
    const candidate = rawStatus.label || rawStatus.name || rawStatus.state || rawStatus.status || rawStatus.text;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  const fallback = normalizeStringField(thread?.state);
  return fallback || 'unknown';
}

function normalizeThreadSource(thread) {
  const rawSource = thread?.source;
  if (typeof rawSource === 'string' && rawSource.trim()) return rawSource.trim();
  if (rawSource && typeof rawSource === 'object') {
    const candidate = rawSource.label || rawSource.name || rawSource.kind || rawSource.source;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return normalizeStringField(thread?.sourceKind) || normalizeStringField(thread?.source_kind) || '';
}

function normalizeAppServerThread(thread) {
  const sessionId = String(thread?.sessionId || thread?.session_id || thread?.id || thread?.threadId || '').trim();
  const startedAt = threadTimeValue(thread, ['startedAt', 'started_at', 'createdAt', 'created_at', 'createdTime', 'created_time']);
  const updatedAt = threadTimeValue(thread, ['updatedAt', 'updated_at', 'modifiedAt', 'modified_at', 'lastActiveAt', 'last_active_at']) || startedAt;
  const previewTitle = previewThreadTitle(thread?.preview);
  const rawTitle = normalizeStringField(thread?.title) || normalizeStringField(thread?.name) || normalizeStringField(thread?.subject);
  const title = rawTitle || previewTitle || '会话';
  return {
    id: String(thread?.id || sessionId || '').trim(),
    title,
    sessionId: sessionId || String(thread?.id || '').trim(),
    status: normalizeThreadStatus(thread),
    source: normalizeThreadSource(thread),
    startedAt,
    updatedAt,
    boardManaged: hasAppServerThreadMarkers(thread)
  };
}

function sortThreadListDesc(left, right) {
  const leftMs = Date.parse(left.updatedAt || left.startedAt || '') || 0;
  const rightMs = Date.parse(right.updatedAt || right.startedAt || '') || 0;
  return rightMs - leftMs || String(right.sessionId || '').localeCompare(String(left.sessionId || ''));
}

function parsePsElapsedSeconds(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const dayParts = text.split('-');
  const days = dayParts.length === 2 ? Number(dayParts[0]) || 0 : 0;
  const timeText = dayParts.at(-1) || '';
  const parts = timeText.split(':').map(part => Number(part) || 0);
  if (parts.length === 3) return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return days * 86400 + parts[0] * 60 + parts[1];
  return days * 86400 + (parts[0] || 0);
}

function isCodexRelatedCommand(command) {
  const text = String(command || '').toLowerCase();
  if (!text.includes('codex')) return false;
  return /(^|[\s/.-])codex([\s/.-]|$)/.test(text) || text.includes('@openai/codex') || text.includes('codex-cli') || text.includes('app-server');
}

async function listCodexProcesses() {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,WorkingSetSize,CreationDate | ConvertTo-Json -Compress`], { maxBuffer: 1024 * 1024 });
    const parsed = stdout ? JSON.parse(stdout) : [];
    const processes = (Array.isArray(parsed) ? parsed : [parsed])
      .map(item => {
        const command = String(item?.CommandLine || '').trim();
        if (!isCodexRelatedCommand(command)) return null;
        const sessionMatch = command.match(/\bcodex\s+resume\s+([A-Za-z0-9._:-]+)\b/i);
        return {
          pid: Number(item?.ProcessId) || 0,
          ppid: Number(item?.ParentProcessId) || 0,
          cpuPercent: 0,
          memoryPercent: 0,
          rssMb: Math.round(((Number(item?.WorkingSetSize) || 0) / 1024 / 1024) * 10) / 10,
          elapsed: '',
          elapsedSeconds: null,
          command,
          sessionId: sessionMatch?.[1] || '',
          isSelf: Number(item?.ProcessId) === process.pid
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.rssMb - left.rssMb || left.pid - right.pid);
    return processes;
  }
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,pcpu=,pmem=,rss=,etime=,command='], { maxBuffer: 1024 * 1024 });
  const processes = stdout.split(/\r?\n/)
    .map(line => {
      const match = String(line || '').match(/^\s*(\d+)\s+(\d+)\s+([0-9.]+)\s+([0-9.]+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) return null;
      const [, pid, ppid, cpu, mem, rssKb, elapsed, command] = match;
      const sessionMatch = command.match(/\bcodex\s+resume\s+([A-Za-z0-9._:-]+)\b/i);
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        cpuPercent: Number(cpu) || 0,
        memoryPercent: Number(mem) || 0,
        rssMb: Math.round(((Number(rssKb) || 0) / 1024) * 10) / 10,
        elapsed,
        elapsedSeconds: parsePsElapsedSeconds(elapsed),
        command: command.trim(),
        sessionId: sessionMatch?.[1] || '',
        isSelf: Number(pid) === process.pid
      };
    })
    .filter(Boolean)
    .filter(processInfo => isCodexRelatedCommand(processInfo.command))
    .sort((left, right) => right.rssMb - left.rssMb || left.pid - right.pid);
  return processes;
}

async function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname.replace(/^\/+/, ''));
  file = path.resolve(file);
  if (!file.startsWith(PUBLIC_DIR)) return notFound(res);
  try {
    const data = await fsp.readFile(file);
    const ext = path.extname(file);
    const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : ext === '.png' ? 'image/png' : ext === '.svg' ? 'image/svg+xml' : 'text/plain';
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
    res.end(data);
  } catch { notFound(res); }
}

async function handleApi(req, res, url, appClient) {
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      let runner = 'headless';
      let configError = '';
      try {
        runner = await effectiveRunner();
      } catch (error) {
        configError = error?.message || String(error);
      }
      return send(res, 200, { ok: true, version: PACKAGE_VERSION, appRoot: APP_ROOT, runsDir: RUNS_DIR, defaultWorkspace: DEFAULT_WORKSPACE, defaultRepo: DEFAULT_REPO, runner, runnerEnvOverride: !!process.env.KANBAN_RUNNER, configError, codexBin: CODEX_BIN, piBin: PI_BIN });
    }
    if (req.method === 'GET' && url.pathname === '/api/codex') {
      return send(res, 200, { ok: true, codex: await cachedCodexInfo() });
    }
    if (req.method === 'GET' && url.pathname === '/api/pi') {
      return send(res, 200, { ok: true, pi: await cachedPiInfo() });
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      const config = await readLocalConfig();
      return send(res, 200, {
        ok: true,
        configPath: configPath(),
        config,
        effective: { runner: await effectiveRunner(), runnerEnvOverride: !!process.env.KANBAN_RUNNER }
      });
    }
    if (req.method === 'PATCH' && url.pathname === '/api/config') {
      const body = await readJsonObject(req);
      if (process.env.KANBAN_RUNNER && Object.hasOwn(body, 'defaultRunner')) {
        return send(res, 400, { error: 'KANBAN_RUNNER is set; remove the environment override before changing default runner from Web' });
      }
      const config = await updateLocalConfig(body);
      return send(res, 200, { ok: true, configPath: configPath(), config, effective: { runner: await effectiveRunner(), runnerEnvOverride: !!process.env.KANBAN_RUNNER } });
    }
    if (req.method === 'GET' && url.pathname === '/api/tmux') {
      return send(res, 200, { ok: true, tmux: await detectTmuxDependency() });
    }
    if (req.method === 'GET' && url.pathname === '/api/session-management') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100) || 100));
      const response = await appClient.listThreads({ limit });
      const threads = (response?.data || []).map(normalizeAppServerThread).filter(thread => thread.sessionId).sort(sortThreadListDesc);
      return send(res, 200, { ok: true, threads, total: threads.length });
    }
    if (req.method === 'GET' && url.pathname === '/api/session-management/processes') {
      const processes = await listCodexProcesses();
      return send(res, 200, { ok: true, processes, total: processes.length });
    }
    if (parts[1] === 'runs' && parts.length === 2) {
      if (req.method === 'GET') return send(res, 200, { runs: await listRuns({ includeArchived: url.searchParams.get('includeArchived') === '1', workspace: url.searchParams.get('workspace') || '' }) });
      if (req.method === 'POST') {
        const body = sanitizeCreateRunBody(await readJsonObject(req));
        const hasRunner = Object.hasOwn(body, 'runner');
        if (hasRunner && !String(body.runner || '').trim()) return send(res, 400, { error: 'runner cannot be empty' });
        const requestedRunner = hasRunner ? normalizeRunner(body.runner, 'runner') : await effectiveRunner();
        body.runner = requestedRunner;
        if (!Object.hasOwn(body, 'workerBackend')) body.workerBackend = process.env.KANBAN_WORKER_BACKEND || 'codex';
        return send(res, 201, await createRun(body));
      }
      return methodNotAllowed(res);
    }
    if (parts[1] === 'runs' && parts.length >= 3) {
      const runId = parts[2];
      if (parts.length === 4 && parts[3] === 'status' && req.method === 'GET') {
        const shouldRefresh = ['1', 'true', 'yes'].includes(String(url.searchParams.get('refresh') || '').toLowerCase());
        const state = shouldRefresh
          ? await refreshRun(runId, cachedStatusAppClient(appClient), { lockTimeoutMs: STATUS_REFRESH_LOCK_TIMEOUT_MS, fallbackOnLockBusy: true })
          : await snapshotRun(runId);
        return send(res, 200, state);
      }
      if (parts.length === 4 && parts[3] === 'plan' && req.method === 'POST') return send(res, 202, await startPlanner(runId));
      if (parts.length === 4 && parts[3] === 'dispatch' && req.method === 'POST') return send(res, 202, await dispatchRun(runId));
      if (parts.length === 4 && parts[3] === 'judge' && req.method === 'POST') return send(res, 202, await startJudge(runId));
      if (parts.length === 4 && parts[3] === 'retry' && req.method === 'POST') {
        const body = await readJsonObject(req);
        return send(res, 200, await retryRun(runId, body));
      }
      if (parts.length === 4 && parts[3] === 'stop' && req.method === 'POST') {
        const body = await readJsonObject(req);
        return send(res, 200, await stopRun(runId, body));
      }
      if (parts.length === 4 && parts[3] === 'archive' && req.method === 'POST') {
        const body = await readJsonObject(req);
        return send(res, 200, await archiveRun(runId, body));
      }
      if (parts.length === 4 && parts[3] === 'label' && req.method === 'PATCH') {
        const body = await readJsonObject(req);
        return send(res, 200, await renameRun(runId, body));
      }
      if (parts.length === 4 && parts[3] === 'task-text' && req.method === 'GET') return send(res, 200, await readRunTaskText(runId), 'text/plain');
      if (parts.length === 6 && parts[3] === 'tasks' && parts[5] === 'file' && req.method === 'GET') {
        const text = await readRunFile(runId, parts[4], url.searchParams.get('name') || 'last_message.md');
        return send(res, 200, text, 'text/plain');
      }
      if (parts.length === 6 && parts[3] === 'tasks' && parts[5] === 'mark-completed' && req.method === 'POST') {
        const body = await readJsonObject(req);
        return send(res, 200, await markTaskCompleted(runId, parts[4], body));
      }
    }
    notFound(res);
  } catch (e) {
    send(res, e.statusCode || 500, { error: e.message, ...(e.tmux ? { tmux: e.tmux } : {}) });
  }
}

export function createHttpServer({ appClient = new CodexAppServerClient() } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, appClient);
    return await serveStatic(req, res, url.pathname);
  });
}

export async function closeHttpServerGracefully(server, { forceAfterMs = SERVER_CLOSE_FORCE_AFTER_MS } = {}) {
  let closed = false;
  const closePromise = new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
  server.closeIdleConnections?.();
  const forceTimer = server.closeAllConnections && Number.isFinite(forceAfterMs) && forceAfterMs >= 0
    ? setTimeout(() => {
      if (!closed) server.closeAllConnections();
    }, forceAfterMs)
    : null;
  forceTimer?.unref?.();
  try {
    await closePromise;
  } finally {
    closed = true;
    if (forceTimer) clearTimeout(forceTimer);
  }
}

export async function startServer({ host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 8787), log = true, scheduler = true } = {}) {
  const runner = await effectiveRunner().catch(() => 'unavailable');
  const appClient = new CodexAppServerClient();
  const server = createHttpServer({ appClient });
  const autoScheduler = scheduler ? startAutoScheduler({ appClient, log }) : null;
  await new Promise(resolve => server.listen(port, host, resolve));
  const url = `http://${host}:${port}`;
  if (log) console.log(`input-kanban listening on ${url}`);
  const stop = async () => {
    autoScheduler?.stop();
    appClient.stop();
    await closeHttpServerGracefully(server);
  };
  return { server, appClient, autoScheduler, host, port, url, version: PACKAGE_VERSION, defaultWorkspace: DEFAULT_WORKSPACE, defaultRepo: DEFAULT_REPO, runsDir: RUNS_DIR, runner, scheduler: !!autoScheduler, stop };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const instance = await startServer();
  const shutdown = () => { instance.stop().finally(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
