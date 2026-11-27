import { classifyRequest } from './classifier.mjs';
import { classifySemantically } from './semantic.mjs';
import { analyzeRecoveryWindow } from './progress.mjs';
import { backoffRequests, deescalationSettings, evaluateRecovery, probeFailureClass } from './deescalation.mjs';

const STATE_KEY_SEPARATOR = '\u0000';

/**
 * A conversation can contain several tasks. One state per conversation let an
 * interleaved task overwrite another task's residency and probe state, which
 * produced phantom K->D->K pulses. Keep one state per (conversation, task).
 */
function stateKeyFor(decision) {
  return `${decision.conversationKey ?? ''}${STATE_KEY_SEPARATOR}${decision.taskKey ?? ''}`;
}

function conversationKeyOf(key, state) {
  return state?.conversationKey ?? key.split(STATE_KEY_SEPARATOR)[0];
}

function initialState(decision, settings, at = Date.now()) {
  const kimi = decision.provider === 'kimi';
  return {
    provider: decision.provider,
    conversationKey: decision.conversationKey ?? null,
    taskKey: decision.taskKey,
    taskIndex: decision.task?.index ?? decision.lastUserIndex,
    lastUserIndex: decision.lastUserIndex,
    phase: kimi ? 'kimi' : 'deepseek',
    kimiRequests: kimi ? 1 : 0,
    requiredKimiRequests: kimi ? settings.minKimiRequests : 0,
    attempts: 0,
    probeSuccesses: 0,
    recovered: false,
    relapseStreak: 0,
    latencyCooldown: 0,
    availabilityFailures: 0,
    lastProbeFailure: null,
    toolCallsAtCheck: decision.stats?.toolCalls ?? 0,
    requestsAtCheck: kimi ? 1 : 0,
    checkpointAt: at,
    forceCheckpoint: false,
    at,
  };
}

function kimiState(decision, previous, settings, attempts = 0, at = Date.now()) {
  return {
    ...initialState({ ...decision, provider: 'kimi' }, settings, at),
    attempts,
    requiredKimiRequests: attempts ? backoffRequests(settings, attempts) : settings.minKimiRequests,
    // Turning back to Kimi after a probe failure also starts the latency
    // cooldown, so a fast DeepSeek period cannot immediately bounce back.
    latencyCooldown: attempts > 0 ? settings.latencyCheckpoint?.cooldownRequests ?? 0 : 0,
    lastUserIndex: decision.lastUserIndex,
    taskIndex: previous?.taskIndex ?? decision.task?.index ?? decision.lastUserIndex,
  };
}

