import fs from 'node:fs';
import { configPathFor, defaultDataDir } from './paths.mjs';

export function clientConfig() {
  const path = process.env.CLAUDE_ROUTER_CONFIG || configPathFor(defaultDataDir());
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

export function routerBase(config = clientConfig()) {
  return `http://127.0.0.1:${config.router.port}`;
}

async function post(pathname, body, { config = clientConfig(), stream = false, query = '' } = {}) {
  const response = await fetch(`${routerBase(config)}${pathname}${query}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.router.token}`,
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ ...body, stream }),
    signal: AbortSignal.timeout(180000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 800)}`);
  const router = {
    provider: response.headers.get('x-router-provider'),
    source: response.headers.get('x-router-source'),
  };
  if (!stream) return { ...JSON.parse(raw), router };
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* keep-alive */ }
  }
  if (!events.some(event => event.type === 'message_start')) throw new Error('SSE missing message_start');
  if (!events.some(event => event.type === 'message_stop')) throw new Error('SSE missing message_stop');
  return { streamEvents: events.length, router };
}

export function call(body, options = {}) {
  const config = options.config || clientConfig();
  return post('/v1/messages', {
    max_tokens: 192,
    output_config: { effort: 'low' },
    ...body,
  }, { ...options, config });
}

export function preview(body, options = {}) {
  const config = options.config || clientConfig();
  return post('/v1/router/preview', body, { ...options, config });
}

export function assertModel(message, expected) {
  if (message.model !== expected) throw new Error(`Expected ${expected}, received ${message.model}`);
}

export function textOf(message) {
  return (message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
}
