const MODELS = new Set(['deepseek', 'kimi']);

export const MODEL_LABELS = Object.freeze({
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  idle: '空闲',
});

// A request that never reports completion (crashed process, truncated log)
// stops counting as active after this long.
export const STALE_OPEN_MS = 10 * 60 * 1000;

const MAX_INTERVALS = 20000;
const PRUNE_AFTER_MS = 2 * 60 * 60 * 1000;

function parseTime(value) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * Turns router.log events into "which model was serving at time t".
 *
 * Only two event types matter:
 *   route_decision   { time, requestId, provider }      request starts
 *   request_complete { requestId, purpose, durationMs }  request ends
 *
 * When two requests overlap, the one that started most recently wins, which
 * matches "the request the router is working on now".
 *
 * `options.session` restricts the view to one Claude Code session: route
 * decisions tagged with another session are dropped. Records without a tag
 * (written before tags existed) are kept, so an older log still renders.
 */
export function createActivity(options = {}) {
  const session = options.session ?? null;
  const intervals = [];
  const open = new Map();
  let lastEventAt = null;

  function note(time) {
    if (time != null && (lastEventAt == null || time > lastEventAt)) lastEventAt = time;
  }

  function trim() {
    if (intervals.length <= MAX_INTERVALS) return;
    const cutoff = (lastEventAt ?? 0) - PRUNE_AFTER_MS;
    let removed = 0;
    while (removed < intervals.length && intervals.length - removed > MAX_INTERVALS) {
      const entry = intervals[removed];
      if (entry.end === null || entry.end >= cutoff) break;
      removed += 1;
    }
    if (removed) intervals.splice(0, removed);
  }

  function ingest(record) {
    if (!record || typeof record !== 'object') return false;
    if (record.event === 'route_decision') {
      if (session && record.session && record.session !== session) return false;
      if (!MODELS.has(record.provider) || !record.requestId) return false;
      const start = parseTime(record.time);
      if (start == null || open.has(record.requestId)) return false;
      const entry = {
        requestId: record.requestId,
        provider: record.provider,
        start,
        end: null,
        purpose: null,
      };
      intervals.push(entry);
      open.set(record.requestId, entry);
      note(start);
      trim();
      return true;
    }
    if (record.event === 'request_complete') {
      const entry = record.requestId ? open.get(record.requestId) : null;
      if (!entry) return false;
      const duration = Number(record.durationMs);
      entry.end = entry.start + (Number.isFinite(duration) && duration >= 0 ? duration : 0);
      entry.purpose = record.purpose || 'main';
      open.delete(record.requestId);
      return true;
    }
    if (record.event === 'started') {
      // A new router process leaves the previous process's requests open.
      const at = parseTime(record.time) ?? lastEventAt ?? Date.now();
      for (const entry of open.values()) entry.end = Math.max(at, entry.start);
      open.clear();
      return true;
    }
    return false;
  }

  function ingestLine(line) {
    const text = String(line).trim();
    if (!text) return false;
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      return false;
    }
    return ingest(record);
  }

  function stateAt(time) {
    for (let index = intervals.length - 1; index >= 0; index -= 1) {
      const entry = intervals[index];
      if (entry.start > time) continue;
      if (entry.end !== null) {
        if (entry.end <= time) continue;
      } else if (time - entry.start > STALE_OPEN_MS) {
        continue;
      }
      if (entry.purpose && entry.purpose !== 'main') continue;
      return entry.provider;
    }
    return 'idle';
  }

  function cells({ now, cellMs, count }) {
    const out = [];
    // Sample on a fixed grid. Using `now` directly makes every cell's absolute
    // time drift with the render clock (Claude Code refreshes asynchronously),
    // so a block sitting on a request boundary flips model between refreshes.
    // A grid keeps each cell stable and scrolls the window in whole cells.
    const grid = Math.floor(now / cellMs) * cellMs;
    for (let index = count - 1; index >= 0; index -= 1) {
      const at = grid - index * cellMs;
      out.push({ at, model: stateAt(at) });
    }
    return out;
  }

  function inFlight(now) {
    const list = [];
    for (const entry of open.values()) {
      if (entry.purpose && entry.purpose !== 'main') continue;
      if (now - entry.start > STALE_OPEN_MS) continue;
      list.push({ provider: entry.provider, start: entry.start });
    }
    list.sort((a, b) => b.start - a.start);
    return list;
  }

  return {
    ingest,
    ingestLine,
    stateAt,
    cells,
    inFlight,
    get lastEventAt() { return lastEventAt; },
    get size() { return intervals.length; },
  };
}

export function ingestLines(activity, text) {
  let accepted = 0;
  for (const line of String(text).split('\n')) {
    if (activity.ingestLine(line)) accepted += 1;
  }
  return accepted;
}
