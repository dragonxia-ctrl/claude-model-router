import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionEngine } from '../src/decision-engine.mjs';
import { evaluateRecovery, backoffRequests, DEESCALATION_DEFAULTS } from '../src/deescalation.mjs';

const SOFT_TASK = '自主完成一个端到端完整项目';
const HARD_TASK = '分析这个附件';

function videoBody() {
  return [{ role: 'user', content: [
    { type: 'text', text: HARD_TASK },
    { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: 'AAAA' } },
  ] }];
}

function config(policy = {}) {
  return {
    routing: {
      semanticTriage: false,
      deescalation: {
        minKimiRequests: 1,
        probeRequests: 1,
        maxAttempts: 2,
        maxBackoffRequests: 8,
        minRecentToolCalls: 0,
        ...policy,
      },
    },
    providers: {
      deepseek: { baseUrl: 'https://ds.invalid', model: 'ds', apiKey: 'dummy' },
      kimi: { baseUrl: 'https://k.invalid', model: 'k', apiKey: 'dummy' },
    },
  };
}

function body(text = SOFT_TASK) {
  return [{ role: 'user', content: text }];
}

function followUp(messages, text = '继续') {
  return [...messages, { role: 'assistant', content: '本阶段已完成' }, { role: 'user', content: text }];
}

async function round(engine, messages, outcome = 'success', model = 'auto') {
  const result = await engine.resolve({ model, stream: true, messages }, { semantic: false });
  engine.remember(result.decision, result.state);
  engine.observe(result.decision, { outcome });
  return result;
}

test('Kimi stickiness is bounded and a successful probe stays on DeepSeek', async () => {
  const engine = createDecisionEngine(() => config({ minKimiRequests: 2, probeRequests: 2 }));
  const messages = body();
  assert.equal((await round(engine, messages)).decision.provider, 'kimi');
  assert.equal((await round(engine, messages)).decision.source, 'sticky');

  const checkpoint = followUp(messages);
  const firstProbe = await round(engine, checkpoint);
  assert.equal(firstProbe.decision.provider, 'deepseek');
  assert.equal(firstProbe.decision.source, 'deescalation_probe');

  const secondProbe = await round(engine, checkpoint);
  assert.equal(secondProbe.decision.provider, 'deepseek');
  assert.equal(secondProbe.decision.source, 'probe');

  const stable = await round(engine, checkpoint);
  assert.equal(stable.decision.provider, 'deepseek');
  assert.equal(stable.decision.source, 'deescalated');
});

test('de-escalation starts only at a new human checkpoint', async () => {
  const engine = createDecisionEngine(() => config());
  const messages = body();
  await round(engine, messages);
  const toolLoopRequest = await round(engine, messages);
  assert.equal(toolLoopRequest.decision.provider, 'kimi');
  assert.equal(toolLoopRequest.decision.source, 'sticky');
  const checkpoint = await round(engine, followUp(messages));
  assert.equal(checkpoint.decision.provider, 'deepseek');
});

test('hard capabilities never automatically de-escalate', async () => {
  const engine = createDecisionEngine(() => config());
  const messages = videoBody();
  await round(engine, messages);
  const result = await round(engine, followUp(messages));
  assert.equal(result.decision.provider, 'kimi');
  assert.equal(result.decision.hardCapability, true);
  assert.equal(result.transition.outcome, 'capability_blocked');
});

test('explicit provider selection overrides a planned probe', async () => {
  const engine = createDecisionEngine(() => config());
  const messages = body();
  await round(engine, messages);
  const result = await round(engine, followUp(messages), 'success', 'deepseek-flash');
  assert.equal(result.decision.provider, 'deepseek');
  assert.equal(result.decision.source, 'explicit');
  assert.equal(result.decision.reason, 'explicit model selection');
});

