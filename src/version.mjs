import fs from 'node:fs';
import path from 'node:path';

export const ROUTER_VERSION = '1.5.1';
export const REPOSITORY = 'dragonxia-ctrl/claude-model-router';

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;

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

/**
 * The text Claude Code shows for the router: running release, published
 * release, and — when the files on disk are newer than the running process, or
 * an automatic install is in flight — the state that explains the difference.
 * Both the activity strip (src/status-line.mjs) and the plain version helper
 * (scripts/version-status.mjs) render this, so the wording cannot drift.
 */
export function versionState(info, { installed = null, autoUpdate = false, autoState = null } = {}) {
  if (!info?.current) return null;
  const label = value => (String(value).startsWith('v') ? String(value) : `v${value}`);
  const current = label(info.current);
  const latest = parseVersion(info.latest) ? info.latest : null;
  const pendingRestart = Boolean(installed && compareVersions(installed, info.current) > 0);
  const available = Boolean(
    !pendingRestart && latest && compareVersions(latest, info.current) > 0,
  );
  if (pendingRestart) {
    // Deployed but not restarted: the process still runs the old release.
    return { text: `router ${current} · update installed, restart to update`, tone: 'amber' };
  }
  if (available) {
    const same = value => value && compareVersions(value, latest) === 0;
    let text = `router ${current} · ${label(latest)} available`;
    if (autoUpdate === true) {
      if (autoState?.status === 'running' && same(autoState.version)) {
        text += ' · auto-update running';
      } else if (autoState?.status === 'failed' && same(autoState.lastVersion)) {
        text += ' · auto-update failed';
      } else {
        text += ' · auto-update on';
      }
    }
    return { text, tone: 'amber' };
  }
  if (latest) return { text: `router ${current} · latest ${label(latest)}`, tone: 'dim' };
  return { text: `router ${current}`, tone: 'dim' };
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

/** Read the shared version cache; missing or corrupt files mean "not checked". */
export function readVersionCache(cachePath) {
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return cached && typeof cached === 'object' && !Array.isArray(cached) ? cached : null;
  } catch {
    return null;
  }
}

/**
 * Merge a patch into the version cache atomically. The running router, the
 * status line refresher, and the updater all write this file, so a writer must
 * never drop fields it does not own (for example the router's `current` or any
 * field another process added).
 */
export function writeVersionCache(cachePath, patch) {
  const next = { ...(readVersionCache(cachePath) || {}), ...patch };
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(temporary, cachePath);
  return next;
}

/**
 * The GitHub lookup order: newest release, then the version on main, then the
 * highest tag. Kept separate from the checker so the status line's background
 * refresher can look up only the published release.
 */
export function createLatestLookup({
  fetchImpl = globalThis.fetch,
  endpoint = `https://api.github.com/repos/${REPOSITORY}/releases/latest`,
  packageEndpoint = `https://api.github.com/repos/${REPOSITORY}/contents/package.json?ref=main`,
  tagsEndpoint = `https://api.github.com/repos/${REPOSITORY}/tags`,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = () => {},
} = {}) {
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
      // Repositories without GitHub releases still publish the released
      // version on main. The contents API is used instead of
      // raw.githubusercontent.com because only api.github.com is reachable
      // from some networks.
      const file = await fetchJson(packageEndpoint);
      const text = file?.content
        ? Buffer.from(String(file.content).replace(/\s/g, ''), 'base64').toString('utf8')
        : null;
      const pkg = text ? JSON.parse(text) : null;
      if (parseVersion(pkg?.version)) return pkg.version;
    } catch (error) {
      logger('version_package_lookup_failed', error);
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

  return { lookupLatest };
}

/**
 * Tracks the newest published release without ever blocking a request.
 * The first call returns whatever the on-disk cache holds; refresh() updates it
 * in the background and is retried at most once per interval. The constructor
 * seeds the cache with the running release so the status line knows which
 * process is live even when another writer refreshed the cache in between.
 */
export function createUpdateChecker({
  current = ROUTER_VERSION,
  cachePath = null,
  fetchImpl = globalThis.fetch,
  endpoint = `https://api.github.com/repos/${REPOSITORY}/releases/latest`,
  packageEndpoint = `https://api.github.com/repos/${REPOSITORY}/contents/package.json?ref=main`,
  tagsEndpoint = `https://api.github.com/repos/${REPOSITORY}/tags`,
  intervalMs = DEFAULT_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
  logger = () => {},
  // The status line's refresher only owns the release fields. It must not
  // write `current` (owned by the running router) or the derived status, or a
  // check that raced a restart could advertise the previous process.
  writeStatus = true,
} = {}) {
  const cached = cachePath ? readVersionCache(cachePath) : null;
  let state = { latest: null, checkedAt: null };
  let inflight = null;

  if (cached) {
    const checkedAt = Date.parse(cached.checkedAt);
    if (parseVersion(cached.latest) && Number.isFinite(checkedAt)) {
      state = { latest: String(cached.latest), checkedAt: new Date(checkedAt).toISOString() };
    }
    // A restarted router must immediately be visible as `current`, even when
    // the cached release check is still fresh and no network call happens.
    if (writeStatus && current && cached.current !== current) {
      try {
        writeVersionCache(cachePath, { current });
      } catch (error) {
        logger('version_cache_write_failed', error);
      }
    }
  }

  const { lookupLatest } = createLatestLookup({
    fetchImpl, endpoint, packageEndpoint, tagsEndpoint, timeoutMs, logger,
  });

  // The status line and this process share the cache. If another writer has a
  // fresher check, take it instead of reporting an older in-memory answer.
  function syncFromCache() {
    if (!cachePath) return;
    const fresh = readVersionCache(cachePath);
    const freshAt = Date.parse(fresh?.checkedAt);
    const ownAt = Date.parse(state.checkedAt);
    if (!parseVersion(fresh?.latest) || !Number.isFinite(freshAt)) return;
    if (Number.isFinite(ownAt) && freshAt <= ownAt) return;
    state = { latest: String(fresh.latest), checkedAt: new Date(freshAt).toISOString() };
  }

  function info() {
    syncFromCache();
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
      // The cache is also the status line's data source, so it stores the whole
      // info object: running release, latest release, and update state. The
      // merge in writeVersionCache keeps fields owned by other writers.
      writeVersionCache(cachePath, writeStatus
        ? info()
        : { latest: state.latest, checkedAt: state.checkedAt });
    } catch (error) {
      logger('version_cache_write_failed', error);
    }
  }

  async function refresh({ force = false } = {}) {
    // Take a fresher check written by another process first: the status line
    // refresher and this checker must not overwrite each other with older data.
    syncFromCache();
    if (!force && !isStale()) return info();
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const latest = await lookupLatest();
        // A failed lookup still records the attempt: otherwise an offline
        // machine would retry on every request and every status line render.
        // The last known release is kept instead of being erased.
        state = {
          latest: latest || state.latest,
          checkedAt: new Date(now()).toISOString(),
        };
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
