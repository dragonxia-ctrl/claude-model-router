#!/usr/bin/env node
// Update a manual (launchd / system service) installation from GitHub:
// pull main, verify the commit and release, run offline tests, deploy the
// runtime files, restart, and verify the live router. Rolls back on failure.
//
//   claude-router update [--dry-run] [--force] [--skip-tests]
//                        [--source <git checkout>] [--data-dir <dir>]
//                        [--port <port>] [--label <launchd label>]
//                        [--restart launchd|none]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DEFAULT_LABEL = `com.${os.userInfo().username}.claude-model-router`;

export function parseArgs(argv, platform = process.platform) {
  const options = {
    source: process.env.CLAUDE_ROUTER_SOURCE || path.join(os.homedir(), 'claude-model-router'),
    dataDir: process.env.CLAUDE_ROUTER_DATA_DIR || path.join(os.homedir(), '.claude', 'model-router'),
    port: Number(process.env.CLAUDE_ROUTER_PORT || 17861),
    label: process.env.CLAUDE_ROUTER_LAUNCHD_LABEL || DEFAULT_LABEL,
    restart: platform === 'darwin' ? 'launchd' : 'none',
    tests: true,
    force: false,
    dryRun: false,
    help: false,
    auto: null,
    autoInstall: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return argv[i];
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--skip-tests') options.tests = false;
    else if (arg === '--auto-install') options.autoInstall = true;
    else if (arg === '--auto') {
      if (argv[i + 1] === 'on' || argv[i + 1] === 'off') {
        options.auto = argv[i + 1];
        i += 1;
      } else {
        options.auto = 'status';
      }
    } else if (arg.startsWith('--auto=')) {
      const value = arg.slice('--auto='.length);
      if (value !== 'on' && value !== 'off') throw new Error('--auto must be on or off');
      options.auto = value;
    } else if (arg === '--source') options.source = value();
    else if (arg === '--data-dir') options.dataDir = value();
    else if (arg === '--port') options.port = Number(value());
    else if (arg === '--label') options.label = value();
    else if (arg === '--restart') {
      options.restart = value();
      if (!['launchd', 'none'].includes(options.restart)) throw new Error('--restart must be launchd or none');
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export function expectedVersion(sourceDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));
  const text = fs.readFileSync(path.join(sourceDir, 'src', 'version.mjs'), 'utf8');
  const match = /ROUTER_VERSION\s*=\s*'([^']+)'/.exec(text);
  if (!match) throw new Error('src/version.mjs does not declare ROUTER_VERSION');
  if (match[1] !== pkg.version) {
    throw new Error(`Version mismatch: package.json ${pkg.version} vs src/version.mjs ${match[1]}`);
  }
  return pkg.version;
}

// The manual install is a flattened copy of src/ plus the status line helper
// and this updater; everything else in the data directory (config, token,
// logs, telemetry, probes) is left alone.
export function deployPlan(sourceDir) {
  const files = new Map();
  const srcDir = path.join(sourceDir, 'src');
  for (const name of fs.readdirSync(srcDir).sort()) {
    if (name.endsWith('.mjs')) files.set(name, path.join(srcDir, name));
  }
  files.set('version-status.mjs', path.join(sourceDir, 'scripts', 'version-status.mjs'));
  files.set('router-update.mjs', path.join(sourceDir, 'scripts', 'router-update.mjs'));
  return files;
}

// Kept in sync with src/auto-update.mjs. This file must stay self-contained:
// the deployed copy lives directly in the data directory, where there is no
// src/ directory to import from.
export const AUTO_UPDATE_STATE_FILE = 'auto-update-state.json';
export const AUTO_UPDATE_LOG_FILE = 'auto-update.log';
const AUTO_UPDATE_LOCK_MS = 30 * 60 * 1000;

function readAutoState(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, AUTO_UPDATE_STATE_FILE), 'utf8'));
  } catch {
    return null;
  }
}

function writeAutoState(dataDir, patch) {
  const file = path.join(dataDir, AUTO_UPDATE_STATE_FILE);
  const next = { ...(readAutoState(dataDir) || {}), ...patch };
  fs.mkdirSync(dataDir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(temporary, file);
  return next;
}

export function installedVersion(dataDir) {
  try {
    const text = fs.readFileSync(path.join(dataDir, 'version.mjs'), 'utf8');
    const match = /ROUTER_VERSION\s*=\s*'([^']+)'/.exec(text);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** Turn automatic installation on or off, preserving every other config key. */
export function setAutoUpdate(configPath, enabled) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.updates = { ...(config.updates || {}), auto: Boolean(enabled) };
  const temporary = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, configPath);
  return config.updates.auto;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// The router reloads config.json on SIGHUP; sending it means the toggle takes
