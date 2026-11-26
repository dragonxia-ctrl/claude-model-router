import { classifyRequest } from './classifier.mjs';
import { classifySemantically } from './semantic.mjs';
import { analyzeRecoveryWindow } from './progress.mjs';
import { backoffRequests, deescalationSettings, evaluateRecovery } from './deescalation.mjs';

function initialState(decision, settings, at = Date.now()) {
  const kimi = decision.provider === 'kimi';
  return {
    provider: decision.provider,
    taskKey: decision.taskKey,
    taskIndex: decision.task?.index ?? decision.lastUserIndex,
    lastUserIndex: decision.lastUserIndex,
    phase: kimi ? 'kimi' : 'deepseek',
    kimiRequests: kimi ? 1 : 0,
    requiredKimiRequests: kimi ? settings.minKimiRequests : 0,
    attempts: 0,
    probeSuccesses: 0,
    recovered: false,
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
    lastUserIndex: decision.lastUserIndex,
    taskIndex: previous?.taskIndex ?? decision.task?.index ?? decision.lastUserIndex,
  };
}

export function createDecisionEngine(getConfig, options = {}) {
  const history = new Map();
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
    const manual = previous.phase === 'kimi' && previous.forceCheckpoint === true;
    const checkpoint = newUser || midTurn || requestWindow || idleWindow || manual;
    const checkpointKind = manual ? 'manual'
      : newUser ? 'user'
        : midTurn ? 'tool_window'
          : requestWindow ? 'request_window'
            : idleWindow ? 'idle_window' : null;
    const entry = evaluateRecovery(recovery, settings);
    // During a half-open probe, too little tool activity is not itself a
    // relapse. New failures, repeated errors and failed verification are.
    const health = evaluateRecovery(recovery, { ...settings, minRecentToolCalls: 0 });
    let transition = null;

    if (previous.phase === 'probe') {
      if (decision.hardCapability || !health.clean) {
        const attempts = previous.attempts + 1;
        Object.assign(state, kimiState(decision, previous, settings, attempts, now()));
        decision = {
          ...decision,
          provider: 'kimi',
          source: decision.hardCapability ? 'probe_blocked' : 'probe_relapsed',
          reason: decision.hardCapability
            ? 'hard capability requires Kimi'
            : `DeepSeek probe relapsed: ${health.blockers.join('; ')}`,
        };
        transition = { outcome: decision.hardCapability ? 'probe_blocked' : 'probe_relapsed' };
      } else {
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
      if (decision.hardCapability || !health.clean) {
        Object.assign(state, kimiState(decision, previous, settings, 0, now()));
        decision = {
          ...decision,
          provider: 'kimi',
          source: 'relapse',
          reason: decision.hardCapability ? 'hard capability requires Kimi' : `new recovery failures: ${health.blockers.join('; ')}`,
        };
        transition = { outcome: 'relapse' };
      } else {
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
    const previous = history.get(decision.conversationKey);
    const sameTask = previous?.taskKey === decision.taskKey;
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

    return { decision, previousProvider: previous?.provider, config, state, transition, checkpoint };
  }

  function remember(decision, proposedState) {
    const settings = deescalationSettings(getConfig());
    history.set(decision.conversationKey, {
      ...(proposedState || initialState(decision, settings, now())),
      provider: decision.provider,
      taskKey: decision.taskKey,
      lastUserIndex: decision.lastUserIndex,
      at: now(),
    });
    if (history.size > 2000) history.delete(history.keys().next().value);
  }

  /** Commit request outcomes after upstream I/O, including failed probe requests. */
  function observe(decision, record) {
    const previous = history.get(decision.conversationKey);
    if (!previous || previous.taskKey !== decision.taskKey || previous.phase !== 'probe') return null;
    if (decision.source === 'explicit' || decision.provider !== 'deepseek') return null;
    const settings = deescalationSettings(getConfig());
    const state = { ...previous, at: now() };
    let transition = null;

    if (record.outcome !== 'success' && record.outcome !== 'client_aborted') {
      state.phase = 'kimi';
      state.kimiRequests = 0;
      state.attempts += 1;
      state.requiredKimiRequests = backoffRequests(settings, state.attempts);
      state.probeSuccesses = 0;
      state.recovered = false;
      state.requestsAtCheck = 0;
      state.checkpointAt = now();
      state.forceCheckpoint = false;
      transition = { outcome: 'probe_failed', attempts: state.attempts, requiredKimiRequests: state.requiredKimiRequests };
    } else if (record.outcome === 'success') {
      state.probeSuccesses += 1;
      if (state.probeSuccesses >= settings.probeRequests) {
        state.phase = 'deepseek';
        state.kimiRequests = 0;
        state.requiredKimiRequests = 0;
        state.attempts = 0;
        state.recovered = true;
        state.requestsAtCheck = 0;
        state.checkpointAt = now();
        state.forceCheckpoint = false;
        transition = { outcome: 'probe_succeeded' };
      }
    }

    // provider remains the actual upstream used by this request. phase records
    // what the next non-explicit request should do after a failed probe.
    history.set(decision.conversationKey, state);
    return transition;
  }

  /** Non-sensitive in-memory routing state; task text and message bodies are absent. */
  function routingState() {
    return [...history.entries()].map(([conversationKey, state]) => ({
      conversationKey,
      taskKey: state.taskKey,
      provider: state.provider,
      phase: state.phase,
      kimiRequests: state.kimiRequests,
      requiredKimiRequests: state.requiredKimiRequests,
      attempts: state.attempts,
      probeSuccesses: state.probeSuccesses,
      recovered: state.recovered,
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
      if (!all && key !== conversationKey) continue;
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
        forceCheckpoint: true,
        checkpointAt: 0,
        at: now(),
      });
      changed.push(key);
    }
    return changed;
  }

  return { resolve, remember, observe, routingState, requestDeescalation };
}
