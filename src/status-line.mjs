#!/usr/bin/env node
// Model-activity strip for Claude Code's native status line.
//
//   "statusLine": {
//     "type": "command",
//     "command": "node \"$HOME/.claude/model-router/status-line.mjs\""
//   }
//
// It reads the session id from Claude Code's stdin JSON, then only local files
// (router.log, version-cache.json, config.json, and auto-update-state.json). It
// makes no network calls of its own and never throws into the status line: a
// stale release cache starts the detached refresh in version-status.mjs, which
// asks GitHub once at a time. When the router log is absent it degrades to the
// version segment, or to nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createActivity } from './activity.mjs';
import { sessionTag } from './session.mjs';
import { versionState } from './version.mjs';

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  amber: '\x1b[33m',
  // 256-color codes render on every terminal Claude Code runs in, including
  // Apple Terminal; truecolor SGR is not universally supported.
  deepseek: '\x1b[38;5;69m',
  kimi: '\x1b[38;5;166m',
};

const NAMES = { deepseek: 'DeepSeek', kimi: 'Kimi' };
const TAIL_BYTES = 256 * 1024;
const VERSION_REFRESH_AFTER_MS = 10 * 60 * 1000;
const VERSION_REFRESH_STAMP_MS = 2 * 60 * 1000;

export const DEFAULTS = Object.freeze({ cells: 40, cellMs: 2000 });

function envNumber(env, name, fallback, min, max) {
  const raw = env?.[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Sampling for the status strip. The defaults show 80 seconds; a very wide
 * terminal still trims to the cells that fit, and `CLAUDE_ROUTER_CELLS` /
 * `CLAUDE_ROUTER_CELL_MS` widen the window without editing the helper.
 */
export function sampling(env = process.env) {
  return {
    cells: envNumber(env, 'CLAUDE_ROUTER_CELLS', DEFAULTS.cells, 4, 200),
    cellMs: envNumber(env, 'CLAUDE_ROUTER_CELL_MS', DEFAULTS.cellMs, 500, 60000),
  };
}

function paint(text, tone, color) {
  if (!color || !tone) return text;
  return `${ANSI[tone]}${text}${ANSI.reset}`;
}

export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${String(rest).padStart(2, '0')}s` : `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function versionSegment(info, context = {}) {
  const segment = versionState(info, context);
  return segment ? { text: segment.text, update: segment.tone === 'amber' } : null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function installedRelease(dataDir) {
  if (process.env.CLAUDE_ROUTER_INSTALLED_VERSION) return process.env.CLAUDE_ROUTER_INSTALLED_VERSION;
  try {
    const text = fs.readFileSync(path.join(dataDir, 'version.mjs'), 'utf8');
    const match = /ROUTER_VERSION\s*=\s*'([^']+)'/.exec(text);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// One background refresh at a time across every Claude Code window; the stamp
// is the same file version-status.mjs uses, so the two helpers share a slot.
function spawnVersionRefresh(info, cachePath) {
  if (process.env.CLAUDE_ROUTER_STATUS_NO_REFRESH) return;
  const checkedAt = Date.parse(info?.checkedAt || '');
  if (Number.isFinite(checkedAt) && Date.now() - checkedAt < VERSION_REFRESH_AFTER_MS) return;
  const stamp = `${cachePath}.refresh`;
  try {
    if (Date.now() - fs.statSync(stamp).mtimeMs < VERSION_REFRESH_STAMP_MS) return;
    fs.unlinkSync(stamp);
  } catch {
    // No stamp yet.
  }
  try {
    fs.writeFileSync(stamp, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  } catch {
    return;
  }
  const script = path.join(path.dirname(cachePath), 'version-status.mjs');
  if (!fs.existsSync(script)) return;
  try {
    const child = spawn(process.execPath, [script, '--refresh'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CLAUDE_ROUTER_STATUS_NO_REFRESH: '1' },
    });
    child.unref();
  } catch {
    // The next status line refresh tries again.
  }
}

/**
 * One status-line string: current model and elapsed time, the sampled strip,
 * then the router version. `columns` (usually COLUMNS) trims the oldest cells
 * so the line stays inside the terminal row. Pure; no I/O.
 */
export function buildStatusLine(state) {
  const {
    cells = [], inFlight = [], now, lastEventAt = null,
    color = true, version = null, versionContext = null, available = true, columns = 0,
  } = state;

  let versionInfo = versionSegment(version, versionContext || {});
  let shown = cells;
  let statusPlain = null;

  if (available) {
    const latest = inFlight.length ? inFlight[0] : null;
    if (latest) {
      statusPlain = `● ${NAMES[latest.provider]} ${formatElapsed(now - latest.start)}`;
    } else {
      // No timer when idle: a fresh terminal must not inherit the age of the
      // last untagged request in the log and claim it has been idle for 28m.
      statusPlain = '○ idle';
    }

    if (columns > 0) {
      const reserve = 4;
      let budget = columns - reserve - statusPlain.length - 2
        - (versionInfo ? 2 + versionInfo.text.length : 0);
      if (budget < 6 && versionInfo) {
        versionInfo = null;
        budget = columns - reserve - statusPlain.length - 2;
      }
      if (budget < cells.length) shown = cells.slice(-Math.max(4, budget));
    }
  }

  const parts = [];
  if (available) {
    const latest = inFlight.length ? inFlight[0] : null;
    const pulse = latest ? paint('●', latest.provider, color) : paint('○', 'dim', color);
    const status = statusPlain.replace(/^[●○]/, pulse);
    const strip = shown.map(cell => {
      if (cell.model === 'idle') return color ? paint('·', 'dim', color) : '.';
      if (!color) return cell.model === 'deepseek' ? 'D' : 'K';
      return paint('█', cell.model, color);
    }).join('');
    parts.push(status, strip);
  }
  if (versionInfo) parts.push(paint(versionInfo.text, versionInfo.update ? 'amber' : 'dim', color));

  return parts.join('  ');
}

function readTail(file, bytes) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - bytes);
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    let offset = 0;
    while (offset < length) {
      const read = fs.readSync(fd, buffer, offset, length - offset, start + offset);
      if (!read) break;
      offset += read;
    }
    return { text: buffer.subarray(0, offset).toString('utf8'), start };
  } finally {
    fs.closeSync(fd);
  }
}