test('a failed upstream probe returns to Kimi with exponential backoff', async () => {
  const engine = createDecisionEngine(() => config({ minKimiRequests: 2, maxBackoffRequests: 8 }));
  const messages = body();
  await round(engine, messages);
  await round(engine, messages);
  const checkpoint = followUp(messages);
  const probe = await round(engine, checkpoint, 'upstream_5xx');
  assert.equal(probe.decision.provider, 'deepseek');

  let current = checkpoint;
  let result = await round(engine, current);
  assert.equal(result.decision.provider, 'kimi');
  for (let i = 0; i < 3; i += 1) {
    current = followUp(current);
    result = await round(engine, current);
    assert.equal(result.decision.provider, 'kimi', 'four successful Kimi requests are required after the first failed probe');
  }
  current = followUp(current);
  result = await round(engine, current);
  assert.equal(result.decision.provider, 'deepseek');
});

test('new tool failures relapse during a DeepSeek probe', async () => {
  const engine = createDecisionEngine(() => config({ probeRequests: 2 }));
  const messages = body();
  await round(engine, messages);
  const checkpoint = followUp(messages);
  await round(engine, checkpoint);
  const failed = [
    ...checkpoint,
    { role: 'assistant', content: [{ type: 'tool_use', id: 'probe-test', name: 'Bash', input: { command: 'npm test' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'probe-test', content: 'FAIL new regression', is_error: true }] },
  ];
  const result = await round(engine, failed);
  assert.equal(result.decision.provider, 'kimi');
  assert.equal(result.decision.source, 'probe_relapsed');
  assert.equal(result.transition.outcome, 'probe_relapsed');
});

test('cumulative escalation failures do not block a clean recent recovery window', async () => {
  const engine = createDecisionEngine(() => config({ windowToolCalls: 4, minRecentToolCalls: 4 }));
  let messages = [{ role: 'user', content: '修复实现并验证结果' }];
  const steps = [
    { name: 'Edit', input: { file_path: 'a.js', old_string: 'a', new_string: 'b' } },
    { name: 'Bash', input: { command: 'npm test' }, error: true },
    { name: 'Edit', input: { file_path: 'a.js', old_string: 'b', new_string: 'c' } },
    { name: 'Bash', input: { command: 'npm test' }, error: true },
  ];
  const append = (step, index) => {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `call-${index}`, name: step.name, input: step.input }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `call-${index}`, content: step.error ? 'FAIL suite' : 'ok', is_error: Boolean(step.error) }] });
  };
  steps.forEach(append);
  assert.equal((await round(engine, messages)).decision.provider, 'kimi');

  for (let i = 0; i < 4; i += 1) append({ name: 'Read', input: { file_path: `recovered-${i}.js` } }, i + 4);
  // A clean window is now also evaluated mid-turn, so the probe starts as soon
  // as the four new tool calls are in — before the next user message arrives.
  const early = await round(engine, messages);
  assert.equal(early.decision.provider, 'deepseek');
  assert.equal(early.decision.source, 'deescalation_probe');
  const result = await round(engine, followUp(messages));
  assert.equal(result.decision.stats.failedVerifications, 2, 'cumulative escalation evidence remains visible');
  assert.equal(result.decision.provider, 'deepseek');
  assert.ok(['probe', 'deescalated'].includes(result.decision.source), result.decision.source);
});

test('maximum failed attempts keep the task on Kimi when periodic retry is disabled', async () => {
  const engine = createDecisionEngine(() => config({ maxAttempts: 1, retryAfterExhaustedRequests: 0 }));
  const messages = body();
  await round(engine, messages);
  const checkpoint = followUp(messages);
  await round(engine, checkpoint, 'upstream_5xx');
  await round(engine, checkpoint);
  const result = await round(engine, followUp(checkpoint));
  assert.equal(result.decision.provider, 'kimi');
  assert.equal(result.transition.outcome, 'attempts_exhausted');
});

test('a missing DeepSeek key cannot trigger a doomed probe', async () => {
  const active = config();
  active.providers.deepseek.apiKey = '';
  const engine = createDecisionEngine(() => active);
  const messages = body();
  await round(engine, messages);
  const result = await round(engine, followUp(messages));
  assert.equal(result.decision.provider, 'kimi');
  assert.match(result.decision.reason, /DeepSeek is not configured/);
});

