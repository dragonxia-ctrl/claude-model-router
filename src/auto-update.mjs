import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { compareVersions } from './version.mjs';

// The router checks on this cadence; the status line may refresh the shared
// cache more often when Claude Code is open.
export const AUTO_UPDATE_TICK_MS = 60 * 1000;
export const AUTO_UPDATE_RETRY_MS = 60 * 60 * 1000;
export const AUTO_UPDATE_RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const AUTO_UPDATE_STATE_FILE = 'auto-update-state.json';
export const AUTO_UPDATE_LOG_FILE = 'auto-update.log';

export function autoUpdateStatePath(dataDir) {
  return path.join(dataDir, AUTO_UPDATE_STATE_FILE);
}

export function readAutoUpdateState(dataDir) {
  try {
    const state = JSON.parse(fs.readFileSync(autoUpdateStatePath(dataDir), 'utf8'));
    return state && typeof state === 'object' && !Array.isArray(state) ? state : null;
  } catch {
    return null;
  }
}

export function writeAutoUpdateState(dataDir, patch) {
  const file = autoUpdateStatePath(dataDir);
  const next = { ...(readAutoUpdateState(dataDir) || {}), ...patch };
  fs.mkdirSync(dataDir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(temporary, file);
  return next;
}

/**
 * The auto-update switch and the install location. `auto` is off unless the
 * config explicitly turns it on; the source defaults to the checkout the
 * manual installer uses.
 */
export function resolveAutoUpdateSettings(config, env = process.env) {
  const updates = config?.updates || {};
  return {
    auto: updates.auto === true,
    source: updates.source || env.CLAUDE_ROUTER_SOURCE || path.join(os.homedir(), 'claude-model-router'),
    label: updates.launchdLabel || env.CLAUDE_ROUTER_LAUNCHD_LABEL || null,
  };
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

function ageMs(iso, now) {
  const value = Date.parse(iso || '');
  return Number.isFinite(value) ? now - value : Infinity;
}

/**
 * Watches the cached release check and, when the toggle is on, starts the
 * updater as a detached process. The update itself restarts the service, so it
 * must not run in the router's own process: kicking launchd would kill the
 * verifier halfway through. State is kept on disk so a crash or a failed run
 * backs off instead of respawning on every tick.
 */
export function createAutoUpdater({
  dataDir,
  getConfig,
  updateChecker,
  updaterPath = path.join(dataDir, 'router-update.mjs'),
  spawnImpl = spawn,
  now = Date.now,
  logger = () => {},
  isAlive = isProcessAlive,
  tickMs = AUTO_UPDATE_TICK_MS,
  retryMs = AUTO_UPDATE_RETRY_MS,
  runTimeoutMs = AUTO_UPDATE_RUN_TIMEOUT_MS,
} = {}) {
  let timer = null;
  let busy = false;

  function report(event, fields = {}) {
    try {
      logger(event, fields);
    } catch {
      // Logging must never break the periodic check.
    }
  }

  const sameVersion = (a, b) => Boolean(a && b && compareVersions(a, b) === 0);

  async function tick() {
    if (busy) return { action: 'skipped', reason: 'busy' };
    busy = true;
    try {
      const info = await updateChecker.refresh();
      const config = getConfig();
      const settings = resolveAutoUpdateSettings(config);
      if (!settings.auto) return { action: 'skipped', reason: 'disabled' };
      if (!info.updateAvailable || !info.latest) return { action: 'skipped', reason: 'current' };

      const state = readAutoUpdateState(dataDir);
      const currentTime = now();

      if (state?.status === 'running') {
        const startedAt = Date.parse(state.startedAt || '');
        const alive = isAlive(state.pid);
        if (alive && Number.isFinite(startedAt) && currentTime - startedAt < runTimeoutMs) {
          return { action: 'skipped', reason: 'running' };
        }
        // The detached updater exited without recording a result (a crash or a
        // kill). Mark the attempt failed so the status line stops saying it is
        // running; the backoff check below still limits the next attempt.
        try {
          writeAutoUpdateState(dataDir, {
            status: 'failed',
            finishedAt: new Date(currentTime).toISOString(),
            message: state.message || 'Automatic update exited without reporting a result',
          });
        } catch (error) {
          report('auto_update_state_write_failed', { message: error.message });
        }
      }
      // A successful deploy that the service has not restarted from yet (or a
      // `--restart none` install) must not be deployed over and over.
      if (state?.status === 'ok' && sameVersion(state.version, info.latest)) {
        return { action: 'skipped', reason: 'installed' };
      }
      // One attempt per release per retry window, whatever the previous outcome.
      if (sameVersion(state?.lastVersion, info.latest)
        && ageMs(state.lastAttemptAt, currentTime) < retryMs) {
        return { action: 'skipped', reason: 'backoff' };
      }

      function recordFailure(reason, message) {
        writeAutoUpdateState(dataDir, {
          status: 'failed',
          lastVersion: info.latest,
          lastAttemptAt: new Date(currentTime).toISOString(),
          finishedAt: new Date(currentTime).toISOString(),
          version: info.latest,
          message,
        });
        report('auto_update_skipped', { version: info.latest, reason, message });
        return { action: 'skipped', reason };
      }

      if (!fs.existsSync(settings.source)) {
        return recordFailure('source_missing', `Source checkout not found: ${settings.source}`);
      }
      if (!fs.existsSync(updaterPath)) {
        return recordFailure('updater_missing', `Updater not found: ${updaterPath}`);
      }

      const args = [
        updaterPath, '--auto-install',
        '--source', settings.source,
        '--data-dir', dataDir,
        '--port', String(config.router?.port || 17861),
      ];
      if (settings.label) args.push('--label', settings.label);

      let child;
      let logFd;
      try {
        logFd = fs.openSync(path.join(dataDir, AUTO_UPDATE_LOG_FILE), 'a', 0o600);
        child = spawnImpl(process.execPath, args, {
          detached: true,
          stdio: ['ignore', logFd, logFd],
          cwd: dataDir,
          env: process.env,
        });
        child.unref?.();
      } catch (error) {
        report('auto_update_spawn_failed', { version: info.latest, message: error.message });
        return recordFailure('spawn_failed', error.message);
      } finally {
        if (logFd !== undefined) {
          try { fs.closeSync(logFd); } catch { /* already closed */ }
        }
      }

      const startedAt = new Date(currentTime).toISOString();
      writeAutoUpdateState(dataDir, {
        status: 'running',
        version: info.latest,
        lastVersion: info.latest,
        lastAttemptAt: startedAt,
        startedAt,
        pid: child?.pid ?? null,
      });
      report('auto_update_started', { version: info.latest, pid: child?.pid ?? null });
      return { action: 'spawned', version: info.latest };
    } catch (error) {
      report('auto_update_tick_failed', { message: error.message });
      return { action: 'skipped', reason: 'error' };
    } finally {
      busy = false;
    }
  }

  function start() {
    if (timer) return;
    void tick();
    timer = setInterval(() => { void tick(); }, tickMs);
    timer.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop };
}
