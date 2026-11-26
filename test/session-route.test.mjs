import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHandler } from '../src/handler.mjs';
import { sessionTag } from '../src/session.mjs';

const listen = server => new Promise(resolve => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = server => new Promise(resolve => {
  server.closeAllConnections();
  server.close(resolve);
});

test('route_decision carries a hashed session tag and stays null without one', async t => {
  const provider = http.createServer(async (req, res) => {
    for await (const chunk of req) chunk;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'msg_test', model: 'deepseek-flash' }));
  });
  const providerPort = await listen(provider);
  const config = {
    router: { token: 'local-test-token' },
    providers: {
      deepseek: { baseUrl: `http://127.0.0.1:${providerPort}`, model: 'deepseek-flash', apiKey: 'ds-secret' },
      kimi: { baseUrl: `http://127.0.0.1:${providerPort}`, model: 'kimi-k3.1-pro', apiKey: 'kimi-secret' },
    },
  };
  const router = http.createServer(createHandler(config));
  const routerPort = await listen(router);
  t.after(async () => { await close(router); await close(provider); });

  const logged = [];
  t.mock.method(console, 'log', (...args) => { logged.push(args.join(' ')); });

  const post = extraHeaders => fetch(`http://127.0.0.1:${routerPort}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer local-test-token',
      'content-type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify({ model: 'auto', stream: false, messages: [{ role: 'user', content: '你好' }] }),
  });

  const uuid = '11111111-1111-4111-8111-111111111111';
  let response = await post({ 'x-claude-code-session-id': uuid });
  assert.equal(response.status, 200);
  await response.json();

  let decision = logged
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .find(record => record?.event === 'route_decision');
  assert.ok(decision, 'a route_decision was logged');
  assert.equal(decision.session, sessionTag(uuid));

  logged.length = 0;
  response = await post({});
  assert.equal(response.status, 200);
  await response.json();
  decision = logged
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .find(record => record?.event === 'route_decision');
  assert.ok(decision, 'a route_decision was logged');
  assert.equal(decision.session, null);
});
