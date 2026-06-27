import { headlessRunner, createHeadlessRunner } from './headlessRunner.js';
import { createTmuxRunner } from './tmuxRunner.js';

export { createHeadlessRunner, headlessRunner } from './headlessRunner.js';
export { createTmuxRunner } from './tmuxRunner.js';

export function createDefaultRunner(runnerMode = 'headless', options = {}) {
  if (runnerMode === 'tmux') return createTmuxRunner(options);
  const hasCustomOptions = Object.keys(options || {}).some(key => options[key] !== undefined);
  return hasCustomOptions ? createHeadlessRunner(options) : headlessRunner;
}

export const defaultRunner = createDefaultRunner();
