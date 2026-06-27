import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('updateLocalConfig queues writes and recovers after rejected patches', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-config-queue-'));
  const previousConfigPath = process.env.KANBAN_CONFIG_PATH;
  process.env.KANBAN_CONFIG_PATH = path.join(tmp, 'config.json');
  const { readLocalConfig, updateLocalConfig } = await import(`../src/config.js?queue=${Date.now()}`);

  try {
    await assert.rejects(
      () => updateLocalConfig({ defaultRunner: 'future-runner' }),
      /invalid defaultRunner: future-runner/
    );

    await Promise.all([
      updateLocalConfig({ defaultRunner: 'tmux' }),
      updateLocalConfig({ defaultRunner: 'headless' })
    ]);

    assert.deepEqual(await readLocalConfig(), { defaultRunner: 'headless' });
  } finally {
    if (previousConfigPath === undefined) delete process.env.KANBAN_CONFIG_PATH;
    else process.env.KANBAN_CONFIG_PATH = previousConfigPath;
  }
});

test('local config rejects tmux shell defaults because shell selection is automatic', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'input-kanban-config-no-tmux-shell-'));
  const previousConfigPath = process.env.KANBAN_CONFIG_PATH;
  process.env.KANBAN_CONFIG_PATH = path.join(tmp, 'config.json');
  const { readLocalConfig, updateLocalConfig, effectiveTmuxShell } = await import(`../src/config.js?tmux-shell=${Date.now()}`);

  try {
    await assert.rejects(
      () => updateLocalConfig({ defaultTmuxShell: 'powershell' }),
      /unsupported config key: defaultTmuxShell/
    );
    assert.deepEqual(await readLocalConfig(), {});
    assert.equal(await effectiveTmuxShell(), 'auto');
  } finally {
    if (previousConfigPath === undefined) delete process.env.KANBAN_CONFIG_PATH;
    else process.env.KANBAN_CONFIG_PATH = previousConfigPath;
  }
});
