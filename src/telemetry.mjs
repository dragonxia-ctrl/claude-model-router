import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';

export const HISTOGRAM_BUCKETS_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120];
export const HISTOGRAM_BUCKETS_TOKENS_PER_SECOND = [1, 2, 5, 10, 20, 30, 50, 80, 120, 200, 400, 800];

const DEFAULTS = Object.freeze({
  enabled: true,
  persist: false,
  directory: null,
  retentionDays: 30,
  maxFileBytes: 32 * 1024 * 1024,
  maxWriteBufferBytes: 1024 * 1024,
});

function sortedLabels(labels = {}) {
  return Object.entries(labels)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [key, String(value).slice(0, 96)])
    .sort(([a], [b]) => a.localeCompare(b));
}

function metricKey(name, labels) {
  return `${name}\0${JSON.stringify(sortedLabels(labels))}`;
}

function escapePrometheus(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function renderLabels(labels) {
  const entries = sortedLabels(labels);
  if (!entries.length) return '';
  return `{${entries.map(([key, value]) => `${key}="${escapePrometheus(value)}"`).join(',')}}`;
}

function errorKindOf(error) {
  if (error?.name === 'AbortError') return 'timeout';
  const message = String(error?.message || '');
  const status = message.match(/HTTP\s+(\d{3})/i);
  if (status) return `http_${status[1]}`;
  if (/JSON|parse|invalid|no JSON/i.test(message)) return 'invalid_response';
  return 'request_error';
}

export function createTelemetry(options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const startedAt = Date.now();
  const counters = new Map();
  const histograms = new Map();
  const state = {
    written: 0,
    dropped: 0,
    writeErrors: 0,
    lastUpstreamSuccess: null,
    lastUpstreamError: null,
    lastSemanticTriage: null,
  };

  let stream = null;
  let streamDay = null;
  let streamBytes = 0;
  let streamSequence = 0;
  let salt = null;
  let lastCleanupDay = null;

  function inc(name, labels = {}, value = 1) {
    const key = metricKey(name, labels);
    const entry = counters.get(key);
    if (entry) entry.value += value;
    else counters.set(key, { name, labels: Object.fromEntries(sortedLabels(labels)), value });
  }

  function observe(name, labels = {}, value = 0, bucketDef = HISTOGRAM_BUCKETS_SECONDS) {
    const key = metricKey(name, labels);
    let entry = histograms.get(key);
    if (!entry) {
      entry = {
        name,
        labels: Object.fromEntries(sortedLabels(labels)),
        bucketDef,
        buckets: Array(bucketDef.length).fill(0),
        sum: 0,
        count: 0,
      };
      histograms.set(key, entry);
    }
    const numeric = Math.max(0, Number(value) || 0);
    entry.sum += numeric;
    entry.count += 1;
    const index = entry.bucketDef.findIndex(bound => numeric <= bound);
    if (index !== -1) entry.buckets[index] += 1;
  }

  function loadSalt() {
    if (!settings.persist || !settings.directory) return randomBytes(32);
    fs.mkdirSync(settings.directory, { recursive: true, mode: 0o700 });
    const saltPath = path.join(settings.directory, '.telemetry-salt');
    try {
      const existing = fs.readFileSync(saltPath, 'utf8').trim();
      if (/^[a-f0-9]{64}$/i.test(existing)) return Buffer.from(existing, 'hex');
    } catch {
      // Create the salt below.
    }
    const created = randomBytes(32);
    fs.writeFileSync(saltPath, created.toString('hex'), { mode: 0o600 });
    return created;
  }

  try {
    salt = loadSalt();
  } catch (error) {
    settings.persist = false;
    salt = randomBytes(32);
    console.error(JSON.stringify({ event: 'telemetry_persistence_disabled', message: error.message }));
  }

  function pseudonym(value) {
    if (value === undefined || value === null || value === '') return null;
    return createHmac('sha256', salt).update(String(value)).digest('hex').slice(0, 32);
  }

  function cleanupRetention() {
    if (!settings.persist || !settings.directory) return;
    const today = new Date().toISOString().slice(0, 10);
    if (lastCleanupDay === today) return;
    lastCleanupDay = today;
    let names;
    try { names = fs.readdirSync(settings.directory); } catch { return; }
    const cutoff = Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000;
    for (const name of names) {
      if (!/^requests-\d{4}-\d{2}-\d{2}(?:-\d+)?\.jsonl$/.test(name)) continue;
      const file = path.join(settings.directory, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch {
        // Retention is best effort; a later run retries.
      }
    }
  }

  function openStream() {
    cleanupRetention();
    const day = new Date().toISOString().slice(0, 10);
    if (!stream || streamDay !== day || streamBytes >= settings.maxFileBytes) {
      if (stream) stream.end();
      if (streamDay === day) streamSequence += 1;
      else { streamSequence = 0; streamDay = day; }
      const suffix = streamSequence ? `-${streamSequence}` : '';
      const file = path.join(settings.directory, `requests-${day}${suffix}.jsonl`);
      streamBytes = 0;
      try { streamBytes = fs.statSync(file).size; } catch { /* New file. */ }
      stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
      stream.on('error', error => {
        state.writeErrors += 1;
        console.error(JSON.stringify({ event: 'telemetry_write_error', message: error.message }));
      });
    }
  }

  function persist(record) {
    if (!settings.persist || !settings.directory) return;
    try {
      openStream();
      if (stream.writableLength > settings.maxWriteBufferBytes) {
        state.dropped += 1;
        return;
      }
      const line = `${JSON.stringify(record)}\n`;
      streamBytes += Buffer.byteLength(line);
      stream.write(line);
      state.written += 1;
    } catch (error) {
      state.writeErrors += 1;
      state.dropped += 1;
      console.error(JSON.stringify({ event: 'telemetry_persist_error', message: error.message }));
    }
  }

  function recordRequest(record) {
    if (!settings.enabled) return;
    const provider = record.provider || 'unknown';
    const model = record.model || 'unknown';
    const purpose = record.purpose || 'main';
    const outcome = record.outcome || 'unknown';
    inc('claude_router_requests_total', { provider, model, purpose, outcome });
    if (Number.isFinite(record.durationMs)) {
      observe('claude_router_request_duration_seconds', { provider, model, purpose }, record.durationMs / 1000);
    }
    if (Number.isFinite(record.ttfbMs)) {
      observe('claude_router_upstream_ttfb_seconds', { provider, model }, record.ttfbMs / 1000);
    }
    if (Number.isFinite(record.tps)) {
      observe('claude_router_output_tokens_per_second', { provider, model, purpose }, record.tps, HISTOGRAM_BUCKETS_TOKENS_PER_SECOND);
    }
    if (Number.isFinite(record.switchPrefillPenaltyMs)) {
      // A faster-than-baseline switch has no penalty; clamp it to zero.
      observe('claude_router_switch_prefill_penalty_seconds', { provider, model },
        Math.max(0, record.switchPrefillPenaltyMs) / 1000);
    }
    if (record.usage) {
      const tokenFields = {
        input: 'input_tokens',
        output: 'output_tokens',
        cache_read: 'cache_read_input_tokens',
        cache_creation: 'cache_creation_input_tokens',
      };
      for (const [type, key] of Object.entries(tokenFields)) {
        if (record.usage[key]) inc('claude_router_tokens_total', { provider, model, type }, record.usage[key]);
      }
    }
    if (record.route) {
      inc('claude_router_route_decisions_total', {
        provider: record.route.selectedProvider,
        source: record.route.source,
        purpose,
      });
      if (record.route.deescalationOutcome) {
        inc('claude_router_deescalation_total', { outcome: record.route.deescalationOutcome });
        if (record.route.deescalationOutcome === 'relapse'
          || record.route.deescalationOutcome === 'probe_relapsed') {
          inc('claude_router_relapses_total', { outcome: record.route.deescalationOutcome });
        }
      }
      if (record.route.previousProvider && record.route.previousProvider !== record.route.selectedProvider) {
        inc('claude_router_provider_switches_total', {
          from_provider: record.route.previousProvider,
          to_provider: record.route.selectedProvider,
          source: record.route.source,
        });
      }
      if (record.probeFailureClass) {
        inc('claude_router_probe_failures_total', { failure_class: record.probeFailureClass });
      }
      if (record.route.escalated) {
        inc('claude_router_escalations_total', {
          from_provider: record.route.previousProvider || 'none',
          to_provider: record.route.selectedProvider,
          source: record.route.source,
        });
      }
    }
    if (purpose === 'main') {
      if (outcome === 'success') {
        state.lastUpstreamSuccess = { at: record.at, provider, model, durationMs: record.durationMs };
      } else {
        state.lastUpstreamError = {
          at: record.at, provider, model, outcome, errorKind: record.errorKind || null,
          httpStatus: record.httpStatus || null,
        };
      }
    } else if (purpose === 'semantic_triage') {
      state.lastSemanticTriage = {
        at: record.at, outcome, durationMs: record.durationMs,
        tokens: record.usage ? record.usage.input_tokens + record.usage.output_tokens : null,
      };
    }

    console.log(JSON.stringify({
      event: 'request_complete',
      requestId: record.requestId,
      provider,
      model,
      purpose,
      outcome,
      httpStatus: record.httpStatus || null,
      durationMs: record.durationMs ?? null,
      ttfbMs: record.ttfbMs ?? null,
      genMs: record.genMs ?? null,
      tps: record.tps ?? null,
      switchPrefillPenaltyMs: record.switchPrefillPenaltyMs ?? null,
      probeFailureClass: record.probeFailureClass || null,
      usage: record.usage || null,
      errorKind: record.errorKind || null,
    }));

    persist({
      schema_version: 1,
      at: record.at,
      request_id: record.requestId,
      conversation_key: pseudonym(record.conversationKey),
      task_key: pseudonym(record.taskKey),
      provider,
      model,
      purpose,
      outcome,
      http_status: record.httpStatus || null,
      ttfb_ms: record.ttfbMs ?? null,
      gen_ms: record.genMs ?? null,
      duration_ms: record.durationMs ?? null,
      tps: record.tps ?? null,
      switch_prefill_penalty_ms: record.switchPrefillPenaltyMs ?? null,
      probe_failure_class: record.probeFailureClass || null,
      usage: record.usage || null,
      error_kind: record.errorKind || null,
      route: record.route || null,
    });
  }

  function snapshot() {
    const histogramSummary = [];
    for (const entry of histograms.values()) {
      const buckets = [];
      let cumulative = 0;
      for (let index = 0; index < entry.buckets.length; index += 1) {
        cumulative += entry.buckets[index];
        const bucket = { le: entry.bucketDef[index], count: cumulative };
        // Keep the original field for consumers of the seconds histograms.
        if (entry.bucketDef === HISTOGRAM_BUCKETS_SECONDS) bucket.leSeconds = entry.bucketDef[index];
        buckets.push(bucket);
      }
      const summary = {
        name: entry.name,
        labels: entry.labels,
        count: entry.count,
        sum: Math.round(entry.sum * 1000) / 1000,
        average: entry.count ? Math.round((entry.sum / entry.count) * 1000) / 1000 : 0,
        buckets,
      };
      // Preserve the established units for the original seconds histograms,
      // but do not describe a tokens/second histogram as seconds.
      if (entry.bucketDef === HISTOGRAM_BUCKETS_SECONDS) {
        summary.sumSeconds = summary.sum;
        summary.averageSeconds = summary.average;
      }
      histogramSummary.push(summary);
    }
    return {
      enabled: settings.enabled,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      counters: [...counters.values()],
      histograms: histogramSummary,
      persistence: {
        enabled: Boolean(settings.persist && settings.directory),
        written: state.written,
        dropped: state.dropped,
        writeErrors: state.writeErrors,
        retentionDays: settings.retentionDays,
      },
      lastUpstreamSuccess: state.lastUpstreamSuccess,
      lastUpstreamError: state.lastUpstreamError,
      lastSemanticTriage: state.lastSemanticTriage,
    };
  }

  function renderPrometheus() {
    const lines = [];
    lines.push('# HELP claude_router_up Whether the router process is running.');
    lines.push('# TYPE claude_router_up gauge');
    lines.push('claude_router_up 1');
    lines.push('# HELP claude_router_uptime_seconds Seconds since the router started.');
    lines.push('# TYPE claude_router_uptime_seconds gauge');
    lines.push(`claude_router_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`);
    const counterTypes = new Set();
    for (const entry of counters.values()) {
      if (!counterTypes.has(entry.name)) {
        lines.push(`# TYPE ${entry.name} counter`);
        counterTypes.add(entry.name);
      }
      lines.push(`${entry.name}${renderLabels(entry.labels)} ${entry.value}`);
    }
    const histogramTypes = new Set();
    for (const entry of histograms.values()) {
      if (!histogramTypes.has(entry.name)) {
        lines.push(`# TYPE ${entry.name} histogram`);
        histogramTypes.add(entry.name);
      }
      let cumulative = 0;
      for (let index = 0; index < entry.buckets.length; index += 1) {
        cumulative += entry.buckets[index];
        lines.push(`${entry.name}_bucket${renderLabels({ ...entry.labels, le: String(entry.bucketDef[index]) })} ${cumulative}`);
      }
      lines.push(`${entry.name}_bucket${renderLabels({ ...entry.labels, le: '+Inf' })} ${entry.count}`);
      lines.push(`${entry.name}_sum${renderLabels(entry.labels)} ${entry.sum.toFixed(3)}`);
      lines.push(`${entry.name}_count${renderLabels(entry.labels)} ${entry.count}`);
    }
    lines.push('# HELP claude_router_telemetry_dropped_records_total Records dropped because the telemetry buffer was full.');
    lines.push('# TYPE claude_router_telemetry_dropped_records_total counter');
    lines.push(`claude_router_telemetry_dropped_records_total ${state.dropped}`);
    return `${lines.join('\n')}\n`;
  }

  async function close() {
    if (!stream) return;
    const pendingStream = stream;
    stream = null;
    await new Promise(resolve => {
      pendingStream.end(resolve);
    });
  }

  return { settings, recordRequest, snapshot, renderPrometheus, close, errorKindOf };
}
