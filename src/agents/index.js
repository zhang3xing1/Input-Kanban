export {
  buildCodexExecArgs,
  buildCodexTmuxRunScript,
  codexExecutor,
  codexTaskPaths,
  createCodexExecutor
} from './codexExecutor.js';
export {
  createPiExecutor,
  piExecutor
} from './piExecutor.js';

import { createCodexExecutor } from './codexExecutor.js';
import { createPiExecutor } from './piExecutor.js';

export function createAgentExecutor(backend, options = {}) {
  if (backend === 'pi') return createPiExecutor(options);
  return createCodexExecutor(options);
}
