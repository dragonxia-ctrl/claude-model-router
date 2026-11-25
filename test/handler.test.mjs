import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHandler } from '../src/handler.mjs';
import { ROUTER_VERSION } from '../src/version.mjs';

const listen = server => new Promise(resolve => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = server => new Promise(resolve => {
  server.closeAllConnections();
  server.close(resolve);
});

async function mockProvider(name, calls) {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({ name, body, authorization: req.headers.authorization });
    res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
    res.end(body.stream
      ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      : JSON.stringify({ id: 'msg_test', model: body.model, provider: name }));
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}` };
}

test('handler routes, authenticates, rewrites model and preserves SSE', async t => {
  const calls = [];
  const deepseek = await mockProvider('deepseek', calls);
  const kimi = await mockProvider('kimi', calls);
  const config = {
    router: { token: 'local-test-token' },
    providers: {
      deepseek: { baseUrl: deepseek.url, model: 'deepseek-flash', apiKey: 'ds-secret' },
      kimi: { baseUrl: kimi.url, model: 'kimi-k3.1-pro', apiKey: 'kimi-secret' },
    },
  };
  const router = http.createServer(createHandler(config));
  const port = await listen(router);
  t.after(async () => { await close(router); await close(deepseek.server); await close(kimi.server); });
  const post = (text, token = 'local-test-token', stream = false, query = '') => fetch(`http://127.0.0.1:${port}/v1/messages${query}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', stream, messages: [{ role: 'user', content: text }] }),
  });

  let response = await post('重构整个模块');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).provider, 'deepseek');
  assert.equal(calls[0].body.model, 'deepseek-flash');
  assert.equal(calls[0].authorization, 'Bearer ds-secret');

  response = await post('你好', 'local-test-token', false, '?beta=true');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).provider, 'deepseek');

  response = await post('自主完成一个端到端完整项目');
  assert.equal((await response.json()).provider, 'kimi');
  assert.equal(calls.at(-1).body.model, 'kimi-k3.1-pro');

  response = await post('你好', 'local-test-token', true);
  assert.match(await response.text(), /event: message_stop/);

  response = await post('你好', 'wrong-token');
  assert.equal(response.status, 401);
  assert.equal(calls.length, 4);

  response = await fetch(`http://127.0.0.1:${port}/v1/models?beta=true`, {
    headers: { authorization: 'Bearer local-test-token' },
  });
  assert.equal((await response.json()).data[0].id, 'auto');

  response = await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens?beta=true`, {
    method: 'POST',
    headers: { authorization: 'Bearer local-test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: '你好' }] }),
  });
  assert.equal(response.status, 200);
  assert.equal(calls.at(-1).body.model, 'deepseek-flash');
});

test('upstream probe failure is committed and exported as a de-escalation metric', async t => {
  const calls = [];
  const deepseek = await mockProvider('deepseek', calls);
  const kimi = await mockProvider('kimi', calls);
  let failDeepseek = true;
  const originalHandler = deepseek.server.listeners('request')[0];
  deepseek.server.removeListener('request', originalHandler);
  deepseek.server.on('request', async (req, res) => {
    if (failDeepseek) {
      failDeepseek = false;
      for await (const chunk of req) { /* drain request */ }
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'temporary failure' } }));
      return;
    }
    originalHandler(req, res);
  });
  const config = {
    router: { token: 'local-test-token' },
    routing: {
      semanticTriage: false,
      deescalation: { minKimiRequests: 1, probeRequests: 1, minRecentToolCalls: 0 },
    },
    providers: {
      deepseek: { baseUrl: deepseek.url, model: 'deepseek-flash', apiKey: 'ds-secret' },
      kimi: { baseUrl: kimi.url, model: 'kimi-k3.1-pro', apiKey: 'kimi-secret' },
    },
  };
  const router = http.createServer(createHandler(config));
  const port = await listen(router);
  t.after(async () => { await close(router); await close(deepseek.server); await close(kimi.server); });
  const post = messages => fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer local-test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', messages }),
  });
  const initial = [{ role: 'user', content: '自主完成一个端到端完整项目' }];
  const checkpoint = [...initial, { role: 'assistant', content: '第一阶段完成' }, { role: 'user', content: '继续' }];

  let response = await post(initial);
  assert.equal((await response.json()).provider, 'kimi');
  response = await post(checkpoint);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-router-source'), 'deescalation_probe');
  await response.text();
  response = await post(checkpoint);
  assert.equal(response.headers.get('x-router-source'), 'sticky');
  assert.equal((await response.json()).provider, 'kimi');

  response = await fetch(`http://127.0.0.1:${port}/metrics`, {
    headers: { authorization: 'Bearer local-test-token' },
  });
  const metrics = await response.text();
  assert.match(metrics, /claude_router_deescalation_total\{outcome="probe_failed"\} 1/);
});

