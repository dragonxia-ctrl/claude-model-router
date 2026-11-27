export const LATENCY_CHECKPOINT_DEFAULTS = Object.freeze({
  // Off by default: latency-aware review changes routing with wall-clock data
  // that is noisy across machines and provider load. Enable it explicitly.
  enabled: false,
  // Kimi is under pressure when its tokens/second stays below enterRatio of the
  // DeepSeek baseline; pressure clears above exitRatio. The gap is hysteresis.
  enterRatio: 0.6,
  exitRatio: 0.8,
  samples: 3,
  // A latency checkpoint may only open this long after the previous checkpoint,
  // so a fast provider cannot churn the route on every request.
  fastWindowMs: 90_000,
  // After returning to Kimi, do not immediately re-enter a latency probe.
  cooldownRequests: 8,
  // Latency review is only useful in mechanical phases (reads, greps, tests).
  // In design-heavy phases switching providers costs more than it saves.
  minReadOnlyShare: 0.5,
  minOutputTokens: 20,
  minBaselineSamples: 3,
  emaAlpha: 0.2,
});

export const DEESCALATION_DEFAULTS = Object.freeze({
  enabled: true,
  minKimiRequests: 4,
  probeRequests: 2,
  maxAttempts: 3,
  maxBackoffRequests: 16,
  // Recovery is reviewed on several independent clocks. A clean task should not
  // need 24 new tool calls (or a new human message) before it can leave Kimi.
  windowToolCalls: 12,
  windowRequests: 6,
  windowMs: 300_000,
  // maxAttempts controls the normal backoff cycle, not a permanent Kimi lock.
  // Set this to 0 to retain the old "stop probing after maxAttempts" behaviour.
  retryAfterExhaustedRequests: 16,
  minRecentToolCalls: 4,
  maxFailureRate: 0.1,
  // A failure rate over a 1-2 call window is not evidence. Require at least
  // this many calls in the denominator and two actual failures before a rate
  // can block or relapse a recovery.
  minFailureDenominator: 10,
  // Soft recovery failures (trailing failure, failure rate, mutation repeats)
  // must be seen on this many consecutive reviews. Hard evidence (failed
  // verification, repeated error group) still relapses immediately.
  relapseConfirmations: 2,
  maxMutationRepeats: 2,
  latencyCheckpoint: LATENCY_CHECKPOINT_DEFAULTS,
});

export function deescalationSettings(config) {
  const policy = config.routing?.deescalation || {};
  const { latencyCheckpoint, ...rest } = policy;
  return {
    ...DEESCALATION_DEFAULTS,
    ...rest,
    latencyCheckpoint: { ...LATENCY_CHECKPOINT_DEFAULTS, ...(latencyCheckpoint || {}) },
  };
}

/**
 * Evaluate only recent evidence. Cumulative failures remain valid escalation
 * evidence, but must not permanently prevent a recovered task leaving Kimi.
 *
 * `serious` marks evidence that should relapse immediately. Soft evidence is
 * confirmed across consecutive reviews by the decision engine.
 */
export function evaluateRecovery(recovery, settings = DEESCALATION_DEFAULTS) {
  if (!recovery) return { clean: false, blockers: ['recovery evidence unavailable'], serious: true };
  const blockers = [];
  const failedResults = Number.isFinite(recovery.failedResults)
    ? recovery.failedResults
    : Number.isFinite(recovery.failureRate)
      ? recovery.failureRate * Math.max(recovery.toolCalls || 0, 1)
      : 0;
  const denominator = Math.max(recovery.toolCalls || 0, settings.minFailureDenominator ?? 1);
  const failureRate = denominator > 0 ? failedResults / denominator : 0;
  if (recovery.toolCalls > 0 && recovery.toolCalls < settings.minRecentToolCalls) {
    blockers.push(`only ${recovery.toolCalls} recent tool calls`);
  }
  if (recovery.failedVerifications > 0) {
    blockers.push(`${recovery.failedVerifications} recent failed verifications`);
  }
  if (recovery.repeatedErrorGroups > 0) {
    blockers.push(`${recovery.repeatedErrorGroups} repeated recent error groups`);
  }
  if (recovery.trailingFailures > 0) {
    blockers.push(`${recovery.trailingFailures} trailing tool failures`);
  }
  if (failedResults >= 2 && failureRate > settings.maxFailureRate) {
    blockers.push(`recent failure rate ${failureRate.toFixed(3)} (${failedResults}/${denominator}) exceeds ${settings.maxFailureRate}`);
  }
  if (recovery.maxMutationRepeats > settings.maxMutationRepeats) {
    blockers.push(`recent mutation repeated ${recovery.maxMutationRepeats} times`);
  }
  if (recovery.successfulMutations > 0 && recovery.verificationCalls > 0 && recovery.successfulVerifications === 0) {
    blockers.push('recent edits have no successful verification');
  }
  const serious = recovery.failedVerifications > 0 || recovery.repeatedErrorGroups > 0;
  // Soft evidence is confirmed across consecutive reviews; serious evidence
  // relapses immediately. A clean result has neither.
  const soft = !serious && blockers.length > 0;
  return { clean: blockers.length === 0, blockers, serious, soft };
}

/**
 * Classify a failed DeepSeek probe. Availability failures are transient and do
 * not consume the quality-probe budget. An invalid 4xx is not task-quality
 * evidence either, but it consumes a bounded retry attempt so a persistent
 * request/configuration bug cannot probe forever.
 */
export function probeFailureClass(record = {}) {
  const status = Number(record.httpStatus);
  if (Number.isFinite(status) && status > 0) {
    if (status === 408 || status === 425 || status === 429 || status >= 500) return 'unavailable';
    if (status >= 400) return 'invalid_request';
  }
  const kind = String(record.errorKind || '').toLowerCase();
  if (kind.includes('timeout') || kind.includes('connect') || kind.includes('network') || kind.includes('stream')) {
    return 'unavailable';
  }
  if (record.outcome === 'upstream_4xx') return 'invalid_request';
  // Unknown transport failures say nothing about DeepSeek's quality.
  return 'unavailable';
}

/** Multiplicative increase after a failed probe, capped to bound Kimi spend. */
export function backoffRequests(settings, attempts) {
  return Math.min(
    settings.maxBackoffRequests,
    settings.minKimiRequests * 2 ** Math.max(0, attempts),
  );
}
