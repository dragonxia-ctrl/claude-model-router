import { classifyRequest } from './classifier.mjs';
import { classifySemantically } from './semantic.mjs';
import { analyzeRecoveryWindow } from './progress.mjs';
import { backoffRequests, deescalationSettings, evaluateRecovery } from './deescalation.mjs';

function initialState(decision, settings) {
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
    at: Date.now(),
  };
}

function kimiState(decision, previous, settings, attempts = 0) {
  return {
    ...initialState({ ...decision, provider: 'kimi' }, settings),
    attempts,
    requiredKimiRequests: attempts ? backoffRequests(settings, attempts) : settings.minKimiRequests,
    lastUserIndex: decision.lastUserIndex,
    taskIndex: previous?.taskIndex ?? decision.task?.index ?? decision.lastUserIndex,
  };
}

export function createDecisionEngine(getConfig, options = {}) {
  const history = new Map();
  const triageCache = new Map();
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
      at: Date.now(),
    };
    const recovery = recoveryFor(decision, previous, body, settings);
    const checkpoint = previous.lastUserIndex !== decision.lastUserIndex;
    const entry = evaluateRecovery(recovery, settings);
    // During a half-open probe, too little tool activity is not itself a
    // relapse. New failures, repeated errors and failed verification are.
    const health = evaluateRecovery(recovery, { ...settings, minRecentToolCalls: 0 });
    let transition = null;

    if (previous.phase === 'probe') {
      if (decision.hardCapability || !health.clean) {
        const attempts = previous.attempts + 1;
        Object.assign(state, kimiState(decision, previous, settings, attempts));
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
        Object.assign(state, kimiState(decision, previous, settings));
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
      } else if (previous.attempts >= settings.maxAttempts) {
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
          reason: 'clean recent window at a new user checkpoint',
        };
        transition = { outcome: 'probe_started' };
      } else if (checkpoint && !entry.clean) {
        transition = { outcome: 'recovery_blocked' };
      }
    }

    return { decision, state, transition };
  }

  async function resolve(body, { semantic = true } = {}) {
    const config = getConfig();
    let decision = classifyRequest(body, { limits: config.routing?.limits });
    const previous = history.get(decision.conversationKey);
    const sameTask = previous?.taskKey === decision.taskKey;
    const settings = deescalationSettings(config);
    let state = null;
    let transition = null;

    if (sameTask && settings.enabled && config.providers?.deepseek?.apiKey && decision.source !== 'explicit'
      && (previous.phase === 'kimi' || previous.phase === 'probe' || previous.recovered)) {
      const plan = planRecovery(decision, previous, body, settings);
      decision = plan.decision;
      state = plan.state;
      transition = plan.transition;
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
        state = { ...previous, provider: decision.provider, lastUserIndex: decision.lastUserIndex, at: Date.now() };
        if (decision.provider === 'kimi') state.kimiRequests += 1;
      } else {
        state = decision.provider === 'kimi'
          ? kimiState(decision, sameTask ? previous : null, settings)
          : initialState(decision, settings);
      }
    }

    return { decision, previousProvider: previous?.provider, config, state, transition };
  }

  function remember(decision, proposedState) {
    const settings = deescalationSettings(getConfig());
    history.set(decision.conversationKey, {
      ...(proposedState || initialState(decision, settings)),
      provider: decision.provider,
      taskKey: decision.taskKey,
      lastUserIndex: decision.lastUserIndex,
      at: Date.now(),
    });
    if (history.size > 2000) history.delete(history.keys().next().value);
  }

  /** Commit request outcomes after upstream I/O, including failed probe requests. */
  function observe(decision, record) {
    const previous = history.get(decision.conversationKey);
    if (!previous || previous.taskKey !== decision.taskKey || previous.phase !== 'probe') return null;
    if (decision.source === 'explicit' || decision.provider !== 'deepseek') return null;
    const settings = deescalationSettings(getConfig());
    const state = { ...previous, at: Date.now() };
    let transition = null;

    if (record.outcome !== 'success' && record.outcome !== 'client_aborted') {
      state.phase = 'kimi';
      state.kimiRequests = 0;
      state.attempts += 1;
      state.requiredKimiRequests = backoffRequests(settings, state.attempts);
      state.probeSuccesses = 0;
      state.recovered = false;
      transition = { outcome: 'probe_failed' };
    } else if (record.outcome === 'success') {
      state.probeSuccesses += 1;
      if (state.probeSuccesses >= settings.probeRequests) {
        state.phase = 'deepseek';
        state.kimiRequests = 0;
        state.requiredKimiRequests = 0;
        state.attempts = 0;
        state.recovered = true;
        transition = { outcome: 'probe_succeeded' };
      }
    }

    // provider remains the actual upstream used by this request. phase records
    // what the next non-explicit request should do after a failed probe.
    history.set(decision.conversationKey, state);
    return transition;
  }

  return { resolve, remember, observe };
}
