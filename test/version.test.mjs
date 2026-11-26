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
    current: '1.2.0',
    cachePath,
    fetchImpl: async () => { fetches += 1; throw new Error('must not fetch'); },
  });
  const before = checker.info();
  assert.equal(before.current, '1.2.0');
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
    current: '1.2.0',
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

test('the checker falls back to the package version on main when no release exists', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const urls = [];
  const checker = createUpdateChecker({
    current: '1.2.0',
    cachePath: path.join(dir, 'version-cache.json'),
    fetchImpl: async url => {
      urls.push(url);
      if (url.endsWith('/releases/latest')) return response({ message: 'Not Found' }, false, 404);
      return response({ content: Buffer.from(JSON.stringify({ version: '1.2.0' })).toString('base64') });
    },
  });
  const info = await checker.refresh({ force: true });
  assert.equal(info.latest, '1.2.0');
  assert.equal(info.status, 'current');
  assert.equal(urls.length, 2);
  assert.match(urls[1], /api\.github\.com\/repos\/dragonxia-ctrl\/claude-model-router\/contents\/package\.json\?ref=main$/);
});

test('the checker falls back to tags when no release exists and picks the highest', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const checker = createUpdateChecker({
    current: '1.2.0',
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

test('a failed refresh keeps the last release and records the attempt', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-11-25T00:00:00.000Z');
  let online = true;
  const checker = createUpdateChecker({
    current: '1.2.0',
    cachePath: path.join(dir, 'version-cache.json'),
    fetchImpl: async () => {
      if (!online) throw new Error('offline');
      return response({ tag_name: 'v1.3.0' });
    },
    now: () => clock,
  });
  await checker.refresh({ force: true });
  assert.equal(checker.info().latest, 'v1.3.0');
  const firstCheck = checker.info().checkedAt;

  online = false;
  clock += 60_000;
  const info = await checker.refresh({ force: true });
  assert.equal(info.latest, 'v1.3.0', 'the last known release survives an offline check');
  assert.notEqual(info.checkedAt, firstCheck, 'the attempt is recorded so it backs off');

  const cached = JSON.parse(fs.readFileSync(path.join(dir, 'version-cache.json'), 'utf8'));
  assert.equal(cached.latest, 'v1.3.0');
});

test('cache writes merge fields owned by other processes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cachePath = path.join(dir, 'version-cache.json');
  fs.writeFileSync(cachePath, JSON.stringify({
    current: '1.2.0',
    latest: 'v1.2.0',
    installed: '1.3.0',
    checkedAt: new Date().toISOString(),
  }));
  const checker = createUpdateChecker({
    current: '1.3.0',
    cachePath,
    fetchImpl: async () => response({ tag_name: 'v1.4.0' }),
  });
  let cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(cached.current, '1.3.0', 'the constructor advertises the restarted release immediately');
  assert.equal(cached.installed, '1.3.0', 'an unrelated writer field is preserved');

  await checker.refresh({ force: true });
  cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(cached.latest, 'v1.4.0');
  assert.equal(cached.current, '1.3.0');
  assert.equal(cached.installed, '1.3.0');
});

test('a release-only writer never overwrites the running release', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cachePath = path.join(dir, 'version-cache.json');
  fs.writeFileSync(cachePath, JSON.stringify({
    current: '1.2.0',
    latest: 'v1.2.0',
    installed: '1.3.0',
    status: 'current',
    checkedAt: '2026-11-20T00:00:00.000Z',
  }));
  // The status line also reads the cache and passes the running release it
  // saw, but only owns the release fields.
  const checker = createUpdateChecker({
    current: '1.2.0',
    cachePath,
    writeStatus: false,
    fetchImpl: async () => response({ tag_name: 'v1.4.0' }),
  });
  await checker.refresh({ force: true });
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(cached.latest, 'v1.4.0');
  assert.equal(cached.current, '1.2.0', 'current stays exactly as the router wrote it');
  assert.equal(cached.installed, '1.3.0');
  assert.equal(cached.status, 'current', 'the derived status is not overwritten either');
});


