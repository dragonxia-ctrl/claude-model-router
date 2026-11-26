import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildStatusLine, readStatusState, sampling, versionSegment } from '../src/status-line.mjs';
import { sessionTag } from '../src/session.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repository, 'src', 'status-line.mjs');
const now = Date.parse('2026-11-26T08:00:10.000Z');

const cells = [
  { model: 'deepseek' }, { model: 'deepseek' }, { model: 'kimi' },
  { model: 'idle' }, { model: 'kimi' },
];

const version = { current: '1.3.0', latest: 'v1.3.0', status: 'current' };

test('the plain line names the model, shows the strip, and ends with the version', () => {
  const line = buildStatusLine({
    cells,
    inFlight: [{ provider: 'kimi', start: now - 12000 }],
    now,
    color: false,
    version,
  });
  assert.equal(line, '● Kimi 12s  DDK.K  router v1.3.0 · latest v1.3.0');
});

test('an idle line counts time since the last request', () => {
  const line = buildStatusLine({
    cells,
    inFlight: [],
    now,
    lastEventAt: now - 45000,
    color: false,
    version,
  });
  assert.equal(line, '○ idle 45s  DDK.K  router v1.3.0 · latest v1.3.0');
});

test('an available update is amber and names the published release', () => {
  assert.deepEqual(versionSegment({ current: '1.3.0', latest: 'v1.4.0', status: 'available' }),
    { text: 'router v1.3.0 · v1.4.0 available', update: true });
  const line = buildStatusLine({
    cells,
    inFlight: [],
    now,
    color: true,
    version: { current: '1.3.0', latest: 'v1.4.0', status: 'available' },
  });
  assert.ok(line.includes('\x1b[33mrouter v1.3.0 · v1.4.0 available'));
});

test('deployed-but-not-restarted files ask for a restart', () => {
  assert.deepEqual(
    versionSegment(
      { current: '1.3.0', latest: 'v1.4.0', status: 'available' },
      { installed: '1.4.0' },
    ),
    { text: 'router v1.3.0 · update installed, restart to update', update: true },
  );
});

test('the automatic-update state is named while an upgrade is pending', () => {
  const pending = { current: '1.3.0', latest: 'v1.4.0', status: 'available' };
  assert.equal(
    versionSegment(pending, { installed: '1.3.0', autoUpdate: true }).text,
    'router v1.3.0 · v1.4.0 available · auto-update on',
  );
  assert.match(
    versionSegment(pending, { installed: '1.3.0', autoUpdate: true, autoState: { status: 'running', version: '1.4.0' } }).text,
    /· auto-update running$/,
  );
  assert.match(
    versionSegment(pending, { installed: '1.3.0', autoUpdate: true, autoState: { status: 'failed', lastVersion: 'v1.4.0' } }).text,
    /· auto-update failed$/,
  );
  // A state recorded for another release does not describe this upgrade.
  assert.match(
    versionSegment(pending, { installed: '1.3.0', autoUpdate: true, autoState: { status: 'failed', lastVersion: 'v1.5.0' } }).text,
    /· auto-update on$/,
  );
  // The switch being off hides the state entirely.
  assert.doesNotMatch(
    versionSegment(pending, { installed: '1.3.0', autoUpdate: false, autoState: { status: 'failed', lastVersion: 'v1.4.0' } }).text,
    /auto-update/,
  );
});

test('without a router log the strip is omitted', () => {
  const line = buildStatusLine({ available: false, now, color: false, version });
  assert.equal(line, 'router v1.3.0 · latest v1.3.0');
  assert.equal(buildStatusLine({ available: false, now, color: false, version: null }), '');
});

test('the color strip uses the two model colors', () => {
  const line = buildStatusLine({
    cells,
    inFlight: [{ provider: 'deepseek', start: now - 1000 }],
    now,
    color: true,
    version: null,
  });
  assert.ok(line.includes('\x1b[38;5;69m'));
  assert.ok(line.includes('\x1b[38;5;166m'));
});

test('narrow terminals trim the oldest cells and drop the version when needed', () => {
  const many = Array.from({ length: 28 }, () => ({ model: 'deepseek' }));
  const wide = buildStatusLine({
    cells: many,
    inFlight: [{ provider: 'kimi', start: now - 1000 }],
    now,
    color: false,
    version,
    columns: 60,
  });
  assert.ok(wide.length <= 60);
  assert.match(wide, /router v1\.3\.0/);

  const narrow = buildStatusLine({
    cells: many,
    inFlight: [{ provider: 'kimi', start: now - 1000 }],
    now,
    color: false,
    version,
    columns: 30,
  });
  assert.ok(narrow.length <= 30);
  assert.ok(!narrow.includes('router'));
});