test('route_decision log carries audit keys and de-escalation outcome', async t => {
  const calls = [];
  const deepseek = await mockProvider('deepseek', calls);
  const kimi = await mockProvider('kimi', calls);
  const config = {
    router: { token: 'local-test-token' },
    providers: {
      deepseek: { baseUrl: deepseek.url, model: 'deepseek-flash', apiKey: 'ds-secret' },
      kimi: { baseUrl: kimi.url, model: 'kimi-k3.1-pro', apiKey: 'kimi-secret' },
    },
  };
  const router = http.createServer(createHandler(config));
  const port = await listen(router);
  t.after(async () => { await close(router); await close(deepseek.server); await close(kimi.server); });

  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', metadata: { user_id: 'audit-test' }, messages: [{ role: 'user', content: '重构整个模块' }] }),
    });
    assert.equal(response.status, 200);
  } finally {
    console.log = original;
  }

  const decision = lines.map(line => { try { return JSON.parse(line); } catch { return null; } })
    .find(entry => entry?.event === 'route_decision');
  assert.ok(decision, 'route_decision line was logged');
  assert.match(decision.conversationKey, /^[a-f0-9]{64}$/);
  assert.match(decision.taskKey, /^[a-f0-9]{64}$/);
  assert.equal(decision.deescalationOutcome, null);
  assert.ok(decision.stats, 'tool statistics are logged alongside the decision');
});

test('preview is side-effect free and sticky routing avoids repeated triage', async t => {
  const calls = [];
  const deepseek = await mockProvider('deepseek', calls);
  const kimi = await mockProvider('kimi', calls);
  let triageCalls = 0;
  const config = {
    router: { token: 'local-test-token' },
    routing: { semanticTriage: true, triageMinChars: 20, triageConfidence: 0.8 },
    providers: {
      deepseek: { baseUrl: deepseek.url, model: 'deepseek-flash', apiKey: 'ds-secret' },
      kimi: { baseUrl: kimi.url, model: 'kimi-k3.1-pro', apiKey: 'kimi-secret' },
    },
  };
  const router = http.createServer(createHandler(config, {
    semanticTriage: async () => {
      triageCalls += 1;
      return { provider: 'kimi', confidence: 0.95, category: 'long_horizon' };
    },
  }));
  const port = await listen(router);
  t.after(async () => { await close(router); await close(deepseek.server); await close(kimi.server); });
  const task = '分析现有实现中的偶发状态不一致，提出可复现步骤并验证最小修复方案。';
  const metadata = { user_id: 'sticky-handler-test' };
  const post = (messages, pathname = '/v1/messages') => fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { authorization: 'Bearer local-test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', metadata, messages }),
  });

  let response = await post([{ role: 'user', content: task }], '/v1/router/preview?beta=true');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).provider, 'kimi');
  assert.equal(calls.length, 0, 'preview must not call an upstream model');

  response = await post([{ role: 'user', content: task }]);
  assert.equal(response.headers.get('x-router-source'), 'semantic');
  assert.equal((await response.json()).provider, 'kimi');

  response = await post([
    { role: 'user', content: task },
    { role: 'assistant', content: '第一步已完成' },
    { role: 'user', content: '继续' },
  ], '/v1/messages?beta=true');
  assert.equal(response.headers.get('x-router-source'), 'sticky');
  assert.equal((await response.json()).provider, 'kimi');
  assert.equal(triageCalls, 1, 'preview result is cached; sticky follow-up does not re-triage');
});

test('version endpoint reports the running release and update state without auth', async t => {
  const config = { router: { token: 'local-test-token' }, providers: {} };
  const info = {
    current: ROUTER_VERSION,
    latest: '1.3.0',
    status: 'available',
    updateAvailable: true,
    checkedAt: '2026-11-25T00:00:00.000Z',
    repository: 'dragonxia-ctrl/claude-model-router',
  };
  let refreshes = 0;
  const updateChecker = { info: () => info, refresh: async () => { refreshes += 1; return info; } };
  const router = http.createServer(createHandler(config, { updateChecker }));
  const port = await listen(router);
  t.after(async () => { await close(router); });

  let response = await fetch(`http://127.0.0.1:${port}/version`);
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.current, ROUTER_VERSION);
  assert.equal(body.latest, '1.3.0');
  assert.equal(body.updateAvailable, true);
  assert.equal(refreshes, 1, 'reading the endpoint asks the checker to refresh in the background');

  response = await fetch(`http://127.0.0.1:${port}/health`);
  body = await response.json();
  assert.equal(body.release, ROUTER_VERSION);

  const plain = http.createServer(createHandler(config));
  const plainPort = await listen(plain);
  t.after(async () => { await close(plain); });
  body = await (await fetch(`http://127.0.0.1:${plainPort}/version`)).json();
  assert.equal(body.current, ROUTER_VERSION);
  assert.equal(body.latest, null);
  assert.equal(body.status, 'unknown');
});
