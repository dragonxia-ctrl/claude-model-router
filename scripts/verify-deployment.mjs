import { call, clientConfig, routerBase, textOf } from './lib/live-client.mjs';

const config = clientConfig();
const base = routerBase(config);

const healthResponse = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
if (!healthResponse.ok) throw new Error(`Health check failed: HTTP ${healthResponse.status}`);
const health = await healthResponse.json();
if (!health.ok || health.version !== 2) throw new Error(`Unexpected health payload: ${JSON.stringify(health)}`);
console.log(`PASS health — revision ${health.revision}, semanticTriage=${health.semanticTriage}`);
for (const name of ['kimi', 'deepseek']) {
  if (!health.providers?.[name]?.configured) throw new Error(`Provider ${name} has no API key`);
}
console.log('PASS providers — Kimi and DeepSeek configured');

const message = await call({
  model: 'auto',
  messages: [{ role: 'user', content: 'Reply with exactly ROUTER_VERIFY_OK.' }],
});
if (message.router?.provider !== 'deepseek') throw new Error(`Expected DeepSeek routing, got ${JSON.stringify(message.router)}`);
if (message.model !== config.providers.deepseek.model) throw new Error(`Expected ${config.providers.deepseek.model}, got ${message.model}`);
console.log(`PASS real request — ${message.model} via ${message.router.source}, text=${JSON.stringify(textOf(message).slice(0, 80))}`);

console.log(JSON.stringify({ ok: true, verified: 3 }));