test('the default window is 80 seconds and environment variables widen it', () => {
  assert.deepEqual(sampling({}), { cells: 40, cellMs: 2000 });
  assert.deepEqual(sampling({ CLAUDE_ROUTER_CELLS: '12', CLAUDE_ROUTER_CELL_MS: '5000' }),
    { cells: 12, cellMs: 5000 });
  assert.deepEqual(sampling({ CLAUDE_ROUTER_CELLS: '99999', CLAUDE_ROUTER_CELL_MS: 'nope' }),
    { cells: 200, cellMs: 2000 });
});

test('readStatusState samples a log tail', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-router-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, 'router.log');
  const start = now - 5000;
  fs.writeFileSync(log, [
    JSON.stringify({ event: 'route_decision', time: new Date(start).toISOString(), requestId: 'r1', provider: 'kimi' }),
    JSON.stringify({ event: 'request_complete', requestId: 'r1', purpose: 'main', durationMs: 2000 }),
  ].join('\n') + '\n');
  const state = readStatusState({ logPath: log, now, cells: 5, cellMs: 2000 });
  assert.equal(state.available, true);
  assert.deepEqual(state.cells.map(cell => cell.model), ['idle', 'idle', 'kimi', 'idle', 'idle']);
});

test('readStatusState keeps only the requested session', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-router-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, 'router.log');
  const start = now - 5000;
  fs.writeFileSync(log, [
    JSON.stringify({ event: 'route_decision', time: new Date(start).toISOString(), requestId: 'r1', provider: 'deepseek', session: sessionTag('other-session') }),
    JSON.stringify({ event: 'request_complete', requestId: 'r1', purpose: 'main', durationMs: 3000 }),
    JSON.stringify({ event: 'route_decision', time: new Date(start + 4000).toISOString(), requestId: 'r2', provider: 'kimi', session: sessionTag('my-session') }),
    JSON.stringify({ event: 'request_complete', requestId: 'r2', purpose: 'main', durationMs: 3000 }),
  ].join('\n') + '\n');

  const mine = readStatusState({ logPath: log, now, cells: 5, cellMs: 2000, session: sessionTag('my-session') });
  assert.deepEqual(mine.cells.map(cell => cell.model), ['idle', 'idle', 'idle', 'idle', 'kimi']);
  const all = readStatusState({ logPath: log, now, cells: 5, cellMs: 2000 });
  assert.deepEqual(all.cells.map(cell => cell.model), ['idle', 'idle', 'deepseek', 'idle', 'kimi']);
});

test('the script uses the session id passed on stdin', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-router-stdin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const start = Date.now() - 4000;
  fs.writeFileSync(path.join(root, 'router.log'), [
    JSON.stringify({ event: 'route_decision', time: new Date(start).toISOString(), requestId: 'r1', provider: 'kimi', session: sessionTag('other') }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'version-cache.json'), JSON.stringify(version));
  const run = sessionId => execFileSync(process.execPath, [script], {
    encoding: 'utf8',
    input: JSON.stringify({ session_id: sessionId }),
    env: { ...process.env, CLAUDE_ROUTER_DATA_DIR: root, NO_COLOR: '1' },
  });
  assert.match(run('my-session'), /○ idle/);
  assert.match(run('other'), /● Kimi/);
  assert.doesNotMatch(run('other'), /DeepSeek/);
});

test('the script also runs when invoked through a symlink', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-router-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const link = path.join(root, 'status-line.mjs');
  fs.symlinkSync(script, link);
  fs.writeFileSync(path.join(root, 'version-cache.json'), JSON.stringify(version));
  const output = execFileSync(process.execPath, [link], {
    encoding: 'utf8',
    input: '{}',
    env: { ...process.env, CLAUDE_ROUTER_DATA_DIR: root, NO_COLOR: '1' },
  });
  assert.ok(output.trim().length > 0, 'the main entry point still runs through a symlink');
});

test('the script prints one line and exits cleanly', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-router-status-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const start = Date.now() - 4000;
  fs.writeFileSync(path.join(root, 'router.log'), [
    JSON.stringify({ event: 'route_decision', time: new Date(start).toISOString(), requestId: 'r1', provider: 'deepseek' }),
    JSON.stringify({ event: 'request_complete', requestId: 'r1', purpose: 'main', durationMs: 2000 }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'version-cache.json'), JSON.stringify(version));
  const output = execFileSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_ROUTER_DATA_DIR: root, NO_COLOR: '1' },
  });
  assert.equal(output.trim().split('\n').length, 1);
  assert.match(output, /DeepSeek|Kimi|idle/);
  assert.match(output, /router v1\.3\.0/);
});
