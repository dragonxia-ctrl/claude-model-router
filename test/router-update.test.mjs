import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deployPlan, expectedVersion, parseArgs, setAutoUpdate, installedVersion } from '../scripts/router-update.mjs';

const script = fileURLToPath(new URL('../scripts/router-update.mjs', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-C', cwd, ...args], {
    encoding: 'utf8',
  }).trim();
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeRepo(root, version) {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  write(path.join(root, 'package.json'), `${JSON.stringify({ name: 'router', version }, null, 2)}\n`);
  write(path.join(root, 'src', 'version.mjs'), `export const ROUTER_VERSION = '${version}';\n`);
  write(path.join(root, 'src', 'router.mjs'), '// router\n');
  write(path.join(root, 'scripts', 'version-status.mjs'), '// status\n');
  write(path.join(root, 'scripts', 'router-control.mjs'), '// control\n');
  fs.copyFileSync(script, path.join(root, 'scripts', 'router-update.mjs'));
}

const HAS_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const NO_GIT = HAS_GIT ? false : 'git is not installed in this test container';

function setupRemote(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'router-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['-C', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  const seed = path.join(root, 'seed');
  writeRepo(seed, '1.2.0');
  git(seed, 'init', '-q');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'release 1.2.0');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  const clone = path.join(root, 'clone');
  execFileSync('git', ['clone', '-q', '-b', 'main', remote, clone]);
  return { root, remote, seed, clone };
}

function publish(seed, version) {
  write(path.join(seed, 'package.json'), `${JSON.stringify({ name: 'router', version }, null, 2)}\n`);
  write(path.join(seed, 'src', 'version.mjs'), `export const ROUTER_VERSION = '${version}';\n`);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', `release ${version}`);
  git(seed, 'push', '-q', 'origin', 'main');
}

function dataDir(t, root) {
  const dir = path.join(root, 'data');
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  write(path.join(dir, 'config.json'), JSON.stringify({ router: { token: 'test-token' }, providers: {} }));
  return dir;
}

async function fakeRouter(t, version) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') {
      res.end(JSON.stringify({ ok: true, release: version }));
    } else if (req.url === '/version') {
      res.end(JSON.stringify({ current: version, latest: version, status: 'current' }));
    } else if (req.url === '/v1/router/preview') {
      res.end(JSON.stringify({ provider: 'deepseek', source: 'default' }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

function runUpdate(args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, CLAUDE_ROUTER_UPDATE_HEALTH_TIMEOUT_MS: '1500', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

test('argument parsing defaults and validation', () => {
  const options = parseArgs(['--dry-run', '--skip-tests', '--source', '/tmp/src', '--port', '19999'], 'darwin');
  assert.equal(options.dryRun, true);
  assert.equal(options.tests, false);
  assert.equal(options.source, '/tmp/src');
  assert.equal(options.port, 19999);
  assert.equal(options.restart, 'launchd');
  assert.equal(options.auto, null);
  assert.equal(options.autoInstall, false);
  assert.throws(() => parseArgs(['--restart', 'nope']), /launchd or none/);
  assert.throws(() => parseArgs(['--source']), /Missing value/);
  assert.throws(() => parseArgs(['--bogus']), /Unknown option/);
});

test('the auto-update switch parses on, off, status, and the internal install mode', () => {
  assert.equal(parseArgs(['--auto'], 'darwin').auto, 'status');
  assert.equal(parseArgs(['--auto', 'on'], 'darwin').auto, 'on');
  assert.equal(parseArgs(['--auto', 'off'], 'darwin').auto, 'off');
  assert.equal(parseArgs(['--auto=on'], 'darwin').auto, 'on');
  assert.equal(parseArgs(['--auto-install'], 'darwin').autoInstall, true);
  assert.throws(() => parseArgs(['--auto=maybe']), /on or off/);
});

test('setAutoUpdate changes only the switch and preserves the rest of the config', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-auto-toggle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  const config = {
    router: { host: '127.0.0.1', port: 17861, token: 'a'.repeat(64) },
    providers: { deepseek: { apiKey: 'keep-me' } },
    updates: { auto: false, source: '/srv/router' },
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  assert.equal(setAutoUpdate(configPath, true), true);
  const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(written.updates.auto, true);
  assert.equal(written.updates.source, '/srv/router');
  assert.equal(written.providers.deepseek.apiKey, 'keep-me');
  assert.equal(written.router.port, 17861);
});

test('the --auto toggle is applied through the CLI with restart disabled', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-auto-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    router: { host: '127.0.0.1', port: 17861, token: 'a'.repeat(64) },
    providers: { deepseek: { apiKey: 'keep-me' }, kimi: { apiKey: 'keep-me-too' } },
  }));
  const on = execFileSync(process.execPath, [
    script, '--auto', 'on', '--data-dir', dir, '--restart', 'none',
  ], { encoding: 'utf8' });
  assert.match(on, /Auto-update: on/);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).updates.auto, true);
  const status = execFileSync(process.execPath, [
    script, '--auto', '--data-dir', dir, '--restart', 'none',
  ], { encoding: 'utf8' });
  assert.match(status, /Auto-update: on/);
});

test('installedVersion reads the deployed release', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-installed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(installedVersion(dir), null);
  fs.writeFileSync(path.join(dir, 'version.mjs'), "export const ROUTER_VERSION = '1.4.0';\n");
  assert.equal(installedVersion(dir), '1.4.0');
});

