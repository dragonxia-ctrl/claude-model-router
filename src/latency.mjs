import { deescalationSettings } from './deescalation.mjs';

// A non-streaming response can deliver headers only after generation, leaving
// almost no measurable generation time. Such a "sample" would look infinitely
// fast and poison the provider baseline, so ignore tiny denominators.
const MIN_GENERATION_MS = 50;

/**
 * Measure generation speed per provider without changing routing on its own.
 * The tracker is shared by all conversations because provider throughput is a
 * machine/network property, not a task property.
 *
 * tps = output_tokens / (durationMs - ttfbMs). `ttfbMs` is the time to response
 * headers, so the denominator excludes request upload and queue time.
 */
export function createLatencyTracker(getConfig, options = {}) {
  const now = options.now || Date.now;
  const baselines = new Map();
  let pressure = false;
  let slowStreak = 0;
  let fastStreak = 0;
  let latest = null;

  function settings() {
    return deescalationSettings(getConfig()).latencyCheckpoint;
  }

  function baseline(provider) {
    return baselines.get(provider) || null;
  }

  function update(provider, field, value, alpha) {
    let entry = baselines.get(provider);
    if (!entry) {
      entry = { tps: null, ttfbMs: null, tpsSamples: 0, ttfbSamples: 0, updatedAt: null };
      baselines.set(provider, entry);
    }
    if (field === 'tps') {
      entry.tps = entry.tps == null ? value : alpha * value + (1 - alpha) * entry.tps;
      entry.tpsSamples += 1;
    } else {
      entry.ttfbMs = entry.ttfbMs == null ? value : alpha * value + (1 - alpha) * entry.ttfbMs;
      entry.ttfbSamples += 1;
    }
    entry.updatedAt = now();
  }

  function updatePressure(provider, config) {
    if (!config.enabled) {
      pressure = false;
      slowStreak = 0;
      fastStreak = 0;
      return;
    }
    // Pressure describes Kimi, not whichever provider just answered.
    if (provider !== 'kimi') return;
    const kimi = baseline('kimi');
    const deepseek = baseline('deepseek');
    if (!kimi || !deepseek || !kimi.tps || !deepseek.tps) return;
    if (kimi.tpsSamples < config.minBaselineSamples || deepseek.tpsSamples < config.minBaselineSamples) return;
    const ratio = kimi.tps / deepseek.tps;
    if (ratio < config.enterRatio) {
      slowStreak += 1;
      fastStreak = 0;
      if (slowStreak >= Math.max(1, config.samples)) pressure = true;
    } else if (ratio > config.exitRatio) {
      fastStreak += 1;
      slowStreak = 0;
      if (fastStreak >= Math.max(1, config.samples)) pressure = false;
    }
  }

  /**
   * Record one finished main request. Returns and attaches the latency fields
   * that telemetry and the recovery log use. Errors and token counting are not
   * samples because they do not measure generation speed.
   */
  function observe(record) {
    if (!record || record.outcome !== 'success' || record.purpose !== 'main') return null;
    const config = settings();
    const provider = record.provider;
    const usage = record.usage || {};
    const outputTokens = Number(usage.output_tokens ?? usage.outputTokens) || 0;
    const ttfbMs = Number.isFinite(record.ttfbMs) ? record.ttfbMs : null;
    const durationMs = Number.isFinite(record.durationMs) ? record.durationMs : null;
    const genMs = ttfbMs != null && durationMs != null ? Math.max(0, durationMs - ttfbMs) : null;
    const tps = genMs >= MIN_GENERATION_MS && outputTokens >= config.minOutputTokens
      ? outputTokens / (genMs / 1000)
      : null;
    const previousProvider = record.route?.previousProvider || null;
    const switched = Boolean(previousProvider && previousProvider !== provider);

    // A switch pays for a new provider's prefill. Compare this request's TTFB
    // with the target provider's own baseline before adding this sample.
    let switchPrefillPenaltyMs = null;
    if (switched && ttfbMs != null) {
      const target = baseline(provider);
      if (target && target.ttfbSamples >= config.minBaselineSamples) {
        switchPrefillPenaltyMs = Math.round(ttfbMs - target.ttfbMs);
      }
    }

    if (ttfbMs != null) update(provider, 'ttfbMs', ttfbMs, config.emaAlpha);
    if (tps != null) {
      update(provider, 'tps', tps, config.emaAlpha);
      updatePressure(provider, config);
    }

    const result = {
      genMs,
      outputTokens: outputTokens || null,
      tps,
      providerTps: baseline(provider)?.tps ?? null,
      deepseekTps: baseline('deepseek')?.tps ?? null,
      switchPrefillPenaltyMs,
      latencyPressure: pressure,
    };
    Object.assign(record, result);
    latest = { at: record.at || new Date(now()).toISOString(), provider, switched, ...result };
    return result;
  }

  function isPressure() {
    return Boolean(settings().enabled && pressure);
  }

  function snapshot() {
    const kimi = baseline('kimi');
    const deepseek = baseline('deepseek');
    return {
      enabled: Boolean(settings().enabled),
      pressure: isPressure(),
      slowStreak,
      fastStreak,
      kimiTps: kimi?.tps ?? null,
      deepseekTps: deepseek?.tps ?? null,
      kimiSamples: kimi?.tpsSamples ?? 0,
      deepseekSamples: deepseek?.tpsSamples ?? 0,
      last: latest,
    };
  }

  return { observe, pressure: isPressure, snapshot };
}
