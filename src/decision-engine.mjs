import { classifyRequest } from './classifier.mjs';
import { classifySemantically } from './semantic.mjs';

export function createDecisionEngine(getConfig, options = {}) {
  const history = new Map();
  const triageCache = new Map();
  const triage = options.semanticTriage || classifySemantically;

  async function resolve(body, { semantic = true } = {}) {
    const config = getConfig();
    let decision = classifyRequest(body, { limits: config.routing?.limits });
    const previous = history.get(decision.conversationKey);
    const sameTask = previous?.taskKey === decision.taskKey;

    if (sameTask && previous.provider === 'kimi' && decision.source !== 'explicit') {
      decision = { ...decision, provider: 'kimi', source: 'sticky', reason: 'same task remains on Kimi' };
    } else if (semantic && config.routing?.semanticTriage && decision.triageCandidate) {
      const minChars = config.routing.triageMinChars || 40;
      if (decision.taskText.length >= minChars) {
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
        if (semanticDecision) {
          const threshold = config.routing.triageConfidence ?? 0.8;
          const useKimi = semanticDecision.provider === 'kimi' && semanticDecision.confidence >= threshold;
          decision = {
            ...decision,
            provider: useKimi ? 'kimi' : 'deepseek',
            source: 'semantic',
            reason: `semantic ${semanticDecision.provider} (${semanticDecision.category}, confidence ${semanticDecision.confidence})`,
          };
        }
      }
    }
    return { decision, previousProvider: previous?.provider, config };
  }

  function remember(decision) {
    history.set(decision.conversationKey, {
      provider: decision.provider, taskKey: decision.taskKey, at: Date.now(),
    });
    if (history.size > 2000) history.delete(history.keys().next().value);
  }

  return { resolve, remember };
}
