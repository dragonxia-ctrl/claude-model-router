import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionEngine } from '../src/decision-engine.mjs';
import { classifySemantically } from '../src/semantic.mjs';

const config = enabled => ({
  router: { token: 'a'.repeat(64), port: 17861 },
  routing: { semanticTriage: enabled, triageMinChars: 20, triageConfidence: 0.8 },
  providers: { deepseek: { baseUrl: 'https://ds.invalid', model: 'ds', apiKey: 'x' }, kimi: { baseUrl: 'https://k.invalid', model: 'k', apiKey: 'y' } },
});
const task = '分析这个数据管道中偶发的不一致，设计可复现的实验并验证最小修改方案。';
const body = (text = task) => ({ model: 'auto', messages: [{ role: 'user', content: text }] });

test('semantic triage is cached and the same task stays on Kimi', async () => {
  let calls = 0;
  const engine = createDecisionEngine(() => config(true), {
    semanticTriage: async () => { calls += 1; return { provider: 'kimi', confidence: 0.93, category: 'long_horizon' }; },
  });
  const first = await engine.resolve(body());
  assert.equal(first.decision.provider, 'kimi');
  assert.equal(first.decision.source, 'semantic');
  engine.remember(first.decision);
  const followUp = { model: 'auto', messages: [...body().messages, { role: 'assistant', content: '已完成第一步' }, { role: 'user', content: '继续' }] };
  const second = await engine.resolve(followUp);
  assert.equal(second.decision.provider, 'kimi');
  assert.equal(second.decision.source, 'sticky');
  assert.equal(calls, 1);
});

test('semantic errors and low confidence safely fall back to DeepSeek', async () => {
  const failing = createDecisionEngine(() => config(true), { semanticTriage: async () => { throw new Error('offline'); } });
  assert.equal((await failing.resolve(body())).decision.provider, 'deepseek');
  const uncertain = createDecisionEngine(() => config(true), {
    semanticTriage: async () => ({ provider: 'kimi', confidence: 0.2, category: 'unclear' }),
  });
  assert.equal((await uncertain.resolve(body())).decision.provider, 'deepseek');
});

test('disabled semantic triage makes no classifier call', async () => {
  let calls = 0;
  const engine = createDecisionEngine(() => config(false), { semanticTriage: async () => { calls += 1; } });
  await engine.resolve(body());
  assert.equal(calls, 0);
});

test('semantic parser accepts fenced JSON and rejects invalid labels', async () => {
  let posted;
  const fetchImpl = async (url, options) => {
    posted = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: '```json\n{"provider":"kimi","confidence":0.91,"category":"long_horizon"}\n```' }] }),
    };
  };
  const result = await classifySemantically({ text: task, config: config(true), fetchImpl });
  assert.equal(result.provider, 'kimi');
  assert.ok(posted.max_tokens >= 384, 'reasoning-capable classifier needs room to finish its JSON');
  assert.equal(posted.thinking?.type, 'disabled', 'classification must not spend tokens on free-form reasoning');
  const invalid = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: '{"provider":"other"}' }] }) });
  await assert.rejects(() => classifySemantically({ text: task, config: config(true), fetchImpl: invalid }), /invalid provider/);
});
