const STARTED_AT = Date.now();

export const ROUTER_VERSION = '1.1.0';

export function liveHealth() {
  return {
    ok: true,
    status: 'live',
    version: ROUTER_VERSION,
    uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
  };
}

export function readinessHealth(config) {
  const providers = Object.fromEntries(Object.entries(config.providers || {}).map(([name, provider]) => [
    name,
    { model: provider.model, configured: Boolean(provider.apiKey) },
  ]));
  const configured = Object.entries(providers).filter(([, provider]) => provider.configured).map(([name]) => name);
  const missing = Object.entries(providers).filter(([, provider]) => !provider.configured).map(([name]) => name);
  const ready = configured.length > 0;
  return {
    ok: ready,
    status: ready ? (missing.length ? 'degraded' : 'ready') : 'not_ready',
    version: ROUTER_VERSION,
    configuredProviders: configured,
    missingProviders: missing,
    checks: {
      configLoaded: true,
      localTokenConfigured: Boolean(config.router?.token),
      atLeastOneProviderConfigured: configured.length > 0,
      semanticTriage: Boolean(config.routing?.semanticTriage),
    },
  };
}

export function deepHealth(config, telemetry) {
  const readiness = readinessHealth(config);
  const telemetrySnapshot = telemetry?.snapshot ? telemetry.snapshot() : null;
  return {
    ...readiness,
    status: readiness.ok ? 'deep_ok' : 'not_ready',
    checks: {
      ...readiness.checks,
      telemetryEnabled: Boolean(telemetrySnapshot?.enabled),
      telemetryBufferHealthy: (telemetrySnapshot?.persistence?.dropped || 0) === 0,
    },
    providers: Object.fromEntries(Object.entries(config.providers || {}).map(([name, provider]) => [
      name,
      {
        model: provider.model,
        configured: Boolean(provider.apiKey),
        lastSuccess: telemetrySnapshot?.lastUpstreamSuccess?.provider === name
          ? telemetrySnapshot.lastUpstreamSuccess
          : null,
        lastError: telemetrySnapshot?.lastUpstreamError?.provider === name
          ? telemetrySnapshot.lastUpstreamError
          : null,
      },
    ])),
    routing: {
      semanticTriage: Boolean(config.routing?.semanticTriage),
      revision: config.revision || 1,
    },
    telemetry: telemetrySnapshot,
    activeChecks: 'none; this endpoint never spends provider tokens',
  };
}
