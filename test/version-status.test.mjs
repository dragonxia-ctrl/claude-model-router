import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/version-status.mjs', import.meta.url));

function run(cache) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-statusline-'));
  const cachePath = path.join(dir, 'version-cache.json');
  if (cache) fs.writeFileSync(cachePath, JSON.stringify(cache));
  try {
    return execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_ROUTER_VERSION_CACHE: cachePath },
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
  const output = run({ current: '1.2.0', latest: 'v1.3.0', status: 'available', updateAvailable: true });
  assert.match(output, /router v1\.2\.0 · v1\.3\.0 available/);
  assert.match(output, /\[33m/, 'an upgrade is highlighted');
});

test('status line still names the running release when no release is known', () => {
  assert.match(run({ current: '1.2.0', latest: null, status: 'unknown' }), /router v1\.2\.0/);
});
