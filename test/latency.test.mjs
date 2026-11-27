import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionEngine } from '../src/decision-engine.mjs';
import { createLatencyTracker } from '../src/latency.mjs';
import { analyzeRecoveryWindow } from '../src/progress.mjs';

function config(latencyCheckpoint = {}, policy = {}) {
  return {
    routing: {
      semanticTriage: false,
      deescalation: {
        minKimiRequests: 2,
        probeRequests: 1,
        minRecentToolCalls: 0,
        windowRequests: 100,
        windowToolCalls: 100,
        windowMs: 600_000,
        ...policy,
        latencyCheckpoint: { enabled: true, ...latencyCheckpoint },
      },
    },
    providers: {
      deepseek: { baseUrl: 'https://ds.invalid', model: 'ds', apiKey: 'dummy' },
      kimi: { baseUrl: 'https://k.invalid', model: 'k', apiKey: 'dummy' },
    },
  };
}

const TASK = '自主完成一个端到端完整项目';

function record(provider, ttfbMs, durationMs, outputTokens = 100) {
  return {
    provider,
    outcome: 'success',
    purpose: 'main',
    ttfbMs,
    durationMs,
    usage: { output_tokens: outputTokens },
    route: { selectedProvider: provider, previousProvider: null },
  };
}

test('latency is measured after TTFB and uses a provider EMA', () => {
  const tracker = createLatencyTracker(() => config());
  tracker.observe(record('deepseek', 100, 1_100));
  const deepseek = tracker.snapshot();
  assert.equal(deepseek.deepseekTps, 100);
  assert.equal(deepseek.last.genMs, 1_000);
  assert.equal(deepseek.last.outputTokens, 100);
  tracker.observe(record('deepseek', 100, 2_100));
  assert.equal(Math.round(tracker.snapshot().deepseekTps), 90);
  assert.equal(tracker.pressure(), false);
  // Headers delivered after generation produce no measurable generation time;
  // do not let that look like infinite speed.
  tracker.observe(record('deepseek', 100, 120));
  assert.equal(tracker.snapshot().last.tps, null);
});

test('latency pressure uses consecutive samples and hysteresis', () => {
  const tracker = createLatencyTracker(() => config({ samples: 2, minBaselineSamples: 2, emaAlpha: 1 }));
  tracker.observe(record('deepseek', 100, 1_100));
  tracker.observe(record('deepseek', 100, 1_100));
  tracker.observe(record('kimi', 100, 3_100));
  tracker.observe(record('kimi', 100, 3_100));
  assert.equal(tracker.pressure(), false);
  tracker.observe(record('kimi', 100, 3_100));
  assert.equal(tracker.pressure(), true);

  tracker.observe(record('kimi', 100, 1_100));
  assert.equal(tracker.pressure(), true, 'a ratio in the hysteresis band holds pressure');
  tracker.observe(record('kimi', 100, 1_100));
  assert.equal(tracker.pressure(), false);
});

test('a provider switch measures the prefill penalty against the target baseline', () => {
  const tracker = createLatencyTracker(() => config({ minBaselineSamples: 2 }));
  for (let i = 0; i < 2; i += 1) tracker.observe(record('deepseek', 200, 1_200));
  const switched = record('deepseek', 1_200, 2_200);
  switched.route = { selectedProvider: 'deepseek', previousProvider: 'kimi' };
  const sample = tracker.observe(switched);
  assert.equal(sample.switchPrefillPenaltyMs, 1_000);
  assert.equal(tracker.snapshot().last.switched, true);
});

test('latency checkpoints are off by default', () => {
  const tracker = createLatencyTracker(() => ({ routing: { deescalation: {} } }));
  assert.equal(tracker.snapshot().enabled, false);
  assert.equal(tracker.pressure(), false);
});

async function round(engine, messages, outcome = 'success') {
  const result = await engine.resolve({ model: 'auto', stream: true, messages }, { semantic: false });
  engine.remember(result.decision, result.state);
  engine.observe(result.decision, { outcome });
  return result;
}

function readLoop(messages, count = 2) {
  const next = [...messages];
  for (let i = 0; i < count; i += 1) {
    next.push({ role: 'assistant', content: [{ type: 'tool_use', id: `read-${i}`, name: 'Read', input: { file_path: `a-${i}.js` } }] });
    next.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `read-${i}`, content: 'ok' }] });
  }
  return next;
}

