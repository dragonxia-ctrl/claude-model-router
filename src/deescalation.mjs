export const DEESCALATION_DEFAULTS = Object.freeze({
  enabled: true,
  minKimiRequests: 4,
  probeRequests: 2,
  maxAttempts: 3,
  maxBackoffRequests: 32,
  windowToolCalls: 24,
  minRecentToolCalls: 4,
  maxFailureRate: 0.1,
  maxMutationRepeats: 2,
});

export function deescalationSettings(config) {
  return { ...DEESCALATION_DEFAULTS, ...(config.routing?.deescalation || {}) };
}

/**
 * Evaluate only recent evidence. Cumulative failures remain valid escalation
 * evidence, but must not permanently prevent a recovered task leaving Kimi.
 */
export function evaluateRecovery(recovery, settings = DEESCALATION_DEFAULTS) {
  const blockers = [];
  if (!recovery) return { clean: false, blockers: ['recovery evidence unavailable'] };
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
  if (recovery.failureRate > settings.maxFailureRate) {
    blockers.push(`recent failure rate ${recovery.failureRate.toFixed(3)} exceeds ${settings.maxFailureRate}`);
  }
  if (recovery.maxMutationRepeats > settings.maxMutationRepeats) {
    blockers.push(`recent mutation repeated ${recovery.maxMutationRepeats} times`);
  }
  if (recovery.successfulMutations > 0 && recovery.verificationCalls > 0 && recovery.successfulVerifications === 0) {
    blockers.push('recent edits have no successful verification');
  }
  return { clean: blockers.length === 0, blockers };
}

/** Multiplicative increase after a failed probe, capped to bound Kimi spend. */
export function backoffRequests(settings, attempts) {
  return Math.min(
    settings.maxBackoffRequests,
    settings.minKimiRequests * 2 ** Math.max(0, attempts),
  );
}
