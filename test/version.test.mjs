import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ROUTER_VERSION, parseVersion, compareVersions, updateStatus, createUpdateChecker,
} from '../src/version.mjs';

function response(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

test('the running release matches package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(ROUTER_VERSION, pkg.version);
});

test('version strings parse and compare by semantic order', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: '' });
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: '' });
  assert.equal(parseVersion('latest'), null);
  assert.equal(parseVersion('1.2'), null);
  assert.equal(compareVersions('1.2.0', '1.2.0'), 0);
  assert.equal(compareVersions('1.2.0', '1.3.0'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('v2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.2.0-rc.1', '1.2.0'), -1);
  assert.equal(compareVersions('1.2.0', 'nope'), null);
});

test('update status distinguishes newer, equal, older and unknown releases', () => {
  assert.equal(updateStatus('1.2.0', '1.3.0'), 'available');
  assert.equal(updateStatus('1.2.0', '1.2.0'), 'current');
  assert.equal(updateStatus('1.2.0', '1.1.0'), 'ahead');
  assert.equal(updateStatus('1.2.0', null), 'unknown');
});

test('the checker serves a cached release without fetching', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cachePath = path.join(dir, 'version-cache.json');
  fs.writeFileSync(cachePath, JSON.stringify({
    latest: 'v1.3.0',
    checkedAt: new Date().toISOString(),
  }));
  let fetches = 0;
  const checker = createUpdateChecker({
    cachePath,
    fetchImpl: async () => { fetches += 1; throw new Error('must not fetch'); },
  });
  const before = checker.info();
  assert.equal(before.current, ROUTER_VERSION);
  assert.equal(before.latest, 'v1.3.0');
  assert.equal(before.status, 'available');
  assert.equal(before.updateAvailable, true);
  await checker.refresh();
  assert.equal(fetches, 0, 'a fresh cache is used as-is');
});

test('the checker fetches the latest release and persists it', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cachePath = path.join(dir, 'version-cache.json');
  const urls = [];
  const checker = createUpdateChecker({
    cachePath,
    fetchImpl: async url => { urls.push(url); return response({ tag_name: 'v1.3.0' }); },
  });
  const info = await checker.refresh({ force: true });
  assert.deepEqual(urls, ['https://api.github.com/repos/dragonxia-ctrl/claude-model-router/releases/latest']);
  assert.equal(info.latest, 'v1.3.0');
  assert.equal(info.status, 'available');
  assert.ok(info.checkedAt);
  const persisted = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(persisted.latest, 'v1.3.0');
});

test('the checker falls back to tags when no release exists and picks the highest', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const checker = createUpdateChecker({
    cachePath: path.join(dir, 'version-cache.json'),
    fetchImpl: async url => {
      if (url.endsWith('/releases/latest')) return response({ message: 'Not Found' }, false, 404);
      return response([{ name: 'v1.1.0' }, { name: 'v1.2.0' }, { name: 'not-a-version' }]);
    },
  });
  const info = await checker.refresh({ force: true });
  assert.equal(info.latest, 'v1.2.0');
  assert.equal(info.status, 'current');
});

test('network failures are silent and never make the endpoint fail', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const checker = createUpdateChecker({
    cachePath: path.join(dir, 'version-cache.json'),
    fetchImpl: async () => { throw new Error('offline'); },
  });
  const info = await checker.refresh({ force: true });
  assert.equal(info.latest, null);
  assert.equal(info.status, 'unknown');
  assert.equal(info.updateAvailable, false);
  assert.ok(info.checkedAt, 'a failed check is remembered so it is not retried in a loop');
});

test('the check is skipped while the cached result is fresh', async t => {
  let clock = Date.parse('2026-11-25T00:00:00.000Z');
  let fetches = 0;
  const checker = createUpdateChecker({
    fetchImpl: async () => { fetches += 1; return response({ tag_name: 'v1.2.0' }); },
    intervalMs: 60_000,
    now: () => clock,
  });
  await checker.refresh({ force: true });
  assert.equal(fetches, 1);
  clock += 30_000;
  await checker.refresh();
  assert.equal(fetches, 1);
  clock += 60_000;
  await checker.refresh();
  assert.equal(fetches, 2);
});
