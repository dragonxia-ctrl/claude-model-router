import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createUsageTap } from '../src/usage.mjs';
import { createTelemetry } from '../src/telemetry.mjs';
import { createHandler } from '../src/handler.mjs';

const listen = server => new Promise(resolve => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = server => new Promise(resolve => {
  server.closeAllConnections();
  server.close(resolve);
});

test('usage tap extracts JSON and split SSE usage without retaining response text', () => {
  const json = createUsageTap('application/json; charset=utf-8');
  json.push('{"id":"msg_1","usage":{"input_tokens":12,');
  json.push('"output_tokens":7,"cache_read_input_tokens":30,"cache_creation_input_tokens":4}}');
  assert.deepEqual(json.end(), {
    input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 30, cache_creation_input_tokens: 4,
  });

  const sse = createUsageTap('text/event-stream');
  const events = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":20,"cache_creation_input_tokens":5}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"secret answer"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":8}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
  for (let index = 0; index < events.length; index += 3) sse.push(events.slice(index, index + 3));
  assert.deepEqual(sse.end(), {
    input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 20, cache_creation_input_tokens: 5,
  });
});

test('telemetry records bounded metrics, real token counters, and Prometheus histograms', () => {
  const telemetry = createTelemetry();
  telemetry.recordRequest({
    at: new Date().toISOString(), requestId: 'req-1', provider: 'deepseek', model: 'deepseek-flash',
    purpose: 'main', outcome: 'success', httpStatus: 200, ttfbMs: 120, durationMs: 1400,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
    route: { selectedProvider: 'deepseek', source: 'semantic', previousProvider: null, escalated: false },
  });
  telemetry.recordRequest({
    at: new Date().toISOString(), requestId: 'req-2', provider: 'kimi', model: 'kimi-k3.1-pro',
    purpose: 'main', outcome: 'upstream_5xx', httpStatus: 503, durationMs: 2600,
    route: { selectedProvider: 'kimi', source: 'evidence', previousProvider: 'deepseek', escalated: true },
  });
  const text = telemetry.renderPrometheus();
  assert.match(text, /claude_router_requests_total\{model="deepseek-flash",outcome="success",provider="deepseek",purpose="main"\} 1/);
  assert.match(text, /claude_router_tokens_total\{model="deepseek-flash",provider="deepseek",type="cache_read"\} 50/);
  assert.match(text, /claude_router_escalations_total\{from_provider="deepseek",source="evidence",to_provider="kimi"\} 1/);
  assert.match(text, /claude_router_request_duration_seconds_bucket\{.*le="2.5".*\} 1/);
  assert.match(text, /claude_router_request_duration_seconds_sum\{.*\} 1.400/);
  assert.equal(text.match(/# TYPE claude_router_tokens_total counter/g)?.length, 1);
  assert.equal(telemetry.snapshot().lastUpstreamError.provider, 'kimi');
  assert.equal(telemetry.snapshot().lastUpstreamSuccess.provider, 'deepseek');
});

test('optional JSONL persistence pseudonymizes task keys and drops old files by retention', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'router-telemetry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const oldFile = path.join(directory, 'requests-2020-01-01.jsonl');
  fs.writeFileSync(oldFile, 'old\n');
  const oldDate = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(oldFile, oldDate, oldDate);
  const telemetry = createTelemetry({ persist: true, directory, retentionDays: 30 });
  telemetry.recordRequest({
    at: new Date().toISOString(), requestId: 'req-private', provider: 'deepseek', model: 'deepseek-flash',
    purpose: 'main', outcome: 'success', durationMs: 100,
    conversationKey: 'raw-conversation-key', taskKey: 'raw-task-key',
  });
  await telemetry.close();
  const files = fs.readdirSync(directory).filter(name => name.endsWith('.jsonl'));
  assert.equal(files.length, 1);
  assert.notEqual(files[0], 'requests-2020-01-01.jsonl');
  const record = JSON.parse(fs.readFileSync(path.join(directory, files[0]), 'utf8'));
  assert.equal(record.request_id, 'req-private');
  assert.match(record.conversation_key, /^[a-f0-9]{32}$/);
  assert.match(record.task_key, /^[a-f0-9]{32}$/);
  assert.notEqual(record.conversation_key, 'raw-conversation-key');
  assert.equal(fs.statSync(path.join(directory, '.telemetry-salt')).mode & 0o777, 0o600);
});

test('health endpoints and metrics expose real upstream usage without leaking secrets', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'router-handler-telemetry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let triageCalls = 0;
  const provider = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (String(body.system || '').includes('classify one coding')) {
      triageCalls += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        model: body.model,
        content: [{ type: 'text', text: '{"provider":"deepseek","confidence":0.99,"category":"ordinary_coding"}' }],
        usage: { input_tokens: 50, output_tokens: 5 },
      }));
      return;
    }
    if (body.stream) {
      res.setHeader('content-type', 'text/event-stream');
      res.end([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":20,"cache_creation_input_tokens":5}}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":8}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(''));
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      id: 'msg_real', model: body.model, content: [],
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
    }));
  });
  const providerPort = await listen(provider);
  const telemetry = createTelemetry({ persist: true, directory });
  const config = {
    router: { token: 'local-test-token' },
    routing: { semanticTriage: true, triageMinChars: 20, triageConfidence: 0.8 },
    providers: {
      deepseek: { baseUrl: `http://127.0.0.1:${providerPort}`, model: 'deepseek-flash', apiKey: 'ds-secret' },
      kimi: { baseUrl: `http://127.0.0.1:${providerPort}`, model: 'kimi-k3.1-pro', apiKey: 'kimi-secret' },
    },
  };
  const router = http.createServer(createHandler(config, { telemetry }));
  const port = await listen(router);
  t.after(async () => { await telemetry.close(); await close(router); await close(provider); });
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: 'Bearer local-test-token' };

  let response = await fetch(`${base}/health/live`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'live');
  response = await fetch(`${base}/health/ready`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ready');
  response = await fetch(`${base}/health/deep`);
  assert.equal(response.status, 401);
  response = await fetch(`${base}/metrics`);
  assert.equal(response.status, 401);

  const task = '这是一个用于验证真实用量记录的普通编码任务，不需要调用付费远程服务。';
  response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', metadata: { user_id: 'telemetry-test' }, messages: [{ role: 'user', content: task }] }),
  });
  assert.equal(response.status, 200);
  await response.json();
  response = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', stream: true, metadata: { user_id: 'telemetry-test' }, messages: [{ role: 'user', content: task }] }),
  });
  assert.match(await response.text(), /message_stop/);
  assert.equal(triageCalls, 1);

  response = await fetch(`${base}/metrics`, { headers: auth });
  const metrics = await response.text();
  assert.match(metrics, /claude_router_requests_total\{.*purpose="semantic_triage".*\} 1/);
  assert.match(metrics, /claude_router_requests_total\{.*purpose="main".*\} 2/);
  assert.match(metrics, /claude_router_tokens_total\{.*type="cache_read".*\} 70/);
  assert.doesNotMatch(metrics, /ds-secret|kimi-secret|telemetry-test|普通编码任务/);

  response = await fetch(`${base}/health/deep`, { headers: auth });
  const deep = await response.json();
  assert.equal(deep.status, 'deep_ok');
  assert.equal(deep.telemetry.lastSemanticTriage.tokens, 55);
  assert.equal(deep.activeChecks, 'none; this endpoint never spends provider tokens');
  await telemetry.close();
  const persisted = fs.readdirSync(directory).filter(name => name.endsWith('.jsonl'))
    .flatMap(name => fs.readFileSync(path.join(directory, name), 'utf8').trim().split('\n'));
  assert.equal(persisted.length, 3);
  assert.doesNotMatch(persisted.join('\n'), /普通编码任务|telemetry-test|ds-secret|kimi-secret/);
});
