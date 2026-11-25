import fs from 'node:fs';
import path from 'node:path';

export const ROUTER_VERSION = '1.2.0';
export const REPOSITORY = 'dragonxia-ctrl/claude-model-router';

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 3000;

export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || '',
  };
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

export function updateStatus(current, latest) {
  const order = compareVersions(current, latest);
  if (order === null) return 'unknown';
  if (order < 0) return 'available';
  return order > 0 ? 'ahead' : 'current';
}

function localVersionInfo(current = ROUTER_VERSION) {
  return {
    current,
    latest: null,
    status: 'unknown',
    updateAvailable: false,
    checkedAt: null,
    repository: REPOSITORY,
  };
}

/**
 * Tracks the newest published release without ever blocking a request.
 * The first call returns whatever the on-disk cache holds; refresh() updates it
 * in the background and is retried at most once per interval.
 */
export function createUpdateChecker({
  current = ROUTER_VERSION,
  cachePath = null,
  fetchImpl = globalThis.fetch,
  endpoint = `https://api.github.com/repos/${REPOSITORY}/releases/latest`,
  tagsEndpoint = `https://api.github.com/repos/${REPOSITORY}/tags`,
  intervalMs = DEFAULT_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
  logger = () => {},
} = {}) {
  let state = { latest: null, checkedAt: null };
  let inflight = null;

  if (cachePath) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const checkedAt = Date.parse(cached.checkedAt);
      if (parseVersion(cached.latest) && Number.isFinite(checkedAt)) {
        state = { latest: String(cached.latest), checkedAt: new Date(checkedAt).toISOString() };
      }
    } catch {
      // A missing or corrupt cache just means "not checked yet".
    }
  }

  function info() {
    const status = updateStatus(current, state.latest);
    return {
      ...localVersionInfo(current),
      latest: state.latest,
      status,
      updateAvailable: status === 'available',
      checkedAt: state.checkedAt,
    };
  }

  function isStale() {
    if (!state.checkedAt) return true;
    return now() - Date.parse(state.checkedAt) >= intervalMs;
  }

  function persist() {
    if (!cachePath) return;
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      // The cache is also the status line's data source, so it stores the whole
      // info object: current release, latest release, and update state.
      fs.writeFileSync(cachePath, JSON.stringify(info()));
    } catch (error) {
      logger('version_cache_write_failed', error);
    }
  }

  async function fetchJson(url) {
    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'claude-model-router',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function lookupLatest() {
    try {
      const release = await fetchJson(endpoint);
      if (parseVersion(release?.tag_name)) return release.tag_name;
    } catch (error) {
      logger('version_release_lookup_failed', error);
    }
    try {
      const tags = await fetchJson(tagsEndpoint);
      if (Array.isArray(tags)) {
        const versions = tags.map(tag => tag?.name).filter(name => parseVersion(name));
        versions.sort(compareVersions);
        if (versions.length) return versions.at(-1);
      }
    } catch (error) {
      logger('version_tag_lookup_failed', error);
    }
    return null;
  }

  async function refresh({ force = false } = {}) {
    if (!force && !isStale()) {
      persist();
      return info();
    }
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const latest = await lookupLatest();
        if (latest) state = { latest, checkedAt: new Date(now()).toISOString() };
        else if (!state.checkedAt) state = { ...state, checkedAt: new Date(now()).toISOString() };
        persist();
      } finally {
        inflight = null;
      }
      return info();
    })();
    return inflight;
  }

  return { info, refresh, isStale, current, repository: REPOSITORY };
}
