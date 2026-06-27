import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_TMUX_BIN = process.env.KANBAN_TMUX_BIN || 'tmux';

export class TmuxUnavailableError extends Error {
  constructor(tmuxBin, result) {
    const detail = result?.stderr || result?.stdout || result?.error?.message || 'command failed';
    super(`tmux is unavailable: failed to run "${tmuxBin} -V" (${detail.trim()})`);
    this.name = 'TmuxUnavailableError';
    this.tmuxBin = tmuxBin;
    this.result = result;
  }
}

function normalizeResult(result) {
  return {
    code: Number.isInteger(result?.code) ? result.code : 0,
    stdout: result?.stdout || '',
    stderr: result?.stderr || '',
    error: result?.error
  };
}

async function defaultRunner(command, args, { timeoutMs = 3000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: timeoutMs, windowsHide: true });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const code = Number.isInteger(error?.code) ? error.code : error?.code === 'ENOENT' ? 127 : 1;
    return { code, stdout: error?.stdout || '', stderr: error?.stderr || error?.message || '', error };
  }
}

async function runCommand(command, args, options = {}) {
  const runner = options.runner || defaultRunner;
  return normalizeResult(await runner(command, args, { timeoutMs: options.timeoutMs || 3000 }));
}

function safeFallback(fallback) {
  const value = String(fallback || 'tmux')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
  return value || 'tmux';
}

export function sanitizeTmuxName(value, { fallback = 'tmux', maxLength = 80 } = {}) {
  const limit = Math.max(16, Number(maxLength) || 80);
  const original = String(value || '');
  let name = original
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');

  if (!name) name = safeFallback(fallback);
  if (name.length <= limit) return name;

  const hash = crypto.createHash('sha256').update(original || name).digest('hex').slice(0, 8);
  const prefixLength = Math.max(1, limit - hash.length - 1);
  const fallbackPrefix = safeFallback(fallback).slice(0, prefixLength);
  const prefix = name.slice(0, prefixLength).replace(/[^a-zA-Z0-9]+$/g, '') || fallbackPrefix;
  return `${prefix}-${hash}`.slice(0, limit);
}

export function sanitizeTmuxSessionName(value, options = {}) {
  return sanitizeTmuxName(value, { fallback: 'input-kanban', ...options });
}

export function sanitizeTmuxWindowName(value, options = {}) {
  return sanitizeTmuxName(value, { fallback: 'worker', ...options });
}

export async function checkTmuxAvailable(options = {}) {
  const tmuxBin = options.tmuxBin || DEFAULT_TMUX_BIN;
  const result = await runCommand(tmuxBin, ['-V'], options);
  const version = result.code === 0 ? result.stdout.trim() : '';
  const available = result.code === 0 && /^(tmux|psmux)\b/i.test(version);
  return {
    available,
    tmuxBin,
    version: available ? version : '',
    result
  };
}

export async function ensureTmuxAvailable(options = {}) {
  const status = await checkTmuxAvailable(options);
  if (!status.available) throw new TmuxUnavailableError(status.tmuxBin, status.result);
  return status;
}

export async function runTmux(args, options = {}) {
  const tmuxBin = options.tmuxBin || DEFAULT_TMUX_BIN;
  await ensureTmuxAvailable({ ...options, tmuxBin });
  const result = await runCommand(tmuxBin, args, options);
  if (result.code !== 0) {
    const detail = result.stderr || result.stdout || 'command failed';
    throw new Error(`tmux command failed: ${tmuxBin} ${args.join(' ')} (${detail.trim()})`);
  }
  return result;
}

export async function tmuxHasSession(sessionName, options = {}) {
  const tmuxBin = options.tmuxBin || DEFAULT_TMUX_BIN;
  const session = sanitizeTmuxSessionName(sessionName);
  await ensureTmuxAvailable({ ...options, tmuxBin });
  const result = await runCommand(tmuxBin, ['has-session', '-t', session], options);
  return result.code === 0;
}

export async function tmuxNewSession(sessionName, options = {}) {
  const session = sanitizeTmuxSessionName(sessionName);
  const args = ['new-session', '-d', '-s', session];
  if (options.windowName) args.push('-n', sanitizeTmuxWindowName(options.windowName));
  if (options.cwd) args.push('-c', options.cwd);
  if (options.command) args.push(options.command);
  return runTmux(args, options);
}

export async function tmuxNewWindow(sessionName, windowName, options = {}) {
  const session = sanitizeTmuxSessionName(sessionName);
  const window = sanitizeTmuxWindowName(windowName);
  const args = ['new-window', '-t', session, '-n', window];
  if (options.cwd) args.push('-c', options.cwd);
  if (options.command) args.push(options.command);
  return runTmux(args, options);
}

export async function tmuxKillSession(sessionName, options = {}) {
  return runTmux(['kill-session', '-t', sanitizeTmuxSessionName(sessionName)], options);
}

export async function tmuxSplitWindow(sessionName, windowName, options = {}) {
  const session = sanitizeTmuxSessionName(sessionName);
  const window = sanitizeTmuxWindowName(windowName);
  const args = ['split-window', '-t', `${session}:${window}`];
  if (options.vertical) args.push('-v');
  else args.push('-h');
  if (options.printPane || options.format) args.push('-P', '-F', options.format || '#{pane_id}');
  if (options.cwd) args.push('-c', options.cwd);
  if (options.command) args.push(options.command);
  return runTmux(args, options);
}

export async function tmuxSendLine(sessionName, windowName, line, options = {}) {
  const session = sanitizeTmuxSessionName(sessionName);
  const window = sanitizeTmuxWindowName(windowName);
  const target = String(options.target || '').trim() || `${session}:${window}`;
  await runTmux(['send-keys', '-t', target, '-l', String(line || '')], options);
  return runTmux(['send-keys', '-t', target, 'C-m'], options);
}

export async function tmuxSelectLayout(sessionName, windowName, layout = 'tiled', options = {}) {
  const session = sanitizeTmuxSessionName(sessionName);
  const window = sanitizeTmuxWindowName(windowName);
  return runTmux(['select-layout', '-t', `${session}:${window}`, layout], options);
}

export async function tmuxKillWindow(sessionName, windowName, options = {}) {
  const session = sanitizeTmuxSessionName(sessionName);
  const window = sanitizeTmuxWindowName(windowName);
  return runTmux(['kill-window', '-t', `${session}:${window}`], options);
}
