import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionEngine } from '../src/decision-engine.mjs';
import { DEESCALATION_DEFAULTS, evaluateRecovery, probeFailureClass } from '../src/deescalation.mjs';
import { sanitizeForProvider } from '../src/sanitize.mjs';

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
        windowRequests: 100,
        windowMs: 600_000,
        ...policy,
      },
    },
    providers: {
      deepseek: { baseUrl: 'https://ds.invalid', model: 'ds', apiKey: 'dummy' },
      kimi: { baseUrl: 'https://k.invalid', model: 'k', apiKey: 'dummy' },
    },
  };
}

const TASK_A = '自主完成一个端到端完整项目';

function followUp(messages, text = '继续') {
  return [...messages, { role: 'assistant', content: '本阶段已完成' }, { role: 'user', content: text }];
}

async function round(engine, messages, record = { outcome: 'success' }) {
  const result = await engine.resolve({ model: 'auto', stream: true, messages }, { semantic: false });
  engine.remember(result.decision, result.state);
  engine.observe(result.decision, typeof record === 'string' ? { outcome: record } : record);
  return result;
}

function failedRead(messages, id = 'read-1') {
  return [
    ...messages,
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'a.js' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'permission denied', is_error: true }] },
  ];
}

test('interleaved tasks keep independent residency and recovery state', async () => {
  const engine = createDecisionEngine(() => config());
  const taskA = [{ role: 'user', content: TASK_A }];
  await round(engine, taskA);
  const checkpoint = followUp(taskA);
  assert.equal((await round(engine, checkpoint)).decision.source, 'deescalation_probe');
  await round(engine, checkpoint);
  assert.equal(engine.routingState()[0].recovered, true);

  // A second task in the same conversation must not overwrite task A's state.
  const taskB = [...checkpoint, { role: 'assistant', content: 'A 已完成' }, { role: 'user', content: '深度研究一个全新主题' }];
  const other = await round(engine, taskB);
  assert.equal(other.decision.provider, 'kimi');
  assert.equal(engine.routingState().length, 2);

  const resumed = await round(engine, followUp(checkpoint));
  assert.equal(resumed.decision.provider, 'deepseek');
  assert.equal(resumed.decision.source, 'deescalated');
  assert.equal(engine.routingState().length, 2);
  assert.equal(engine.routingState().find(state => state.taskKey === resumed.decision.taskKey).recovered, true);
});

test('a single trailing failure needs confirmation before relapsing', async () => {
  const engine = createDecisionEngine(() => config());
  const task = [{ role: 'user', content: TASK_A }];
  await round(engine, task);
  const checkpoint = followUp(task);
  await round(engine, checkpoint);
  await round(engine, checkpoint);
  assert.equal(engine.routingState()[0].recovered, true);

  const failed = failedRead(checkpoint);
  const pending = await round(engine, failed);
  assert.equal(pending.decision.provider, 'deepseek');
  assert.equal(pending.transition.outcome, 'relapse_pending');
  assert.equal(pending.state.relapseStreak, 1);
  assert.equal(pending.state.attempts, 0);

  const relapse = await round(engine, failed);
  assert.equal(relapse.decision.provider, 'kimi');
  assert.equal(relapse.decision.source, 'relapse');
  assert.equal(relapse.transition.outcome, 'relapse');
  // A relapse advances the backoff cycle instead of restarting at zero.
  assert.equal(relapse.state.attempts, 1);
  assert.equal(relapse.state.requiredKimiRequests, 2);
  assert.equal(engine.routingState()[0].relapseStreak, 0);
});

