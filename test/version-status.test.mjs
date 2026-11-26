import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/version-status.mjs', import.meta.url));

function run(cache, { installed = cache?.current, config = null, state = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-statusline-'));
  const cachePath = path.join(dir, 'version-cache.json');
  if (cache) fs.writeFileSync(cachePath, JSON.stringify(cache));
  if (config) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  if (state) fs.writeFileSync(path.join(dir, 'auto-update-state.json'), JSON.stringify(state));
  try {
    return execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_ROUTER_VERSION_CACHE: cachePath,
        // Keep the render hermetic: the container image and the developer
        // shell may both export a config path.
        CLAUDE_ROUTER_CONFIG: path.join(dir, 'config.json'),
        // Never spawn the background GitHub check from the test suite.
        CLAUDE_ROUTER_STATUS_NO_REFRESH: '1',
        ...(installed ? { CLAUDE_ROUTER_INSTALLED_VERSION: installed } : {}),
      },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('status line is empty when the router has never reported a version', () => {
  assert.equal(run(null), '');
});

test('status line shows the running release and the latest release', () => {
  const output = run({ current: '1.2.0', latest: 'v1.2.0', status: 'current', checkedAt: '2026-11-25T00:00:00Z' });
  assert.match(output, /router v1\.2\.0 · latest v1\.2\.0/);
});

test('status line announces an available upgrade', () => {
  const output = run({ current: '1.2.0', latest: 'v1.3.0', status: 'available', updateAvailable: true }, { installed: '1.2.0' });
  assert.match(output, /router v1\.2\.0 · v1\.3\.0 available/);
  assert.match(output, /\[33m/, 'an upgrade is highlighted');
});

test('status line still names the running release when no release is known', () => {
  assert.match(run({ current: '1.2.0', latest: null, status: 'unknown' }), /router v1\.2\.0/);
});

test('status line asks for a restart when deployed files are newer than the process', () => {
  const output = run(
    { current: '1.3.0', latest: 'v1.4.0', status: 'available', updateAvailable: true },
    { installed: '1.4.0' },
  );
  assert.match(output, /router v1\.3\.0 · update installed, restart to update/);
  assert.match(output, /\[33m/, 'a pending restart is highlighted');
  assert.doesNotMatch(output, /available/, 'the pending restart replaces the available notice');
});

test('status line names the auto-update switch when it is on', () => {
  const output = run(
    { current: '1.3.0', latest: 'v1.4.0', status: 'available', updateAvailable: true },
    { installed: '1.3.0', config: { updates: { auto: true } } },
  );
  assert.match(output, /v1\.4\.0 available · auto-update on/);
});

test('status line reports a failed automatic update', () => {
  const output = run(
    { current: '1.3.0', latest: 'v1.4.0', status: 'available', updateAvailable: true },
    {
      installed: '1.3.0',
      config: { updates: { auto: true } },
      state: { status: 'failed', lastVersion: 'v1.4.0', message: 'uncommitted changes' },
    },
  );
  assert.match(output, /v1\.4\.0 available · auto-update failed/);
});

test('status line reports an automatic update that is still running', () => {
  const output = run(
    { current: '1.3.0', latest: 'v1.4.0', status: 'available', updateAvailable: true },
    {
      installed: '1.3.0',
      config: { updates: { auto: true } },
      state: { status: 'running', version: '1.4.0' },
    },
  );
  assert.match(output, /v1\.4\.0 available · auto-update running/);
});

test('auto-update details are hidden when the switch is off', () => {
  const output = run(
    { current: '1.3.0', latest: 'v1.4.0', status: 'available', updateAvailable: true },
    { installed: '1.3.0', config: { updates: { auto: false } }, state: { status: 'failed', lastVersion: 'v1.4.0' } },
  );
  assert.match(output, /v1\.4\.0 available/);
  assert.doesNotMatch(output, /auto-update/);
});
