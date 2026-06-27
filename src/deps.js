import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { checkTmuxAvailable, DEFAULT_TMUX_BIN } from './tmux.js';
import { effectiveTmuxShell } from './config.js';
import { resolveTmuxShellBackend, normalizeTmuxShellConfig } from './tmuxShell.js';

const execFileAsync = promisify(execFile);
const COMMAND_EXISTS_TIMEOUT_MS = process.platform === 'win32' ? 5000 : 3000;

async function commandExists(command) {
  try {
    if (process.platform === 'win32') {
      await resolveWindowsCommandPath(command);
    } else {
      await execFileAsync('sh', ['-lc', `command -v ${shellWord(command)}`], { timeout: COMMAND_EXISTS_TIMEOUT_MS });
    }
    return true;
  } catch {
    return false;
  }
}

export function shellWord(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function resolveWindowsCommandPath(command) {
  const { stdout } = await execFileAsync('where.exe', [command], { timeout: COMMAND_EXISTS_TIMEOUT_MS, windowsHide: true });
  return String(stdout || '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || command;
}

async function commandForSpawn(plan, { platform = process.platform, resolveCommandPathImpl = resolveWindowsCommandPath } = {}) {
  if (platform !== 'win32' || String(plan?.command || '').toLowerCase() !== 'winget') return plan.command;
  try {
    return await resolveCommandPathImpl(plan.command);
  } catch (error) {
    throw new Error(`failed to resolve ${plan.command} executable before installation: ${error.message || String(error)}`);
  }
}

function plan(command, args, displayCommand, packageManager, notes = []) {
  return { command, args, displayCommand, packageManager, notes, available: true };
}

async function privilegedPlan(command, args, packageManager) {
  const baseDisplay = `${command} ${args.join(' ')}`;
  if (process.getuid?.() === 0) return plan(command, args, baseDisplay, packageManager);
  if (await commandExists('sudo')) return plan('sudo', [command, ...args], `sudo ${baseDisplay}`, packageManager);
  return { available: false, packageManager, displayCommand: '', notes: [`Install tmux manually with: ${baseDisplay}`] };
}

export async function tmuxInstallPlan() {
  if (process.platform === 'win32') {
    if (await commandExists('winget')) {
      return plan('winget', ['install', '--id', 'marlocarlo.psmux', '-e'], 'winget install --id marlocarlo.psmux -e', 'winget', [
        'Windows will install psmux, a third-party tmux-compatible implementation, not official tmux.',
        'You may install another tmux implementation manually; Input Kanban only requires a working tmux command.'
      ]);
    }
    return { available: false, packageManager: '', displayCommand: '', notes: ['Install psmux manually or install winget first.', 'You may install another tmux implementation manually; Input Kanban only requires a working tmux command.'] };
  }

  if (process.platform === 'darwin') {
    if (await commandExists('brew')) return plan('brew', ['install', 'tmux'], 'brew install tmux', 'brew');
    return { available: false, packageManager: '', displayCommand: '', notes: ['Install Homebrew or install tmux manually.'] };
  }

  const linuxCandidates = [
    ['apt-get', ['install', '-y', 'tmux'], 'apt-get'],
    ['dnf', ['install', '-y', 'tmux'], 'dnf'],
    ['pacman', ['-S', '--noconfirm', 'tmux'], 'pacman'],
    ['zypper', ['install', '-y', 'tmux'], 'zypper'],
    ['apk', ['add', 'tmux'], 'apk']
  ];
  for (const [command, args, packageManager] of linuxCandidates) {
    if (await commandExists(command)) return await privilegedPlan(command, args, packageManager);
  }
  return { available: false, packageManager: '', displayCommand: '', notes: ['Install tmux with your distribution package manager.'] };
}

function currentTmuxBin(tmuxBin) {
  return tmuxBin || process.env.KANBAN_TMUX_BIN || DEFAULT_TMUX_BIN;
}

export async function detectTmuxDependency({ tmuxBin, tmuxShell } = {}) {
  const resolvedTmuxBin = currentTmuxBin(tmuxBin);
  const status = await checkTmuxAvailable({ tmuxBin: resolvedTmuxBin });
  const installPlan = status.available ? null : await tmuxInstallPlan();
  const requestedTmuxShell = normalizeTmuxShellConfig(tmuxShell || await effectiveTmuxShell(), 'tmuxShell', { fallback: 'auto' });
  const shell = await resolveTmuxShellBackend(requestedTmuxShell);
  return {
    dependency: 'tmux',
    tmuxBin: resolvedTmuxBin,
    platform: process.platform,
    installed: status.available,
    available: status.available,
    version: status.version,
    shell,
    shellAvailable: !!shell.available,
    installPlan,
    installCommand: installPlan?.displayCommand || '',
    installNotes: installPlan?.notes || [],
    cliInstallCommand: 'input-kanban deps install tmux',
    installAvailable: !!installPlan?.available,
    installHint: status.available ? '' : (status.result?.stderr || status.result?.stdout || status.result?.error?.message || 'tmux command not found')
  };
}

export async function installTmux({ yes = false, dryRun = false, log = console.log, installPlan = null, spawnImpl = spawn, platform = process.platform, resolveCommandPathImpl = resolveWindowsCommandPath } = {}) {
  const before = await detectTmuxDependency();
  if (dryRun) {
    const plan = installPlan || before.installPlan || await tmuxInstallPlan();
    return { ok: true, dependency: 'tmux', dryRun: true, installed: before.installed, installPlan: plan, before };
  }
  if (before.installed) return { ok: true, dependency: 'tmux', installed: true, alreadyInstalled: true, before, after: before };
  const plan = installPlan || before.installPlan || await tmuxInstallPlan();
  if (!plan?.available) {
    const error = new Error(`no supported tmux installer found for ${process.platform}`);
    error.statusCode = 400;
    error.installPlan = plan;
    throw error;
  }
  if (!yes) {
    throw new Error(`confirmation required; rerun with --yes after reviewing: ${plan.displayCommand}`);
  }
  const spawnCommand = await commandForSpawn(plan, { platform, resolveCommandPathImpl });
  await new Promise((resolve, reject) => {
    log(`Running: ${plan.displayCommand}`);
    const child = spawnImpl(spawnCommand, plan.args, { stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${plan.command} exited with ${code}`)));
  });
  const after = await detectTmuxDependency();
  if (!after.installed) throw new Error('tmux installation command completed, but tmux -V still failed. If the installer changed PATH, open a new terminal and run detection again.');
  return { ok: true, dependency: 'tmux', installed: true, alreadyInstalled: false, installPlan: plan, before, after };
}
