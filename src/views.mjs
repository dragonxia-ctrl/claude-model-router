export function health(config) {
  return {
    ok: true,
    version: 2,
    revision: config.revision || 1,
    strategy: 'DeepSeek default; evidence, progress, and optional semantic escalation to Kimi',
    progressAware: true,
    semanticTriage: Boolean(config.routing?.semanticTriage),
    providers: Object.fromEntries(Object.entries(config.providers).map(([name, p]) => [name, {
      model: p.model, configured: Boolean(p.apiKey),
    }])),
  };
}

export function models(config) {
  const data = [
    { id: 'auto', display_name: 'Auto: DeepSeek / Kimi' },
    { id: config.providers.deepseek.model, display_name: 'DeepSeek V4.1 Flash' },
    { id: config.providers.kimi.model, display_name: 'Kimi K3.1 Pro' },
  ].map(model => ({ ...model, type: 'model', created_at: '2026-11-24T00:00:00Z' }));
  return { data, has_more: false, first_id: data[0].id, last_id: data.at(-1).id };
}