test('expectedVersion requires package.json and src/version.mjs to agree', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'router-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeRepo(root, '1.2.0');
  assert.equal(expectedVersion(root), '1.2.0');
  write(path.join(root, 'src', 'version.mjs'), "export const ROUTER_VERSION = '9.9.9';\n");
  assert.throws(() => expectedVersion(root), /Version mismatch/);
});

test('deploy plan covers src and the three helper scripts, never config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'router-plan-'));
  try {
    writeRepo(root, '1.2.0');
    const plan = deployPlan(root);
    assert.ok(plan.has('router.mjs'));
    assert.ok(plan.has('version.mjs'));
    assert.ok(plan.has('version-status.mjs'));
    assert.ok(plan.has('router-update.mjs'));
    assert.ok(plan.has('router-control.mjs'));
    assert.ok(![...plan.keys()].some(name => name.includes('config')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a dirty checkout is refused before anything is changed', { skip: NO_GIT }, async t => {
  const { root, clone } = setupRemote(t);
  const data = dataDir(t, root);
  write(path.join(clone, 'src', 'router.mjs'), '// local edit\n');
  const result = await runUpdate(['--source', clone, '--data-dir', data, '--restart', 'none', '--skip-tests']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /uncommitted changes/);
  assert.equal(fs.existsSync(path.join(data, 'router.mjs')), false);
});

test('an up-to-date checkout is reported without deploying', { skip: NO_GIT }, async t => {
  const { root, clone } = setupRemote(t);
  const data = dataDir(t, root);
  const result = await runUpdate(['--source', clone, '--data-dir', data, '--restart', 'none', '--skip-tests']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Already up to date/);
  assert.equal(fs.existsSync(path.join(data, 'router.mjs')), false);
});

test('update pulls main, deploys with a backup, and verifies the live router', { skip: NO_GIT }, async t => {
  const { root, seed, clone } = setupRemote(t);
  const data = dataDir(t, root);
  publish(seed, '1.3.0');
  const port = await fakeRouter(t, '1.3.0');

  const result = await runUpdate([
    '--source', clone, '--data-dir', data, '--restart', 'none', '--skip-tests', '--port', String(port),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release 1\.3\.0/);
  assert.match(result.stdout, /preview -> deepseek/);
  assert.match(fs.readFileSync(path.join(data, 'version.mjs'), 'utf8'), /1\.3\.0/);
  assert.ok(fs.existsSync(path.join(data, 'router-update.mjs')));
  assert.ok(fs.existsSync(path.join(data, 'version-status.mjs')));
  const backups = fs.readdirSync(path.join(data, 'backups'));
  assert.equal(backups.length, 1);
  assert.match(fs.readFileSync(path.join(data, 'backups', backups[0], 'manifest.json'), 'utf8'), /version\.mjs/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).router.token, 'test-token');
});

test('auto-install records a successful detached run and releases its lock', { skip: NO_GIT }, async t => {
  const { root, seed, clone } = setupRemote(t);
  const data = dataDir(t, root);
  publish(seed, '1.3.0');
  const port = await fakeRouter(t, '1.3.0');

  const result = await runUpdate([
    '--auto-install', '--source', clone, '--data-dir', data, '--restart', 'none', '--skip-tests',
    '--port', String(port),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Auto-update finished/);
  const state = JSON.parse(fs.readFileSync(path.join(data, 'auto-update-state.json'), 'utf8'));
  assert.equal(state.status, 'ok');
  assert.equal(state.version, '1.3.0');
  assert.equal(fs.existsSync(path.join(data, 'auto-update.lock')), false);
  assert.match(fs.readFileSync(path.join(data, 'version.mjs'), 'utf8'), /1\.3\.0/);
});

test('auto-install records a refused run as failed', { skip: NO_GIT }, async t => {
  const { root, clone } = setupRemote(t);
  const data = dataDir(t, root);
  write(path.join(clone, 'src', 'router.mjs'), '// local edit\n');

  const result = await runUpdate([
    '--auto-install', '--source', clone, '--data-dir', data, '--restart', 'none', '--skip-tests',
  ]);
  assert.notEqual(result.status, 0);
  const state = JSON.parse(fs.readFileSync(path.join(data, 'auto-update-state.json'), 'utf8'));
  assert.equal(state.status, 'failed');
  assert.match(state.message, /uncommitted changes/);
  assert.equal(fs.existsSync(path.join(data, 'auto-update.lock')), false);
});

test('a failed verification restores the previous files', { skip: NO_GIT }, async t => {
  const { root, seed, clone } = setupRemote(t);
  const data = dataDir(t, root);
  write(path.join(data, 'version.mjs'), "export const ROUTER_VERSION = '0.0.1';\n");
  publish(seed, '1.3.0');  const port = await fakeRouter(t, '9.9.9');

  const result = await runUpdate([
    '--source', clone, '--data-dir', data, '--restart', 'none', '--skip-tests', '--port', String(port),
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected 1\.3\.0|did not become healthy/);
  assert.match(result.stderr, /Restored the previous files/);
  assert.match(fs.readFileSync(path.join(data, 'version.mjs'), 'utf8'), /0\.0\.1/);
});