// effect without a restart. A stopped service simply picks it up next time.
function reloadRouterConfig(options) {
  if (options.restart === 'none' || process.platform !== 'darwin') return;
  try {
    const output = execFileSync('launchctl', ['print', `gui/${process.getuid()}/${options.label}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = /^\s*pid = (\d+)\s*$/m.exec(output);
    if (!match) {
      console.log('Router is not running; the setting applies at the next start.');
      return;
    }
    process.kill(Number(match[1]), 'SIGHUP');
    console.log('Router reloaded the new setting (SIGHUP).');
  } catch {
    console.log('Could not signal the router; restart it to apply the setting.');
  }
}

function autoStatus(options) {
  const dataDir = path.resolve(options.dataDir);
  const configPath = path.join(dataDir, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const enabled = config.updates?.auto === true;
  if (options.auto !== 'status') {
    setAutoUpdate(configPath, options.auto === 'on');
    console.log(`Auto-update: ${options.auto}`);
    console.log(`Config: ${configPath}`);
    reloadRouterConfig(options);
    return 0;
  }
  console.log(`Auto-update: ${enabled ? 'on' : 'off'}`);
  console.log(`Config: ${configPath}`);
  const state = readAutoState(dataDir);
  if (state?.lastAttemptAt) {
    const version = state.lastVersion || state.version || 'unknown';
    const message = state.message ? ` — ${state.message}` : '';
    console.log(`Last attempt: ${state.status} at ${state.lastAttemptAt} (${version})${message}`);
  }
  if (!enabled) console.log('Turn it on with: claude-router update --auto on');
  return 0;
}

function acquireAutoLock(dataDir) {
  const lockPath = path.join(dataDir, 'auto-update.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }), { flag: 'wx', mode: 0o600 });
      return () => {
        try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { /* corrupt lock */ }
      const started = Date.parse(holder?.startedAt || '');
      const fresh = Number.isFinite(started) && Date.now() - started < AUTO_UPDATE_LOCK_MS;
      if (fresh && isProcessAlive(holder?.pid)) return null;
      try { fs.unlinkSync(lockPath); } catch { return null; }
    }
  }
  return null;
}

/**
 * Runs one automatic install: the router spawns this detached so the launchd
 * restart does not kill the verifier. Every outcome, including a refusal
 * (dirty checkout, offline, failing tests), is recorded for the status line.
 */
async function autoInstall(options) {
  const dataDir = path.resolve(options.dataDir);
  const release = acquireAutoLock(dataDir);
  if (!release) {
    console.log('Another auto-update is already running; nothing to do.');
    return 0;
  }
  const startedAt = new Date().toISOString();
  writeAutoState(dataDir, { status: 'running', startedAt });
  try {
    console.log(`Auto-update starting at ${startedAt}.`);
    await update({ ...options, auto: null, autoInstall: false });
    const version = installedVersion(dataDir);
    // Keep lastVersion/lastAttemptAt from the spawn record: they describe the
    // release this attempt targeted, which is what the router's backoff uses.
    writeAutoState(dataDir, {
      status: 'ok',
      version,
      finishedAt: new Date().toISOString(),
      message: null,
    });
    console.log(`Auto-update finished: release ${version || 'unknown'} is installed.`);
    return 0;
  } catch (error) {
    writeAutoState(dataDir, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      message: error.message,
    });
    throw error;
  } finally {
    release();
  }
}

function git(source, ...args) {
  return execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function deploy(sourceDir, dataDir, stamp) {
  const files = deployPlan(sourceDir);
  const backup = path.join(dataDir, 'backups', `pre-update-${stamp}`);
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  const replaced = [];
  for (const [target, from] of files) {
    if (!fs.existsSync(from)) throw new Error(`Missing source file: ${from}`);
    const to = path.join(dataDir, target);
    if (fs.existsSync(to)) fs.copyFileSync(to, path.join(backup, target));
    replaced.push(target);
  }
  fs.writeFileSync(path.join(backup, 'manifest.json'), `${JSON.stringify({ files: replaced }, null, 2)}\n`);
  for (const [target, from] of files) fs.copyFileSync(from, path.join(dataDir, target));
  return backup;
}

function restore(backup, dataDir) {
  const { files } = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8'));
  for (const name of files) {
    const saved = path.join(backup, name);
    if (fs.existsSync(saved)) fs.copyFileSync(saved, path.join(dataDir, name));
  }
}

function restart(options) {
  if (options.restart === 'none') return;
  execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${options.label}`], { stdio: 'inherit' });
}

async function waitForHealth(port, version) {
  const budget = Number(process.env.CLAUDE_ROUTER_UPDATE_HEALTH_TIMEOUT_MS || 15_000);
  const deadline = Date.now() + budget;
  let health = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        health = await response.json();
        if (health.release === version) return health;
      }
    } catch {
      // The router may be down while it restarts.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return health;
}

