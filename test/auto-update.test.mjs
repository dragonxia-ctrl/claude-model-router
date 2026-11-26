import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAutoUpdater, readAutoUpdateState, writeAutoUpdateState,
} from '../src/auto-update.mjs';

const T0 = Date.parse('2026-11-26T00:00:00.000Z');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-autoupdate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'router-update.mjs'), '// updater\n');
  return dir;
}

function harness({ dir, auto = true, info = { updateAvailable: true, latest: 'v1.4.0' }, clock = { now: T0 }, source, isAlive } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return { pid: 4242, unref() {} };
  };
  const config = {
    router: { port: 17861 },
    updates: { auto, source: source || dir },
  };
  const updater = createAutoUpdater({
    dataDir: dir,
    getConfig: () => config,
    updateChecker: { refresh: async () => info },
    spawnImpl,
    now: () => clock.now,
    // Deterministic process liveness: state fixtures name pids that do not
    // exist on the test machine.
    ...(isAlive ? { isAlive } : {}),
  });
  return { updater, calls, config };
}

test('an enabled switch starts a detached updater for a newer release', async t => {
  const dir = setup(t);
  const { updater, calls } = harness({ dir });
  const result = await updater.tick();
  assert.equal(result.action, 'spawned');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.equal(calls[0].args[0], path.join(dir, 'router-update.mjs'));
  assert.ok(calls[0].args.includes('--auto-install'));
  assert.ok(calls[0].args.includes('--data-dir'));
  assert.equal(calls[0].options.detached, true);

  const state = readAutoUpdateState(dir);
  assert.equal(state.status, 'running');
  assert.equal(state.version, 'v1.4.0');
  assert.equal(state.pid, 4242);
  assert.ok(fs.existsSync(path.join(dir, 'auto-update.log')));
});

test('a switched-off router never starts the updater', async t => {
  const dir = setup(t);
  const { updater, calls } = harness({ dir, auto: false });
  const result = await updater.tick();
  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'disabled');
  assert.equal(calls.length, 0);
});

test('the updater is not started while a recent run is alive', async t => {
  const dir = setup(t);
  const { updater, calls } = harness({ dir, isAlive: () => true });
  writeAutoUpdateState(dir, {
    status: 'running',
    pid: process.pid,
    version: 'v1.4.0',
    startedAt: new Date(T0 - 60_000).toISOString(),
    lastVersion: 'v1.4.0',
    lastAttemptAt: new Date(T0 - 60_000).toISOString(),
  });
  const result = await updater.tick();
  assert.equal(result.reason, 'running');
  assert.equal(calls.length, 0);
});

test('a detached updater that died is reported as failed, not running', async t => {
  const dir = setup(t);
  const { updater, calls } = harness({ dir, isAlive: () => false });
  writeAutoUpdateState(dir, {
    status: 'running',
    pid: 999_999,
    version: 'v1.4.0',
    startedAt: new Date(T0 - 5 * 60_000).toISOString(),
    lastVersion: 'v1.4.0',
    lastAttemptAt: new Date(T0 - 5 * 60_000).toISOString(),
  });
  const result = await updater.tick();
  assert.equal(result.reason, 'backoff');
  assert.equal(calls.length, 0);
  assert.equal(readAutoUpdateState(dir).status, 'failed');
});

test('a failed release is retried only after the backoff window', async t => {
  const dir = setup(t);
  const clock = { now: T0 };
  const { updater, calls } = harness({ dir, clock });
  writeAutoUpdateState(dir, {
    status: 'failed',
    version: 'v1.4.0',
    lastVersion: 'v1.4.0',
    lastAttemptAt: new Date(T0 - 10 * 60_000).toISOString(),
    message: 'uncommitted changes',
  });
  assert.equal((await updater.tick()).reason, 'backoff');
  assert.equal(calls.length, 0);

  clock.now = T0 + 2 * 60 * 60_000;
  assert.equal((await updater.tick()).action, 'spawned');
  assert.equal(calls.length, 1);
});

test('installed files that only await a restart are not deployed again', async t => {
  const dir = setup(t);
  const { updater, calls } = harness({ dir });
  writeAutoUpdateState(dir, {
    status: 'ok',
    version: '1.4.0',
    lastVersion: '1.4.0',
    lastAttemptAt: new Date(T0 - 10 * 60_000).toISOString(),
  });
  assert.equal((await updater.tick()).reason, 'installed');
  assert.equal(calls.length, 0);
});

test('a missing source checkout is reported and backed off', async t => {
  const dir = setup(t);
  const { updater, calls } = harness({ dir, source: path.join(dir, 'missing') });
  const result = await updater.tick();
  assert.equal(result.reason, 'source_missing');
  assert.equal(calls.length, 0);
  const state = readAutoUpdateState(dir);
  assert.equal(state.status, 'failed');
  assert.match(state.message, /Source checkout not found/);
});