export function createDecisionEngine(getConfig, options = {}) {
  const history = new Map();
  // Per-task state cannot answer "which provider produced the assistant turns
  // already in this conversation". A new task in the same session would then
  // look like a first request (previousProvider null), so Kimi thinking blocks
  // with Kimi signatures could reach DeepSeek and be rejected. Keep the last
  // routed provider per conversation for sanitization, escalation attribution,
  // switch metrics, and the latency switch flag.
  const lastProviders = new Map();
  const triageCache = new Map();
  const now = options.now || Date.now;
  const triage = options.semanticTriage || (args => classifySemantically({ ...args, onComplete: options.onTriage }));

  async function semanticResolve(decision, config) {
    if (!config.routing?.semanticTriage || !decision.triageCandidate) return decision;
    const minChars = config.routing.triageMinChars || 40;
    if (decision.taskText.length < minChars) return decision;
    let semanticDecision = triageCache.get(decision.taskKey);
    if (!semanticDecision) {
      try {
        semanticDecision = await triage({ text: decision.taskText, config });
        triageCache.set(decision.taskKey, semanticDecision);
        if (triageCache.size > 1000) triageCache.delete(triageCache.keys().next().value);
      } catch (error) {
        console.error(JSON.stringify({ event: 'semantic_triage_fallback', message: error.message }));
      }
    }
    if (!semanticDecision) return decision;
    const threshold = config.routing.triageConfidence ?? 0.8;
    const useKimi = semanticDecision.provider === 'kimi' && semanticDecision.confidence >= threshold;
    return {
      ...decision,
      provider: useKimi ? 'kimi' : 'deepseek',
      source: 'semantic',
      reason: `semantic ${semanticDecision.provider} (${semanticDecision.category}, confidence ${semanticDecision.confidence})`,
    };
  }

  function recoveryFor(decision, previous, body, settings) {
    return analyzeRecoveryWindow(
      Array.isArray(body.messages) ? body.messages : [],
      previous.taskIndex ?? decision.task?.index ?? 0,
      settings.windowToolCalls,
    );
  }

  /**
   * Plan a transition without changing history. Preview therefore has no state
   * side effects. `remember` commits the plan only when forwarding a main
   * request; count_tokens never advances the state machine.
   */
  function planRecovery(decision, previous, body, settings) {
    const state = {
      ...previous,
      lastUserIndex: decision.lastUserIndex,
      forceCheckpoint: false,
      at: now(),
    };
    const latency = settings.latencyCheckpoint || {};
    const latencyCooldown = previous.phase === 'kimi' ? Math.max(0, (previous.latencyCooldown || 0) - 1) : 0;
    state.latencyCooldown = latencyCooldown;
    const recovery = recoveryFor(decision, previous, body, settings);
    const toolCallsNow = decision.stats?.toolCalls || 0;
    const toolCallsSinceCheck = toolCallsNow - (previous.toolCallsAtCheck || 0);
    const newUser = previous.lastUserIndex !== decision.lastUserIndex;
    const residencyServed = previous.kimiRequests >= (previous.requiredKimiRequests ?? 0);
    // A long turn used to lock Kimi until the next user message. Tool progress
    // is one checkpoint clock; request count and elapsed time are independent
    // exits for turns whose tool calls arrive slowly.
    const midTurn = previous.phase === 'kimi' && !newUser
      && toolCallsSinceCheck >= settings.windowToolCalls
      && residencyServed;
    const nextKimiRequests = previous.kimiRequests + 1;
    const requestWindow = previous.phase === 'kimi' && !newUser && !midTurn
      && nextKimiRequests - (previous.requestsAtCheck ?? 0) >= settings.windowRequests
      && residencyServed;
    const idleWindow = previous.phase === 'kimi' && !newUser && !midTurn && !requestWindow
      && now() - (previous.checkpointAt ?? previous.at ?? 0) >= settings.windowMs
      && residencyServed;
    // Latency is an optional fourth checkpoint clock. It only applies in a
    // mechanical phase (reads and test runs) where a faster provider helps,
    // and only after the cooldown that follows a return to Kimi.
    const mechanicalCalls = (recovery.readOnlyCalls || 0) + (recovery.verificationCalls || 0);
    const mechanicalShare = recovery.toolCalls ? mechanicalCalls / recovery.toolCalls : 0;
    // Without recent tool evidence we cannot tell a mechanical phase from a
    // design-heavy one, so the latency clock stays closed.
    const mechanicalPhase = recovery.toolCalls > 0 && mechanicalShare >= (latency.minReadOnlyShare ?? 0.5);
    const latencyPressure = Boolean(latency.enabled && options.latencyTracker?.pressure?.());
    const latencyWindow = previous.phase === 'kimi' && !newUser && !midTurn && !requestWindow && !idleWindow
      && residencyServed
      && latencyPressure && mechanicalPhase
      && (previous.latencyCooldown || 0) <= 0
      && now() - (previous.checkpointAt ?? previous.at ?? 0) >= (latency.fastWindowMs ?? 0);
    const manual = previous.phase === 'kimi' && previous.forceCheckpoint === true;
    const checkpoint = newUser || midTurn || requestWindow || idleWindow || latencyWindow || manual;
    const checkpointKind = manual ? 'manual'
      : newUser ? 'user'
        : midTurn ? 'tool_window'
          : requestWindow ? 'request_window'
            : idleWindow ? 'idle_window'
              : latencyWindow ? 'latency_window' : null;
    const entry = evaluateRecovery(recovery, settings);
    // During a half-open probe, too little tool activity is not itself a
    // relapse. New failures, repeated errors and failed verification are.
    const health = evaluateRecovery(recovery, { ...settings, minRecentToolCalls: 0 });
    let transition = null;

    const confirmations = Math.max(1, settings.relapseConfirmations ?? 1);
    if (previous.phase === 'probe') {
      if (decision.hardCapability || health.serious) {
        const attempts = (previous.attempts || 0) + 1;
        Object.assign(state, kimiState(decision, previous, settings, attempts, now()));
        decision = {
          ...decision,
          provider: 'kimi',
          source: decision.hardCapability ? 'probe_blocked' : 'probe_relapsed',
          reason: decision.hardCapability
            ? 'hard capability requires Kimi'
            : `DeepSeek probe relapsed: ${health.blockers.join('; ')}`,
        };
        transition = { outcome: decision.hardCapability ? 'probe_blocked' : 'probe_relapsed', attempts, blockers: health.blockers };
      } else if (health.soft) {
        const streak = (previous.relapseStreak || 0) + 1;
        if (streak >= confirmations) {
          const attempts = (previous.attempts || 0) + 1;
          Object.assign(state, kimiState(decision, previous, settings, attempts, now()));
          decision = {
            ...decision,
            provider: 'kimi',
            source: 'probe_relapsed',
            reason: `DeepSeek probe relapsed after ${streak} reviews: ${health.blockers.join('; ')}`,
          };
          transition = { outcome: 'probe_relapsed', attempts, streak, blockers: health.blockers };
        } else {
          state.relapseStreak = streak;
          state.provider = 'deepseek';
          decision = {
            ...decision,
            provider: 'deepseek',
            source: 'probe',
            reason: `probe failure pending confirmation ${streak}/${confirmations}: ${health.blockers.join('; ')}`,
          };
          transition = { outcome: 'probe_relapse_pending', streak, confirmations, blockers: health.blockers };
        }
      } else {
        state.relapseStreak = 0;
        state.provider = 'deepseek';
        decision = {
          ...decision,
          provider: 'deepseek',
          source: 'probe',
          reason: `DeepSeek recovery probe ${state.probeSuccesses + 1}/${settings.probeRequests}`,
        };
        transition = { outcome: 'probe_continue' };
      }
    } else if (previous.recovered) {
      // The original soft capability/progress reasons are cumulative. After a
      // successful probe they must not immediately re-escalate the same task.
      // Serious evidence still relapses at once; soft evidence must persist for
      // relapseConfirmations consecutive reviews, so one trailing tool failure
      // cannot undo a clean probe.
      if (decision.hardCapability || health.serious) {
        const attempts = (previous.attempts || 0) + 1;
        Object.assign(state, kimiState(decision, previous, settings, attempts, now()));
        decision = {
          ...decision,
          provider: 'kimi',
          source: 'relapse',
          reason: decision.hardCapability ? 'hard capability requires Kimi' : `new recovery failures: ${health.blockers.join('; ')}`,
        };
        transition = { outcome: 'relapse', attempts, blockers: health.blockers };
      } else if (health.soft) {
        const streak = (previous.relapseStreak || 0) + 1;
        if (streak >= confirmations) {
          const attempts = (previous.attempts || 0) + 1;
          Object.assign(state, kimiState(decision, previous, settings, attempts, now()));
          decision = {
            ...decision,
            provider: 'kimi',
            source: 'relapse',
            reason: `confirmed recovery failures (${streak}): ${health.blockers.join('; ')}`,
          };
          transition = { outcome: 'relapse', attempts, streak, blockers: health.blockers };
        } else {
          state.relapseStreak = streak;
          state.provider = 'deepseek';
          decision = {
            ...decision,
            provider: 'deepseek',
            source: 'deescalated',
            reason: `recovery failure pending confirmation ${streak}/${confirmations}: ${health.blockers.join('; ')}`,
          };
          transition = { outcome: 'relapse_pending', streak, confirmations, blockers: health.blockers };
        }
      } else {
        state.relapseStreak = 0;
        state.provider = 'deepseek';
        decision = {
          ...decision,
          provider: 'deepseek',
          source: 'deescalated',
          reason: 'recovery probe passed and the recent window remains clean',
        };
      }
    } else {
      state.phase = 'kimi';
      state.provider = 'kimi';
      state.kimiRequests += 1;
      decision = {
        ...decision,
        provider: 'kimi',
        source: 'sticky',
        reason: 'same task remains on Kimi until a safe recovery checkpoint',
      };
      if (decision.hardCapability) {
        if (checkpoint) transition = { outcome: 'capability_blocked' };
      } else if (previous.attempts >= settings.maxAttempts
        && (!settings.retryAfterExhaustedRequests
          || previous.kimiRequests < settings.retryAfterExhaustedRequests)) {
        if (checkpoint) transition = { outcome: 'attempts_exhausted' };
      } else if (previous.kimiRequests < state.requiredKimiRequests) {
        if (checkpoint) transition = { outcome: 'backoff' };
      } else if (checkpoint && entry.clean) {
        state.kimiRequests = previous.kimiRequests;
        state.phase = 'probe';
        state.provider = 'deepseek';
        state.probeSuccesses = 0;
        // A new probe cycle starts a new confirmation series. Without this a
        // pending soft failure from the previous cycle could relapse after one
        // review of the new cycle.
        state.relapseStreak = 0;
        decision = {
          ...decision,
          provider: 'deepseek',
          source: 'deescalation_probe',
          reason: `clean recent window at ${checkpointKind === 'user' ? 'a new user' : `a ${checkpointKind}`} checkpoint`,
        };
        transition = { outcome: 'probe_started' };
      } else if (checkpoint && !entry.clean) {
        transition = { outcome: 'recovery_blocked' };
      }
    }

    // Every evaluated checkpoint resets all checkpoint baselines, so a blocked
    // window is retried on the next request/tool/time interval.
    if (checkpoint) {
      state.toolCallsAtCheck = toolCallsNow;
      state.requestsAtCheck = state.kimiRequests;
      state.checkpointAt = now();
    }
    return { decision, state, transition, checkpoint: checkpoint ? checkpointKind : null };
  }

  async function resolve(body, { semantic = true, session = null } = {}) {
    const config = getConfig();
    let decision = classifyRequest(body, { limits: config.routing?.limits, session });
    const previous = history.get(stateKeyFor(decision));
    const sameTask = Boolean(previous);
    const settings = deescalationSettings(config);
    let state = null;
    let transition = null;
    let checkpoint = null;

    if (sameTask && settings.enabled && config.providers?.deepseek?.apiKey && decision.source !== 'explicit'
      && (previous.phase === 'kimi' || previous.phase === 'probe' || previous.recovered)) {
      const plan = planRecovery(decision, previous, body, settings);
      decision = plan.decision;
      state = plan.state;
      transition = plan.transition;
      checkpoint = plan.checkpoint;
    } else {
      if (sameTask && decision.source !== 'explicit' && previous.provider === 'kimi') {
        decision = {
          ...decision,
          provider: 'kimi',
          source: 'sticky',
          reason: settings.enabled && !config.providers?.deepseek?.apiKey
            ? 'same task remains on Kimi because DeepSeek is not configured'
            : 'same task remains on Kimi; de-escalation is disabled',
        };
      } else if (semantic && decision.source !== 'explicit') {
        decision = await semanticResolve(decision, config);
      }
      if (sameTask && decision.source !== 'explicit' && decision.provider === previous.phase && !previous.recovered) {
        state = { ...previous, provider: decision.provider, lastUserIndex: decision.lastUserIndex, at: now() };
        if (decision.provider === 'kimi') state.kimiRequests += 1;
      } else {
        state = decision.provider === 'kimi'
          ? kimiState(decision, sameTask ? previous : null, settings, 0, now())
          : initialState(decision, settings, now());
      }
    }

    return {
      decision,
      previousProvider: lastProviders.get(decision.conversationKey) ?? previous?.provider,
      config,
      state,
      transition,
      checkpoint,
    };
  }

  function remember(decision, proposedState) {
    const settings = deescalationSettings(getConfig());
    history.set(stateKeyFor(decision), {
      ...(proposedState || initialState(decision, settings, now())),
      provider: decision.provider,
      conversationKey: decision.conversationKey ?? null,
      taskKey: decision.taskKey,
      lastUserIndex: decision.lastUserIndex,
      at: now(),
    });
    if (decision.conversationKey) {
      // Refresh insertion order so the cap evicts the least recently routed
      // conversation, matching the task-state cap below.
      lastProviders.delete(decision.conversationKey);
      lastProviders.set(decision.conversationKey, decision.provider);
      if (lastProviders.size > 2000) lastProviders.delete(lastProviders.keys().next().value);
    }
    if (history.size > 2000) history.delete(history.keys().next().value);
  }

  /** Commit request outcomes after upstream I/O, including failed probe requests. */
  function observe(decision, record) {
    // Latency samples are global provider measurements, so record them even
    // when this request is not part of a probe.
    options.latencyTracker?.observe?.(record);
    const previous = history.get(stateKeyFor(decision));
    if (!previous || previous.phase !== 'probe') return null;
    if (decision.source === 'explicit' || decision.provider !== 'deepseek') return null;
    const settings = deescalationSettings(getConfig());
    const state = { ...previous, at: now() };
    let transition = null;

    if (record.outcome !== 'success' && record.outcome !== 'client_aborted') {
      const failureClass = probeFailureClass(record);
      state.phase = 'kimi';
      state.kimiRequests = 0;
      state.probeSuccesses = 0;
      state.recovered = false;
      // The failed probe ends the current confirmation series; the next probe
      // must collect its own evidence. Without this, a pending soft failure
      // survives a 5xx/400 probe failure and can relapse the next cycle early.
      state.relapseStreak = 0;
      state.requestsAtCheck = 0;
      state.checkpointAt = now();
      state.forceCheckpoint = false;
      state.latencyCooldown = settings.latencyCheckpoint?.cooldownRequests ?? 0;
      state.lastProbeFailure = {
        at: record.at || new Date(now()).toISOString(),
        class: failureClass,
        outcome: record.outcome ?? null,
        httpStatus: record.httpStatus ?? null,
        errorKind: record.errorKind ?? null,
      };
      if (failureClass === 'unavailable') {
        // A transient outage is not evidence that DeepSeek cannot do the task.
        // Do not consume the quality attempt budget; after three consecutive
        // availability failures apply a separate bound so we still stop paying
        // for a doomed probe on every residency cycle.
        state.availabilityFailures = (previous.availabilityFailures || 0) + 1;
        state.requiredKimiRequests = state.availabilityFailures >= 3
          ? backoffRequests(settings, state.availabilityFailures - 2)
          : settings.minKimiRequests;
        transition = {
          outcome: 'probe_unavailable',
          failureClass,
          attempts: state.attempts,
          availabilityFailures: state.availabilityFailures,
          requiredKimiRequests: state.requiredKimiRequests,
          httpStatus: record.httpStatus ?? null,
          errorKind: record.errorKind ?? null,
        };
      } else {
        // invalid_request (typically our own 400) is not availability either.
        // It consumes a bounded retry attempt so a persistent configuration
        // bug stops probing instead of retrying forever.
        state.availabilityFailures = 0;
        state.attempts = (previous.attempts || 0) + 1;
        state.requiredKimiRequests = backoffRequests(settings, state.attempts);
        transition = {
          outcome: 'probe_invalid_request',
          failureClass,
          attempts: state.attempts,
          requiredKimiRequests: state.requiredKimiRequests,
          httpStatus: record.httpStatus ?? null,
          errorKind: record.errorKind ?? null,
        };
      }
    } else if (record.outcome === 'success') {
      state.probeSuccesses += 1;
      state.availabilityFailures = 0;
      state.lastProbeFailure = null;
      if (state.probeSuccesses >= settings.probeRequests) {
        state.phase = 'deepseek';
        state.kimiRequests = 0;
        state.requiredKimiRequests = 0;
        state.attempts = 0;
        state.recovered = true;
        state.relapseStreak = 0;
        state.latencyCooldown = 0;
        state.requestsAtCheck = 0;
        state.checkpointAt = now();
        state.forceCheckpoint = false;
        transition = { outcome: 'probe_succeeded' };
      }
    }
    if (transition?.failureClass) {
      record.probeFailureClass = transition.failureClass;
      record.probeOutcome = transition.outcome;
    }

    // provider remains the actual upstream used by this request. phase records
    // what the next non-explicit request should do after a failed probe.
    history.set(stateKeyFor(decision), state);
    return transition;
  }

  /** Non-sensitive in-memory routing state; task text and message bodies are absent. */
  function routingState() {
    return [...history.entries()].map(([stateKey, state]) => ({
      conversationKey: conversationKeyOf(stateKey, state),
      taskKey: state.taskKey,
      taskIndex: state.taskIndex,
      provider: state.provider,
      phase: state.phase,
      kimiRequests: state.kimiRequests,
      requiredKimiRequests: state.requiredKimiRequests,
      attempts: state.attempts,
      probeSuccesses: state.probeSuccesses,
      recovered: state.recovered,
      relapseStreak: state.relapseStreak || 0,
      latencyCooldown: state.latencyCooldown || 0,
      availabilityFailures: state.availabilityFailures || 0,
      lastProbeFailure: state.lastProbeFailure || null,
      toolCallsAtCheck: state.toolCallsAtCheck,
      requestsAtCheck: state.requestsAtCheck,
      checkpointAt: state.checkpointAt ? new Date(state.checkpointAt).toISOString() : null,
      forced: state.forceCheckpoint === true,
      at: state.at ? new Date(state.at).toISOString() : null,
    }));
  }

  /**
   * Schedule an operator-requested recovery checkpoint. The next main request
   * still has to pass the ordinary clean-window and hard-capability gates.
   */
  function requestDeescalation({ conversationKey, all = false } = {}) {
    const settings = deescalationSettings(getConfig());
    const changed = [];
    for (const [key, previous] of history) {
      const keyConversation = conversationKeyOf(key, previous);
      if (!all && keyConversation !== conversationKey) continue;
      if (previous.provider !== 'kimi' && previous.phase !== 'probe') continue;
      history.set(key, {
        ...previous,
        phase: 'kimi',
        provider: 'kimi',
        kimiRequests: Math.max(previous.kimiRequests || 0, settings.minKimiRequests),
        requiredKimiRequests: 0,
        attempts: 0,
        probeSuccesses: 0,
        recovered: false,
        relapseStreak: 0,
        latencyCooldown: 0,
        forceCheckpoint: true,
        checkpointAt: 0,
        at: now(),
      });
      if (!changed.includes(keyConversation)) changed.push(keyConversation);
    }
    return changed;
  }

  return { resolve, remember, observe, routingState, requestDeescalation };
}
