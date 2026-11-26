import { randomUUID } from 'node:crypto';
import { sanitizeForProvider } from './sanitize.mjs';
import { forward } from './upstream.mjs';
import { authorized, json, error, readJson } from './http-utils.mjs';
import { health, models } from './views.mjs';
import { liveHealth, readinessHealth, deepHealth } from './health.mjs';
import { ROUTER_VERSION } from './version.mjs';
import { createDecisionEngine } from './decision-engine.mjs';
import { createTelemetry } from './telemetry.mjs';

export function createHandler(configSource, options = {}) {
  const getConfig = typeof configSource === 'function' ? configSource : () => configSource;
  const updateChecker = options.updateChecker || null;
  const telemetry = options.telemetry && typeof options.telemetry.recordRequest === 'function'
    ? options.telemetry
    : options.telemetry === false ? null : createTelemetry({
      ...(getConfig().telemetry || {}),
      ...(options.telemetryOptions || {}),
    });
  const engine = createDecisionEngine(getConfig, {
    ...options,
    onTriage(record) {
      telemetry?.recordRequest?.({
        at: new Date().toISOString(),
        requestId: randomUUID(),
        provider: record.provider,
        model: record.model,
        purpose: 'semantic_triage',
        outcome: record.outcome,
        durationMs: record.durationMs,
        usage: record.usage,
        errorKind: record.errorKind,
      });
      options.onTriage?.(record);
    },
  });
  const handler = async (req, res) => {
    const requestId = randomUUID();
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      if (req.method === 'GET' && pathname === '/health') { json(res, 200, health(getConfig())); return; }
      if (req.method === 'GET' && pathname === '/health/live') { json(res, 200, liveHealth()); return; }
      if (req.method === 'GET' && pathname === '/version') {
        if (updateChecker) {
          void updateChecker.refresh().catch(() => {});
          json(res, 200, updateChecker.info());
        } else {
          json(res, 200, {
            current: ROUTER_VERSION,
            latest: null,
            status: 'unknown',
            updateAvailable: false,
            checkedAt: null,
            repository: 'dragonxia-ctrl/claude-model-router',
          });
        }
        return;
      }
      if (req.method === 'GET' && pathname === '/health/ready') {
        const report = readinessHealth(getConfig());
        json(res, report.ok ? 200 : 503, report);
        return;
      }
      if (req.method === 'GET' && pathname === '/health/deep') {
        if (!authorized(req, getConfig().router.token)) { error(res, 401, 'authentication_error', 'Invalid local token'); return; }
        json(res, 200, deepHealth(getConfig(), telemetry));
        return;
      }
      if (req.method === 'GET' && (pathname === '/metrics' || pathname === '/metrics/json')) {
        if (!authorized(req, getConfig().router.token)) { error(res, 401, 'authentication_error', 'Invalid local token'); return; }
        if (!telemetry) { error(res, 503, 'telemetry_disabled', 'Telemetry is disabled'); return; }
        if (pathname === '/metrics/json') json(res, 200, telemetry.snapshot());
        else {
          res.statusCode = 200;
          res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
          res.end(telemetry.renderPrometheus());
        }
        return;
      }
      if (!authorized(req, getConfig().router.token)) {
        error(res, 401, 'authentication_error', 'Invalid local token'); return;
      }
      if (req.method === 'GET' && pathname === '/v1/models') { json(res, 200, models(getConfig())); return; }
      if (req.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens', '/v1/router/preview'].includes(pathname)) {
        error(res, 404, 'not_found_error', 'Unsupported endpoint'); return;
      }
      let body = await readJson(req);
      const isPreview = pathname === '/v1/router/preview';
      const { decision, previousProvider, config, state, transition } = await engine.resolve(body, {
        semantic: pathname === '/v1/messages' || isPreview,
      });
      const provider = { ...config.providers[decision.provider], name: decision.provider };
      if (isPreview) {
        json(res, 200, {
          provider: decision.provider, model: provider.model,
          reason: decision.reason, source: decision.source, stats: decision.stats || null,
        });
        return;
      }
      if (!provider.apiKey) {
        error(res, 503, 'configuration_error', `${provider.name} key missing; run claude-router configure`); return;
      }
      if (pathname === '/v1/messages') {
        body = sanitizeForProvider(body, previousProvider, decision.provider);
        engine.remember(decision, state);
      }
      body.model = provider.model;
      const route = {
        selectedProvider: provider.name,
        source: decision.source,
        previousProvider: previousProvider || null,
        escalated: Boolean(previousProvider && previousProvider !== provider.name && provider.name === 'kimi'),
        deescalationOutcome: pathname === '/v1/messages' ? transition?.outcome || null : null,
      };
      res.setHeader('x-router-provider', provider.name);
      res.setHeader('x-router-source', decision.source);
      console.log(JSON.stringify({
        event: 'route_decision',
        time: new Date().toISOString(), requestId, provider: provider.name,
        model: provider.model, reason: decision.reason, source: decision.source,
        stream: Boolean(body.stream), stats: decision.stats || null,
        conversationKey: decision.conversationKey, taskKey: decision.taskKey,
        capabilityKinds: decision.capabilityKinds || null,
        hardCapability: decision.hardCapability ?? null,
        media: decision.media || null,
        deescalationOutcome: transition?.outcome || null,
      }));
      await forward({
        req, res, body, provider, requestId, telemetry, route,
        conversationKey: decision.conversationKey,
        taskKey: decision.taskKey,
        purpose: pathname === '/v1/messages/count_tokens' ? 'count_tokens' : 'main',
        onOutcome: pathname === '/v1/messages' ? record => engine.observe(decision, record) : null,
      });
    } catch (err) {
      if (!res.headersSent) error(res, 400, 'invalid_request_error', err.message);
      else res.destroy(err);
    }
  };
  handler.telemetry = telemetry;
  return handler;
}
