import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { CODEX_BIN } from './utils.js';
import { resolveCodexLauncher } from './codexLauncher.js';

export class CodexAppServerClient {
  constructor() {
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.initialized = false;
    this.stderrTail = [];
    this.rl = null;
  }

  start() {
    if (this.proc) return this.proc;
    const { command, argsPrefix } = resolveCodexLauncher(CODEX_BIN);
    this.proc = spawn(command, [...argsPrefix, 'app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const proc = this.proc;
    const rl = readline.createInterface({ input: this.proc.stdout });
    this.rl = rl;
    rl.on('line', line => this.#handleLine(line));
    proc.stderr.on('data', d => this.#pushStderr(String(d)));
    proc.on('error', error => {
      this.#rejectPendingFor(proc, error);
      this.#clearProcess(proc, rl);
    });
    proc.on('exit', code => {
      this.#rejectPendingFor(proc, new Error(`app-server exited: ${code}`));
      this.#clearProcess(proc, rl);
    });
    return proc;
  }

  #rejectPendingFor(proc, error) {
    for (const [id, pending] of this.pending.entries()) {
      if (pending.proc !== proc) continue;
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  #rejectAllPending(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  #clearProcess(proc = this.proc, rl = this.rl) {
    rl?.close();
    if (this.rl === rl) this.rl = null;
    if (this.proc === proc) {
      this.proc = null;
      this.initialized = false;
    }
  }

  #pushStderr(s) {
    for (const line of s.split(/\r?\n/).filter(Boolean)) this.stderrTail.push(line);
    this.stderrTail = this.stderrTail.slice(-50);
  }

  #handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!Object.prototype.hasOwnProperty.call(msg, 'id')) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }

  async request(method, params = null, timeoutMs = 15000) {
    const proc = this.start();
    const id = this.nextId++;
    const msg = { id, method };
    if (params !== null) msg.params = params;
    return await new Promise((resolve, reject) => {
      let timer;
      let pending;
      const fail = error => {
        if (this.pending.get(id) !== pending) return;
        this.pending.delete(id);
        pending.reject(error);
      };
      pending = {
        proc,
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); }
      };
      timer = setTimeout(() => fail(new Error(`app-server request timeout: ${method}`)), timeoutMs);
      this.pending.set(id, pending);
      if (this.proc !== proc || !proc?.stdin?.writable || proc.stdin.destroyed) {
        fail(new Error(`app-server unavailable: ${method}`));
        return;
      }
      try {
        proc.stdin.write(JSON.stringify(msg) + '\n', error => {
          if (error) fail(error);
        });
      } catch (error) {
        fail(error);
      }
    });
  }

  async ensureInitialized() {
    if (this.initialized) return;
    await this.request('initialize', {
      clientInfo: { name: 'codex-orchestrator-kanban', version: '0.1.0' },
      capabilities: { experimentalApi: true }
    });
    this.initialized = true;
  }

  async listThreads({ cwd, limit = 100, searchTerm = null, timeoutMs = 20000 } = {}) {
    await this.ensureInitialized();
    return await this.request('thread/list', {
      cwd: cwd || null,
      sourceKinds: ['exec', 'appServer'],
      limit,
      searchTerm,
      sortDirection: 'desc',
      sortKey: 'created_at'
    }, timeoutMs);
  }

  stop() {
    if (!this.proc) return;
    const proc = this.proc;
    const rl = this.rl;
    this.proc.kill();
    this.#rejectAllPending(new Error('app-server stopped'));
    this.#clearProcess(proc, rl);
  }
}

export function matchThreadToMarkers(thread, runId, taskId) {
  const preview = thread?.preview || '';
  return preview.includes(`ORCHESTRATOR_RUN_ID: ${runId}`) && preview.includes(`ORCHESTRATOR_TASK_ID: ${taskId}`);
}
