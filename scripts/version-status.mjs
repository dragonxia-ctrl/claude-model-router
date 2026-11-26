#!/usr/bin/env node
// Version segment for Claude Code's native status line, the same place Claude
// Code itself shows its version and upgrade notice.
//
//   "statusLine": { "type": "command", "command": "node .../version-status.mjs" }
//
// The render only reads local files, so it is safe on every status line
// refresh. When the cached release check is older than ten minutes it starts a
// detached `--refresh` child that asks GitHub once, so a new release shows up
// without waiting for the running router's slower background check. The child
// uses the same cache file and is throttled by a stamp file, so several Claude
// Code windows do not stampede the GitHub API.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REFRESH_AFTER_MS = 10 * 60 * 1000;
const REFRESH_STAMP_MS = 2 * 60 * 1000;
const AMBER = '\u001b[33m';
const DIM = '\u001b[2m';

const here = path.dirname(fileURLToPath(import.meta.url));
const cachePath = process.env.CLAUDE_ROUTER_VERSION_CACHE
  || path.join(os.homedir(), '.claude', 'model-router', 'version-cache.json');
const dataDir = path.dirname(cachePath);
const configPath = process.env.CLAUDE_ROUTER_CONFIG || path.join(dataDir, 'config.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function versionModulePath() {
  // The deployed layout flattens src/*.mjs next to this script. In a git
  // checkout this script lives in scripts/ and imports src/version.mjs.
  const sibling = path.join(here, 'version.mjs');
  return fs.existsSync(sibling) ? sibling : path.resolve(here, '..', 'src', 'version.mjs');
}

function installedVersion(versions) {
  const override = process.env.CLAUDE_ROUTER_INSTALLED_VERSION;
  const value = override || versions.ROUTER_VERSION;
  return versions.parseVersion(value) ? value : null;
}

function autoUpdateEnabled() {
  const config = readJson(configPath);
  return config?.updates?.auto === true;
}

// Claim the one background refresh slot. Returns false when a refresh ran or
// started within the stamp window, or when the data directory is not writable.
function claimRefresh() {
  const stampPath = `${cachePath}.refresh`;
  try {
    const age = Date.now() - fs.statSync(stampPath).mtimeMs;
    if (age < REFRESH_STAMP_MS) return false;
    fs.unlinkSync(stampPath);
  } catch {
    // No stamp, or it was already removed by another window.
  }
  try {
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.writeFileSync(stampPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function spawnRefresh(info) {
  if (process.env.CLAUDE_ROUTER_STATUS_NO_REFRESH) return;
  const checkedAt = Date.parse(info?.checkedAt || '');
  if (Number.isFinite(checkedAt) && Date.now() - checkedAt < REFRESH_AFTER_MS) return;
  if (!claimRefresh()) return;
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--refresh'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CLAUDE_ROUTER_STATUS_NO_REFRESH: '1' },
    });
    child.unref();
  } catch {
    // The next status line refresh will try again.
  }
}

async function refreshInBackground(versions) {
  const cached = readJson(cachePath);
  const current = typeof cached?.current === 'string' && cached.current ? cached.current : null;
  const checker = versions.createUpdateChecker({
    current,
    cachePath,
    intervalMs: 0,
    writeStatus: false,
    logger: () => {},
  });
  try {
    await checker.refresh({ force: true });
  } catch {
    // Offline or a corrupt cache: keep the previous state for the next render.
  }
}

async function main() {
  let versions;
  try {
    versions = await import(pathToFileURL(versionModulePath()).href);
  } catch {
    return;
  }

  if (process.argv.includes('--refresh')) {
    await refreshInBackground(versions);
    return;
  }

  const info = readJson(cachePath);
  if (!info?.current) return;

  const segment = versions.versionState(info, {
    installed: installedVersion(versions),
    autoUpdate: autoUpdateEnabled(),
    autoState: readJson(path.join(dataDir, 'auto-update-state.json')),
  });
  if (!segment) return;

  // Dim while up to date; amber when an upgrade needs attention.
  process.stdout.write(`${segment.tone === 'amber' ? AMBER : DIM}${segment.text}\u001b[0m\n`);
  spawnRefresh(info);
}

await main();
