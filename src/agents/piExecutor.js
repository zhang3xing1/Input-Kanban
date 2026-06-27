import fs from 'node:fs';
import path from 'node:path';
import { PI_BIN } from '../utils.js';
import { resolveCodexLauncher } from '../codexLauncher.js';

const DEFAULT_PI_PACKAGE = '@earendil-works/pi-coding-agent';

function messageText(message) {
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(block => {
      if (!block || typeof block !== 'object') return '';
      if (block.type === 'text') return String(block.text || '');
      if (typeof block.text === 'string') return block.text;
      if (typeof block.content === 'string') return block.content;
      return '';
    })
    .filter(Boolean)
    .join('');
}

function writeLastAssistantMessage(event, lastMessagePath) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    const text = messageText(event.message);
    if (text) fs.writeFileSync(lastMessagePath, text);
    return;
  }
  if (event.type === 'agent_end' && Array.isArray(event.messages)) {
    const assistantMessage = [...event.messages].reverse().find(message => message?.role === 'assistant');
    const text = messageText(assistantMessage);
    if (text) fs.writeFileSync(lastMessagePath, text);
  }
}

export function createPiExecutor({ piBin = PI_BIN, packageName = DEFAULT_PI_PACKAGE } = {}) {
  function prepareHeadlessTask({ prompt, outDir, runId = '', taskId = '' }) {
    const promptFile = path.join(outDir, 'prompt.md');
    const events = path.join(outDir, 'events.jsonl');
    const timedEvents = path.join(outDir, 'events_timed.jsonl');
    const stderr = path.join(outDir, 'stderr.log');
    const lastMessage = path.join(outDir, 'last_message.md');
    const exitCode = path.join(outDir, 'exit_code');
    fs.writeFileSync(promptFile, prompt);
    const { command, argsPrefix } = resolveCodexLauncher(piBin);
    return {
      kind: 'pi',
      command,
      args: [...argsPrefix, '--mode', 'json', prompt],
      paths: { prompt: promptFile, events, timedEvents, stderr, lastMessage, exitCode },
      onStdoutLine(line) {
        try { writeLastAssistantMessage(JSON.parse(line), lastMessage); } catch {}
      },
      installCommand: `npm install -g --ignore-scripts ${packageName}`
    };
  }

  async function prepareTmuxTask() {
    throw new Error('pi backend currently supports headless runner only');
  }

  return { kind: 'pi', piBin, prepareHeadlessTask, prepareTmuxTask };
}

export const piExecutor = createPiExecutor();