test('latency pressure opens a checkpoint only after the fast window', async () => {
  let clock = 100_000;
  const engine = createDecisionEngine(() => config({ fastWindowMs: 1_000 }), {
    now: () => clock,
    latencyTracker: { pressure: () => true },
  });
  const messages = readLoop([{ role: 'user', content: TASK }], 2);
  await round(engine, messages);
  clock += 100;
  const result = await round(engine, messages);
  assert.equal(result.decision.provider, 'kimi');
  assert.equal(result.checkpoint, null);
  clock += 1_001;
  const probe = await round(engine, messages);
  assert.equal(probe.decision.provider, 'deepseek');
  assert.equal(probe.checkpoint, 'latency_window');
  assert.equal(probe.transition.outcome, 'probe_started');
});

test('latency pressure does not switch a turn with no tool evidence', async () => {
  let clock = 100_000;
  const engine = createDecisionEngine(() => config({ fastWindowMs: 1_000 }), {
    now: () => clock,
    latencyTracker: { pressure: () => true },
  });
  const messages = [{ role: 'user', content: TASK }];
  await round(engine, messages);
  clock += 2_000;
  const result = await round(engine, messages);
  assert.equal(result.decision.provider, 'kimi');
  assert.equal(result.checkpoint, null);
});

test('latency pressure does not bypass a dirty recovery window', async () => {
  let clock = 100_000;
  const engine = createDecisionEngine(() => config({ fastWindowMs: 1_000 }), {
    now: () => clock,
    latencyTracker: { pressure: () => true },
  });
  const messages = [{ role: 'user', content: TASK }];
  await round(engine, messages);
  await round(engine, messages);
  const failed = [
    ...messages,
    { role: 'assistant', content: [{ type: 'tool_use', id: 'test-1', name: 'Bash', input: { command: 'npm test' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'test-1', content: 'FAIL', is_error: true }] },
  ];
  clock += 2_000;
  const result = await round(engine, failed);
  assert.equal(result.decision.provider, 'kimi');
  assert.equal(result.checkpoint, 'latency_window');
  assert.equal(result.transition.outcome, 'recovery_blocked');
});

test('latency checkpoints require a mechanical read/verification phase', async () => {
  let clock = 100_000;
  const engine = createDecisionEngine(() => config({ fastWindowMs: 1_000 }), {
    now: () => clock,
    latencyTracker: { pressure: () => true },
  });
  let messages = [{ role: 'user', content: TASK }];
  await round(engine, messages);
  await round(engine, messages);
  messages = [
    ...messages,
    { role: 'assistant', content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: 'a.js', old_string: 'a', new_string: 'b' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-1', content: 'ok' }] },
  ];
  clock += 2_000;
  const result = await round(engine, messages);
  assert.equal(result.decision.provider, 'kimi');
  assert.equal(result.checkpoint, null);

  messages = readLoop(messages, 4);
  clock += 2_000;
  const probe = await round(engine, messages);
  assert.equal(probe.decision.provider, 'deepseek');
  assert.equal(probe.checkpoint, 'latency_window');
});

test('a failed latency probe starts a Kimi cooldown before re-entry', async () => {
  let clock = 100_000;
  const engine = createDecisionEngine(() => config(
    { fastWindowMs: 1_000, cooldownRequests: 2 },
    { minKimiRequests: 1, maxAttempts: 10 },
  ), {
    now: () => clock,
    latencyTracker: { pressure: () => true },
  });
  const messages = readLoop([{ role: 'user', content: TASK }], 2);
  await round(engine, messages);
  clock += 2_000;
  await round(engine, messages, { outcome: 'upstream_5xx', httpStatus: 503 });
  assert.equal(engine.routingState()[0].latencyCooldown, 2);

  for (const expected of [1, 0]) {
    clock += 2_000;
    const result = await round(engine, messages);
    assert.equal(result.decision.provider, 'kimi');
    assert.equal(result.state.latencyCooldown, expected);
    assert.equal(result.checkpoint, null);
  }
  clock += 2_000;
  const result = await round(engine, messages);
  assert.equal(result.decision.provider, 'deepseek');
  assert.equal(result.checkpoint, 'latency_window');
});

test('the recovery window counts read-only and mutating calls', () => {
  const messages = [
    { role: 'user', content: TASK },
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'r', name: 'Read', input: { file_path: 'a.js' } },
      { type: 'tool_use', id: 'e', name: 'Edit', input: { file_path: 'a.js', old_string: 'a', new_string: 'b' } },
      { type: 'tool_use', id: 'v', name: 'Bash', input: { command: 'npm test' } },
    ] },
  ];
  const window = analyzeRecoveryWindow(messages, 0, 12);
  assert.equal(window.toolCalls, 3);
  assert.equal(window.readOnlyCalls, 1);
  assert.equal(window.mutatingCalls, 1);
  assert.equal(window.verificationCalls, 1);
});