test('a failed verification relapses immediately', async () => {
  const engine = createDecisionEngine(() => config());
  const task = [{ role: 'user', content: TASK_A }];
  await round(engine, task);
  const checkpoint = followUp(task);
  await round(engine, checkpoint);
  await round(engine, checkpoint);
  const failed = [
    ...checkpoint,
    { role: 'assistant', content: [{ type: 'tool_use', id: 'verify-1', name: 'Bash', input: { command: 'npm test' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'verify-1', content: 'FAIL 1 test', is_error: true }] },
  ];
  const result = await round(engine, failed);
  assert.equal(result.decision.provider, 'kimi');
  assert.equal(result.decision.source, 'relapse');
  assert.equal(result.transition.outcome, 'relapse');
  assert.equal(result.state.attempts, 1);
});

test('failure-rate evidence requires two failures and a real denominator', () => {
  const base = {
    failedVerifications: 0, repeatedErrorGroups: 0, trailingFailures: 0,
    maxMutationRepeats: 0, successfulMutations: 0, verificationCalls: 0,
    successfulVerifications: 0,
  };
  const settings = { ...DEESCALATION_DEFAULTS, minRecentToolCalls: 0 };
  const oneSmallFailure = evaluateRecovery({ ...base, toolCalls: 1, failedResults: 1, failureRate: 1 }, settings);
  assert.equal(oneSmallFailure.clean, true);
  const twoFailures = evaluateRecovery({ ...base, toolCalls: 4, failedResults: 2, failureRate: 0.5 }, settings);
  assert.equal(twoFailures.clean, false);
  assert.match(twoFailures.blockers.join('; '), /2\/10/);
  assert.equal(twoFailures.serious, false);
  assert.equal(evaluateRecovery({ ...base, toolCalls: 4, failedResults: 1, failedVerifications: 1 }, settings).serious, true);
});

test('probe failures are classified without guessing about quality', () => {
  assert.equal(probeFailureClass({ httpStatus: 400 }), 'invalid_request');
  assert.equal(probeFailureClass({ httpStatus: 401 }), 'invalid_request');
  assert.equal(probeFailureClass({ httpStatus: 429 }), 'unavailable');
  assert.equal(probeFailureClass({ httpStatus: 503 }), 'unavailable');
  assert.equal(probeFailureClass({ outcome: 'upstream_error', errorKind: 'timeout' }), 'unavailable');
  assert.equal(probeFailureClass({ outcome: 'stream_error', errorKind: 'stream_error' }), 'unavailable');
  assert.equal(probeFailureClass({ outcome: 'upstream_4xx' }), 'invalid_request');
  assert.equal(probeFailureClass({ outcome: 'unknown' }), 'unavailable');
});

test('a 400 probe outcome is recorded and consumes one bounded attempt', async () => {
  const engine = createDecisionEngine(() => config({ minKimiRequests: 2 }));
  const task = [{ role: 'user', content: TASK_A }];
  await round(engine, task);
  await round(engine, task);
  const checkpoint = followUp(task);
  await round(engine, checkpoint, { outcome: 'upstream_4xx', httpStatus: 400, errorKind: 'http_400' });
  const state = engine.routingState()[0];
  assert.equal(state.attempts, 1);
  assert.equal(state.requiredKimiRequests, 4);
  assert.equal(state.availabilityFailures, 0);
  assert.deepEqual(state.lastProbeFailure, {
    at: state.lastProbeFailure.at,
    class: 'invalid_request', outcome: 'upstream_4xx', httpStatus: 400, errorKind: 'http_400',
  });
});

test('an aborted probe does not change the state machine', async () => {
  const engine = createDecisionEngine(() => config());
  const task = [{ role: 'user', content: TASK_A }];
  await round(engine, task);
  const checkpoint = followUp(task);
  await round(engine, checkpoint, 'client_aborted');
  const state = engine.routingState()[0];
  assert.equal(state.phase, 'probe');
  assert.equal(state.attempts, 0);
  assert.equal(state.lastProbeFailure, null);
});

test('a new task keeps the conversation provider for sanitization', async () => {
  const engine = createDecisionEngine(() => config());
  const taskA = [{ role: 'user', content: TASK_A }];
  const first = await round(engine, taskA);
  assert.equal(first.decision.provider, 'kimi');

  const messages = [
    ...taskA,
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'private plan', signature: 'kimi-signature' },
        { type: 'text', text: '任务 A 完成' },
      ],
    },
    { role: 'user', content: '修复一个普通函数' },
  ];
  const second = await round(engine, messages);
  assert.equal(second.decision.provider, 'deepseek');
  assert.equal(second.previousProvider, 'kimi');

  const sanitized = sanitizeForProvider({ model: 'auto', stream: true, messages }, second.previousProvider, second.decision.provider);
  const assistant = sanitized.messages[1];
  assert.ok(!assistant.content.some(block => block.type === 'thinking' && block.signature === 'kimi-signature'));
  assert.ok(assistant.content.some(block => block.type === 'thinking' && block.signature === ''));
});

test('a failed probe starts the next cycle with a clean relapse confirmation', async () => {
  const engine = createDecisionEngine(() => config({ probeRequests: 3, windowToolCalls: 1 }));
  const task = [{ role: 'user', content: TASK_A }];
  await round(engine, task);
  const checkpoint = followUp(task);
  await round(engine, checkpoint);

  const pending = await round(engine, failedRead(checkpoint));
  assert.equal(pending.transition.outcome, 'probe_relapse_pending');
  assert.equal(engine.routingState()[0].relapseStreak, 1);

  // Push the failure out of the one-call window, then fail the probe itself.
  const clean = [
    ...failedRead(checkpoint),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read-ok', name: 'Read', input: { file_path: 'ok.js' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-ok', content: 'ok' }] },
  ];
  const failedProbe = await round(engine, clean, { outcome: 'upstream_error', httpStatus: 503, errorKind: 'http_503' });
  assert.equal(failedProbe.transition.outcome, 'probe_continue');
  assert.equal(engine.routingState()[0].relapseStreak, 0);
  assert.equal(engine.routingState()[0].phase, 'kimi');

  const resumed = followUp(clean);
  assert.equal((await round(engine, resumed)).transition.outcome, 'backoff');
  const nextCheckpoint = followUp(resumed);
  const nextProbe = await round(engine, nextCheckpoint);
  assert.equal(nextProbe.transition.outcome, 'probe_started');
  assert.equal(engine.routingState()[0].relapseStreak, 0);

  // The new cycle must require its own confirmation, not inherit the old one.
  const nextPending = await round(engine, failedRead(nextCheckpoint));
  assert.equal(nextPending.decision.provider, 'deepseek');
  assert.equal(nextPending.transition.outcome, 'probe_relapse_pending');
  assert.equal(nextPending.state.relapseStreak, 1);
});

test('manual de-escalation covers every task in one conversation', async () => {
  const engine = createDecisionEngine(() => config());
  const taskA = [{ role: 'user', content: TASK_A }];
  const first = await round(engine, taskA);
  const taskB = [...taskA, { role: 'assistant', content: 'A 完成' }, { role: 'user', content: '自主完成另一个端到端完整项目' }];
  await round(engine, taskB);
  assert.equal(engine.routingState().length, 2);
  assert.deepEqual(engine.requestDeescalation({ conversationKey: first.decision.conversationKey }), [first.decision.conversationKey]);
  assert.ok(engine.routingState().every(state => state.forced && state.phase === 'kimi'));
});
