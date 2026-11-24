import fs from 'node:fs';

export const ROUTING_DEFAULTS = Object.freeze({
  semanticTriage: true,
  triageMinChars: 40,
  triageConfidence: 0.8,
  triageTimeoutMs: 8000,
  triageMaxInputChars: 6000,
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function normalizeConfig(raw) {
  assert(raw && typeof raw === 'object' && !Array.isArray(raw), 'Config must be a JSON object');
  assert(raw.router && typeof raw.router === 'object', 'Missing router configuration');
  const router = raw.router;
  router.host = router.host || '127.0.0.1';
  assert(typeof router.host === 'string' && router.host.length > 0, 'router.host must be a string');
  assert(Number.isInteger(router.port) && router.port > 0 && router.port <= 65535, 'router.port must be an integer from 1 to 65535');
  assert(/^[a-f0-9]{32,}$/i.test(router.token || ''), 'router.token is missing or too short');

  for (const name of ['kimi', 'deepseek']) {
    const provider = raw.providers?.[name];
    assert(provider && typeof provider === 'object', `Missing provider: ${name}`);
    for (const key of ['baseUrl', 'model', 'apiKey']) {
      assert(typeof provider[key] === 'string', `providers.${name}.${key} must be a string`);
    }
    assert(provider.model.trim().length > 0, `providers.${name}.model must not be empty`);
    let url;
    try { url = new URL(provider.baseUrl); } catch { throw new Error(`providers.${name}.baseUrl must be a valid URL`); }
    assert(['http:', 'https:'].includes(url.protocol), `providers.${name}.baseUrl must use http or https`);
  }

  if (raw.routing !== undefined) {
    assert(raw.routing && typeof raw.routing === 'object' && !Array.isArray(raw.routing), 'routing must be an object');
    const routing = raw.routing;
    if (routing.semanticTriage !== undefined) assert(typeof routing.semanticTriage === 'boolean', 'routing.semanticTriage must be a boolean');
    if (routing.triageMinChars !== undefined) assert(Number.isInteger(routing.triageMinChars) && routing.triageMinChars >= 0, 'routing.triageMinChars must be a non-negative integer');
    if (routing.triageConfidence !== undefined) assert(typeof routing.triageConfidence === 'number' && routing.triageConfidence >= 0 && routing.triageConfidence <= 1, 'routing.triageConfidence must be between 0 and 1');
    if (routing.triageTimeoutMs !== undefined) assert(Number.isInteger(routing.triageTimeoutMs) && routing.triageTimeoutMs >= 250, 'routing.triageTimeoutMs must be at least 250');
    if (routing.triageMaxInputChars !== undefined) assert(Number.isInteger(routing.triageMaxInputChars) && routing.triageMaxInputChars >= 500, 'routing.triageMaxInputChars must be at least 500');
  }
  return raw;
}

export function loadConfig(path) {
  return normalizeConfig(JSON.parse(fs.readFileSync(path, 'utf8')));
}

export function createConfigStore(path) {
  let config = loadConfig(path);
  let revision = 1;
  return {
    get: () => config,
    get revision() { return revision; },
    reload() {
      try {
        const next = loadConfig(path);
        const restartRequired = next.router.host !== config.router.host || next.router.port !== config.router.port;
        config = { ...next, revision: revision + 1 };
        revision += 1;
        return { ok: true, revision, restartRequired };
      } catch (error) {
        return { ok: false, revision, error: error.message };
      }
    },
  };
}
