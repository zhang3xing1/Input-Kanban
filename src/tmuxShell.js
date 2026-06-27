import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export const VALID_TMUX_SHELLS = ['auto'];

function normalizeTmuxShell(value = 'auto', source = 'tmuxShell') {
  const shell = String(value || 'auto').trim().toLowerCase();
  if (VALID_TMUX_SHELLS.includes(shell)) return shell;
  throw new Error(`invalid ${source}: ${value}; expected one of: ${VALID_TMUX_SHELLS.join(', ')}`);
}

export function normalizeTmuxShellConfig(value = 'auto', source = 'tmuxShell', { fallback = null } = {}) {
  try {
    return normalizeTmuxShell(value, source);
  } catch (error) {
    if (fallback !== null) return fallback;
    throw error;
  }
}

async function commandWorks(command, args = [], options = {}) {
  try {
    await execFileAsync(command, args, { timeout: options.timeoutMs || 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function detectPowerShell() {
  if (await commandWorks('pwsh', ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'])) return { command: 'pwsh', available: true };
  if (await commandWorks('powershell', ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'])) return { command: 'powershell', available: true };
  return { command: '', available: false };
}

async function detectCmd() {
  const available = await commandWorks('cmd.exe', ['/d', '/s', '/c', 'exit /b 0']);
  return { command: available ? 'cmd.exe' : '', available };
}

async function detectPosixShell() {
  if (await commandWorks('bash', ['-lc', 'true'])) return { command: 'bash', available: true };
  if (await commandWorks('sh', ['-lc', 'true'])) return { command: 'sh', available: true };
  return { command: '', available: false };
}

function unavailable(requested, reason) {
  return { requested, resolved: requested, available: false, command: '', scriptKind: '', scriptExt: '', reason };
}

export async function resolveTmuxShellBackend(value = 'auto', { platform = process.platform } = {}) {
  const requested = normalizeTmuxShellConfig(value, 'tmuxShell');
  if (platform !== 'win32') {
    const posix = await detectPosixShell();
    if (posix.available) return { requested, resolved: 'posix', available: true, command: posix.command, scriptKind: 'bash', scriptExt: '.sh' };
    return unavailable(requested, 'No usable sh/bash command was found for tmux runner scripts.');
  }

  if (requested === 'auto') {
    const ps = await detectPowerShell();
    if (ps.available) return { requested, resolved: 'powershell', available: true, command: ps.command, scriptKind: 'powershell', scriptExt: '.ps1' };
    const cmd = await detectCmd();
    if (cmd.available) return { requested, resolved: 'cmd', available: true, command: cmd.command, scriptKind: 'cmd', scriptExt: '.cmd' };
    return unavailable(requested, 'No usable PowerShell or cmd.exe command was found.');
  }
  return unavailable(requested, `Unsupported tmux shell backend: ${requested}`);
}

export function tmuxShellLaunchCommand(backend, scriptPath) {
  const kind = backend?.scriptKind || '';
  const command = backend?.command || '';
  if (kind === 'powershell') return `${command} -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
  if (kind === 'cmd') return `cmd.exe /d /s /c ""${scriptPath}""`;
  return scriptPath;
}

export function tmuxShellStatusLabel(backend) {
  if (!backend) return 'unknown';
  if (backend.available) return `${backend.resolved}${backend.command ? ` (${backend.command})` : ''}`;
  return `${backend.resolved || backend.requested}: ${backend.reason || 'unavailable'}`;
}

export function scriptPathForBackend(outDir, backend) {
  const ext = backend?.scriptExt || (process.platform === 'win32' ? '.ps1' : '.sh');
  return path.join(outDir, `run${ext}`);
}

export function pathForTmuxShellBackend(value, backend) {
  return value;
}