export function readStatusState({ logPath, now = Date.now(), cells = DEFAULTS.cells, cellMs = DEFAULTS.cellMs, session = null }) {
  const activity = createActivity({ session });
  let available = false;
  try {
    const { text, start } = readTail(logPath, TAIL_BYTES);
    available = true;
    let body = text;
    if (start > 0) {
      const newline = body.indexOf('\n');
      body = newline === -1 ? '' : body.slice(newline + 1);
    }
    for (const line of body.split('\n')) {
      // `started` closes requests the previous process left open; dropping it
      // makes a restart's orphans look active for STALE_OPEN_MS in every view.
      if (!line.includes('route_decision') && !line.includes('request_complete')
        && !line.includes('"event":"started"')) continue;
      activity.ingestLine(line);
    }
  } catch {
    // No log yet: the strip is omitted and only the version is shown.
  }
  return {
    available,
    cells: activity.cells({ now, cellMs, count: cells }),
    inFlight: activity.inFlight(now),
    lastEventAt: activity.lastEventAt,
    now,
  };
}

export function defaultPaths() {
  const dataDir = process.env.CLAUDE_ROUTER_DATA_DIR || path.join(os.homedir(), '.claude', 'model-router');
  return {
    logPath: process.env.CLAUDE_ROUTER_LOG || path.join(dataDir, 'router.log'),
    versionCachePath: process.env.CLAUDE_ROUTER_VERSION_CACHE || path.join(dataDir, 'version-cache.json'),
  };
}

/**
 * Claude Code passes one JSON object on the status line command's stdin. Only
 * `session_id` is used, so each terminal sees its own model activity rather
 * than the whole router. Missing or malformed input just means the global view.
 */
export function readStatusInput() {
  try {
    if (process.stdin.isTTY) return null;
    const text = fs.readFileSync(0, 'utf8');
    if (!text.trim()) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function statusLine(options = {}) {
  const paths = defaultPaths();
  const now = options.now ?? Date.now();
  const color = options.color ?? !process.env.NO_COLOR;
  const defaults = sampling(process.env);
  const cells = options.cells ?? defaults.cells;
  const cellMs = options.cellMs ?? defaults.cellMs;
  const columns = options.columns ?? (Number(process.env.COLUMNS) || 0);
  const input = options.input !== undefined ? options.input : readStatusInput();
  const session = sessionTag(input?.session_id) ?? null;
  const state = readStatusState({ logPath: paths.logPath, now, cells, cellMs, session });

  const version = readJson(paths.versionCachePath);
  const dataDir = path.dirname(paths.versionCachePath);
  const configPath = process.env.CLAUDE_ROUTER_CONFIG || path.join(dataDir, 'config.json');
  const versionContext = {
    installed: installedRelease(dataDir),
    autoUpdate: readJson(configPath)?.updates?.auto === true,
    autoState: readJson(path.join(dataDir, 'auto-update-state.json')),
  };
  // The render itself never touches the network; a stale cache gets one
  // detached GitHub check, throttled across windows.
  spawnVersionRefresh(version, paths.versionCachePath);

  return buildStatusLine({ ...state, color, version, versionContext, columns });
}

// Resolve symlinks first: macOS /tmp is a symlink, so a plain path comparison
// would silently disable the command-line entry point there.
let isMain = false;
try {
  isMain = Boolean(process.argv[1])
    && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
} catch {
  isMain = false;
}
if (isMain) {
  try {
    const line = statusLine();
    if (line) process.stdout.write(`${line}\n`);
  } catch {
    // A broken status helper must never disturb Claude Code.
  }
  process.exitCode = 0;
}
