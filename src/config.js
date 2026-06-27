import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VALID_RUNNERS, normalizeRunner } from './utils.js';

export { VALID_RUNNERS };
const CONFIG_KEYS = new Set(['defaultRunner']);
let configWriteQueue = Promise.resolve();

// Config normalization accepts a fallback for persisted/local defaults; runtime
// runner normalization remains strict in utils.normalizeRunner.
export function normalizeRunnerConfig(value = 'headless', source = 'runner', { fallback = null } = {}) {
  try {
    return normalizeRunner(value, source);
  } catch (error) {
    if (fallback !== null) return fallback;
    throw error;
  }
}

export function configPath() {
  if (process.env.KANBAN_CONFIG_PATH) return path.resolve(process.env.KANBAN_CONFIG_PATH);
  const home = os.homedir?.() || process.env.USERPROFILE || process.env.HOME || process.cwd();
  return path.join(home, '.input-kanban', 'config.json');
}

function configReadError(file, error) {
  const wrapped = new Error(`failed to read Input Kanban config at ${file}: ${error.message}`);
  wrapped.statusCode = 500;
  wrapped.cause = error;
  return wrapped;
}

function configParseError(file, detail) {
  const wrapped = new Error(`invalid Input Kanban config at ${file}: ${detail}`);
  wrapped.statusCode = 400;
  return wrapped;
}

function parseLocalConfigText(text, file) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw configParseError(file, error.message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw configParseError(file, 'expected a JSON object');
  }
  return parsed;
}

export function readLocalConfigSync() {
  const file = configPath();
  try {
    return parseLocalConfigText(fs.readFileSync(file, 'utf8'), file);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    if (error.statusCode) throw error;
    throw configReadError(file, error);
  }
}

export async function readLocalConfig() {
  const file = configPath();
  try {
    return parseLocalConfigText(await fsp.readFile(file, 'utf8'), file);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    if (error.statusCode) throw error;
    throw configReadError(file, error);
  }
}

export async function writeLocalConfig(nextConfig) {
  const file = configPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tempFile = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(tempFile, `${JSON.stringify(nextConfig, null, 2)}\n`);
  await fsp.rename(tempFile, file);
  return nextConfig;
}

export function configuredDefaultRunnerSync() {
  const config = readLocalConfigSync();
  return normalizeRunnerConfig(config.defaultRunner, 'defaultRunner', { fallback: 'headless' });
}

export async function configuredDefaultRunner() {
  const config = await readLocalConfig();
  return normalizeRunnerConfig(config.defaultRunner, 'defaultRunner', { fallback: 'headless' });
}

export function effectiveRunnerSync() {
  if (process.env.KANBAN_RUNNER) return normalizeRunnerConfig(process.env.KANBAN_RUNNER, 'KANBAN_RUNNER');
  return configuredDefaultRunnerSync();
}

export async function effectiveRunner() {
  if (process.env.KANBAN_RUNNER) return normalizeRunnerConfig(process.env.KANBAN_RUNNER, 'KANBAN_RUNNER');
  return await configuredDefaultRunner();
}

export function effectiveTmuxShellSync() {
  return 'auto';
}

export async function effectiveTmuxShell() {
  return 'auto';
}

async function updateLocalConfigUnlocked(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    const error = new Error('config patch must be a JSON object');
    error.statusCode = 400;
    throw error;
  }
  for (const key of Object.keys(patch)) {
    if (!CONFIG_KEYS.has(key)) {
      const error = new Error(`unsupported config key: ${key}`);
      error.statusCode = 400;
      throw error;
    }
  }
  const current = await readLocalConfig();
  const next = { ...current };
  if (Object.hasOwn(patch, 'defaultRunner')) {
    next.defaultRunner = normalizeRunnerConfig(patch.defaultRunner, 'defaultRunner');
  }
  return await writeLocalConfig(next);
}

export function updateLocalConfig(patch = {}) {
  const run = () => updateLocalConfigUnlocked(patch);
  const next = configWriteQueue.then(run, run);
  configWriteQueue = next.catch(() => {});
  return next;
}