async function verify(options, version) {
  const health = await waitForHealth(options.port, version);
  if (!health?.ok) throw new Error('Router did not become healthy after restart');
  if (health.release && health.release !== version) {
    throw new Error(`Router reports release ${health.release}, expected ${version}`);
  }
  const versionInfo = await (await fetch(`http://127.0.0.1:${options.port}/version`, {
    signal: AbortSignal.timeout(2000),
  })).json();
  if (versionInfo.current !== version) {
    throw new Error(`/version reports ${versionInfo.current}, expected ${version}`);
  }
  const config = JSON.parse(fs.readFileSync(path.join(options.dataDir, 'config.json'), 'utf8'));
  const response = await fetch(`http://127.0.0.1:${options.port}/v1/router/preview`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.router.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'ping' }] }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Routing preview failed: HTTP ${response.status}`);
  const preview = await response.json();
  if (!preview.provider) throw new Error('Routing preview did not report a provider');
  return { health, versionInfo, preview };
}

function usage() {
  console.log(`Usage: claude-router update [options]

Pulls the latest main from GitHub, verifies it, runs the offline tests, deploys
the runtime files into the data directory, restarts the service, and verifies
the live router. Restores the previous files if any step fails.

Options:
  --dry-run          Show the deployment plan without changing anything
  --force            Redeploy even when the checkout is already up to date
  --skip-tests       Skip the offline test suite before deploying
  --source <dir>     Git checkout to update (default: ~/claude-model-router)
  --data-dir <dir>   Router data directory (default: ~/.claude/model-router)
  --port <port>      Router port for verification (default: 17861)
  --label <label>    launchd label (default: com.<user>.claude-model-router)
  --restart <mode>   launchd (default on macOS) or none
  --auto [on|off]    Show or change the automatic-update switch (off by default)
  --auto-install     Internal: install one detected release in the background

With --auto on, the running router installs a newer published release by itself:
it pulls a clean main checkout, verifies it, runs the offline tests, deploys,
restarts, and verifies the live router, logging to auto-update.log. Failures
back off for an hour; the status line shows "update installed, restart to
update" when files are deployed but the service has not restarted yet.
Run "claude-router update --auto" to see the switch, the last attempt, and its
error.
`);
}

export async function update(options = parseArgs([])) {
  const source = path.resolve(options.source);
  const dataDir = path.resolve(options.dataDir);

  if (!fs.existsSync(path.join(source, '.git'))) throw new Error(`Not a git checkout: ${source}`);
  if (!fs.existsSync(dataDir)) throw new Error(`Router data directory not found: ${dataDir}`);

  const branch = git(source, 'symbolic-ref', '--short', 'HEAD');
  if (branch !== 'main') throw new Error(`Source checkout is on "${branch}"; switch to main before updating`);
  if (git(source, 'status', '--porcelain')) throw new Error('Source checkout has uncommitted changes; commit or stash them first');

  const before = git(source, 'rev-parse', '--short', 'HEAD');
  console.log(`Source: ${source} @ main ${before}`);
  git(source, 'fetch', '--prune', 'origin');
  const behind = Number(git(source, 'rev-list', '--count', 'HEAD..origin/main'));
  if (behind === 0 && !options.force) {
    console.log(`Already up to date with origin/main (${before}).`);
    console.log('Use --force to redeploy the current commit.');
    return 0;
  }
  if (behind > 0) git(source, 'merge', '--ff-only', 'origin/main');
  const after = git(source, 'rev-parse', '--short', 'HEAD');
  const origin = git(source, 'rev-parse', '--short', 'origin/main');
  if (after !== origin) throw new Error(`Checkout ${after} does not match origin/main ${origin}`);
  const version = expectedVersion(source);
  console.log(`Checked out ${after} (${behind} new commit${behind === 1 ? '' : 's'}), release ${version}.`);

  if (options.tests) {
    console.log('Running offline tests...');
    execFileSync(process.execPath, ['--test', 'test/run.mjs'], { cwd: source, stdio: 'inherit' });
  }

  if (options.dryRun) {
    console.log('Dry run; would deploy:');
    for (const target of deployPlan(source).keys()) console.log(`  ${target}`);
    return 0;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let backup = null;
  try {
    backup = deploy(source, dataDir, stamp);
    console.log(`Deployed ${deployPlan(source).size} files to ${dataDir} (backup: ${backup}).`);
    restart(options);
    const result = await verify(options, version);
    console.log(`Router restarted: release ${version}, health ok, preview -> ${result.preview.provider}.`);
    const { latest, status } = result.versionInfo;
    if (latest) console.log(`Latest published release: ${latest} (${status}).`);
    return 0;
  } catch (error) {
    if (backup) {
      try {
        restore(backup, dataDir);
        restart(options);
        console.error('Restored the previous files after the failure.');
      } catch (rollbackError) {
        console.error(`Rollback failed: ${rollbackError.message}`);
      }
    }
    throw error;
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
  if (options?.help) {
    usage();
  } else if (options) {
    try {
      if (options.autoInstall && options.auto) throw new Error('--auto-install and --auto cannot be combined');
      const run = options.autoInstall ? autoInstall(options)
        : options.auto ? Promise.resolve(autoStatus(options))
          : update(options);
      run.then(code => {
        process.exitCode = code || 0;
      }).catch(error => {
        console.error(`ERROR: ${error.message}`);
        process.exitCode = 1;
      });
    } catch (error) {
      console.error(`ERROR: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
