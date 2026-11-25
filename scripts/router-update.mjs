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
    else if (arg === '--source') options.source = value();
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
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
  } else {
    update(options).then(code => {
      process.exitCode = code || 0;
    }).catch(error => {
      console.error(`ERROR: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