test('recovery gates and backoff arithmetic are bounded', () => {
  const clean = evaluateRecovery({
    toolCalls: 4, failedVerifications: 0, repeatedErrorGroups: 0,
    trailingFailures: 0, failureRate: 0, maxMutationRepeats: 1,
    successfulMutations: 1, verificationCalls: 1, successfulVerifications: 1,
  }, DEESCALATION_DEFAULTS);
  assert.equal(clean.clean, true);
  const failed = evaluateRecovery({
    toolCalls: 4, failedVerifications: 1, repeatedErrorGroups: 0,
    trailingFailures: 1, failureRate: 0.25, maxMutationRepeats: 1,
    successfulMutations: 1, verificationCalls: 1, successfulVerifications: 0,
  }, DEESCALATION_DEFAULTS);
  assert.equal(failed.clean, false);
  assert.ok(failed.blockers.length >= 3);
  assert.equal(backoffRequests(DEESCALATION_DEFAULTS, 0), 4);
  assert.equal(backoffRequests(DEESCALATION_DEFAULTS, 1), 8);
  assert.equal(backoffRequests(DEESCALATION_DEFAULTS, 20), 16);
});

test('a request-count checkpoint can start a probe without new tools or a new user message', async () => {
  const engine = createDecisionEngine(() => config({
    minKimiRequests: 2, windowRequests: 2, windowToolCalls: 100, windowMs: 600_000,
  }));
  const messages = body();
  assert.equal((await round(engine, messages)).decision.provider, 'kimi');
  assert.equal((await round(engine, messages)).decision.source, 'sticky');
  const result = await round(engine, messages);
  assert.equal(result.decision.provider, 'deepseek');
  assert.equal(result.decision.source, 'deescalation_probe');
  assert.equal(result.checkpoint, 'request_window');
});

test('an elapsed-time checkpoint can start a probe in a slow tool loop', async () => {
  let clock = 10_000;
  const engine = createDecisionEngine(() => config({
    minKimiRequests: 1, windowRequests: 100, windowToolCalls: 100, windowMs: 5_000,
  }), { now: () => clock });
  const messages = body();
  await round(engine, messages);
  clock += 1_000;
  assert.equal((await round(engine, messages)).decision.source, 'sticky');
  clock += 4_001;
  const result = await round(engine, messages);
  assert.equal(result.decision.provider, 'deepseek');
  assert.equal(result.checkpoint, 'idle_window');
});

test('an operator can schedule a manual de-escalation exit', async () => {
  const engine = createDecisionEngine(() => config({ windowRequests: 100, windowMs: 600_000 }));
  const messages = body();
  await round(engine, messages);
  const previous = await round(engine, messages);
  const key = previous.decision.conversationKey;
  assert.deepEqual(engine.requestDeescalation({ conversationKey: key }), [key]);
  assert.equal(engine.routingState()[0].forced, true);
  assert.equal(engine.routingState()[0].taskText, undefined);
  const result = await round(engine, messages);
  assert.equal(result.decision.provider, 'deepseek');
  assert.equal(result.decision.source, 'deescalation_probe');
  assert.equal(result.checkpoint, 'manual');
});

test('exhausted normal attempts still have a bounded periodic retry exit', async () => {
  const engine = createDecisionEngine(() => config({
    maxAttempts: 1, maxBackoffRequests: 1, retryAfterExhaustedRequests: 1,
    windowRequests: 100, windowMs: 600_000,
  }));
  const messages = body();
  await round(engine, messages);
  const checkpoint = followUp(messages);
  await round(engine, checkpoint, 'upstream_5xx');
  assert.equal((await round(engine, checkpoint)).decision.provider, 'kimi');
  const result = await round(engine, followUp(checkpoint));
  assert.equal(result.decision.provider, 'deepseek');
  assert.equal(result.decision.source, 'deescalation_probe');
});
