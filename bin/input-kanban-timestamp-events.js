#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const timedOnly = process.argv.includes('--timed-only');
const positional = process.argv.slice(2).filter(arg => arg !== '--timed-only');
const [eventsFile, timedEventsFile] = positional;
if (!eventsFile || !timedEventsFile) {
  console.error('usage: input-kanban-timestamp-events.js <events.jsonl> <events_timed.jsonl>');
  process.exit(2);
}

await fs.promises.mkdir(path.dirname(eventsFile), { recursive: true });
await fs.promises.mkdir(path.dirname(timedEventsFile), { recursive: true });

const events = fs.createWriteStream(eventsFile, { flags: 'a' });
const timed = fs.createWriteStream(timedEventsFile, { flags: 'a' });
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  const rawLine = `${line}\n`;
  if (!timedOnly) events.write(rawLine);
  process.stdout.write(rawLine);
  const receivedAt = new Date().toISOString();
  try {
    timed.write(`${JSON.stringify({ receivedAt, event: JSON.parse(line) })}\n`);
  } catch {
    timed.write(`${JSON.stringify({ receivedAt, rawLine: line })}\n`);
  }
}

await Promise.all([
  new Promise(resolve => events.end(resolve)),
  new Promise(resolve => timed.end(resolve))
]);
