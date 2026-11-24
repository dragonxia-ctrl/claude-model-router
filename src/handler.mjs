import { randomUUID } from 'node:crypto';
import { sanitizeForProvider } from './sanitize.mjs';
import { forward } from './upstream.mjs';
import { authorized, json, error, readJson } from './http-utils.mjs';
import { health, models } from './views.mjs';
import { createDecisionEngine } from './decision-engine.mjs';

export function createHandler(configSource, options = {}) {
  const getConfig = typeof configSource === 'function' ? configSource : () => configSource;
  const engine = createDecisionEngine(getConfig, options);
  return async (req, res) => {
    const requestId = randomUUID();
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && pathname === '/health') { json(res, 200, health(getConfig())); return; }
      if (!authorized(req, getConfig().router.token)) {
        error(res, 401, 'authentication_error', 'Invalid local token'); return;
      }
      if (req.method === 'GET' && pathname === '/v1/models') { json(res, 200, models(getConfig())); return; }
      if (req.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens', '/v1/router/preview'].includes(pathname)) {
        error(res, 404, 'not_found_error', 'Unsupported endpoint'); return;
      }
      let body = await readJson(req);
      const isPreview = pathname === '/v1/router/preview';
      const { decision, previousProvider, config } = await engine.resolve(body, {
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
        engine.remember(decision);
      }
      body.model = provider.model;
      res.setHeader('x-router-provider', provider.name);
      res.setHeader('x-router-source', decision.source);
      console.log(JSON.stringify({
        time: new Date().toISOString(), requestId, provider: provider.name,
        model: provider.model, reason: decision.reason, source: decision.source,
        stream: Boolean(body.stream), stats: decision.stats || null,
      }));
      await forward({ req, res, body, provider, requestId });
    } catch (err) {
      if (!res.headersSent) error(res, 400, 'invalid_request_error', err.message);
      else res.destroy(err);
    }
  };
}
