// Tests for the two routing fixes:
//   A. read-only inline Python / echo chains / read-only CLIs are no longer "mutating"
//   C. de-escalation can be evaluated mid-turn, every `windowToolCalls` new tool calls
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeProgress } from '../src/progress.mjs';
import { createDecisionEngine } from '../src/decision-engine.mjs';

const TASK = '把两个 Kaggle 比赛也提交了，并把新版本更新到 GitHub 上，用标签区分版本。';

function bashStats(command) {
  const messages = [
    { role: 'user', content: TASK },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
  ];
  return analyzeProgress(messages, 0);
}

test('A: read-only command shapes are not counted as mutations', () => {
  const read = [
    'echo "=== files ===" && cat agent.yaml',
    "python3 - <<'PY'\nimport json\nrows = [json.loads(l) for l in open('router.log')]\nprint(len(rows))\nPY",
    "python3 - <<'PY'\nx = 1; y = 2\nif x >= 1 and y > 0:\n    print('ok')\nPY",
    'kaggle kernels status xiayunlong/ntl-0724-safe-1125',
    'cd ~/.claude/model-router && grep -n provider router.log',
  ];
  for (const command of read) {
    const stats = bashStats(command);
    assert.equal(stats.mutatingCalls, 0, `expected read-only: ${command.split('\n')[0]}`);
  }
});

test('A: real writes still count as mutations', () => {
  const mutating = [
    "python3 - <<'PY'\nopen('out.txt', 'w').write('x')\nPY",
    "python3 - <<'PY'\nimport pandas as pd\ndf.to_parquet('submission.parquet')\nPY",
    "python3 - <<'PY'\nimport subprocess\nsubprocess.run(['kaggle', 'kernels', 'push'])\nPY",
    'python3 analyze.py',
    'cat report.txt > archived.txt',
    'echo hello > notes.txt',
  ];
  for (const command of mutating) {
    const stats = bashStats(command);
    assert.equal(stats.mutatingCalls, 1, `expected mutating: ${command.split('\n')[0]}`);
  }
});

function makeConfig() {
  return {
    routing: { semanticTriage: false, deescalation: {} },
    providers: {
      kimi: { apiKey: 'k', baseUrl: 'http://kimi.test', model: 'kimi-test' },
      deepseek: { apiKey: 'd', baseUrl: 'http://deepseek.test', model: 'deepseek-test' },
    },
  };
}

function writePair(index, { fail = false } = {}) {
  const id = `w${index}`;
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: `/tmp/midturn/f${index}.py` } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: fail ? 'Error: boom' : 'ok', ...(fail ? { is_error: true } : {}) }] },
  ];
}

function driver() {
  const engine = createDecisionEngine(() => makeConfig());
  const messages = [{ role: 'user', content: TASK }];
  let index = 0;
  const addWrites = (n, options = {}) => {
    for (let i = 0; i < n; i += 1) messages.push(...writePair(index++, options));
  };
  const run = async (outcome = 'success') => {
    const r = await engine.resolve({ model: 'auto', stream: true, messages });
    engine.remember(r.decision, r.state);
    engine.observe(r.decision, { outcome });
    return r;
  };
  return { addWrites, run };
}

test('C: a single long turn now de-escalates at a clean 24-tool window', async () => {
  const { addWrites, run } = driver();
  let r = await run();
  assert.equal(r.decision.provider, 'deepseek');

  addWrites(21);
  r = await run();
  assert.equal(r.decision.provider, 'kimi', '20-mutation rule still escalates');
  assert.equal(r.decision.source, 'evidence');

  const sources = [];
  for (let i = 0; i < 20; i += 1) {
    addWrites(3);
    r = await run();
    sources.push(r.decision.source);
  }
  assert.ok(sources.includes('deescalation_probe'), `probe never started: ${sources.join(',')}`);
  assert.ok(sources.includes('probe'), 'probe requests were not served by DeepSeek');
  assert.ok(sources.includes('deescalated'), 'probe never completed');
  assert.equal(r.decision.provider, 'deepseek');
});

test('C: a dirty window blocks the probe and retries 24 calls later', async () => {
  const { addWrites, run } = driver();
  await run();
  addWrites(21);
  await run();

  // 23 clean calls + 1 trailing failure: the checkpoint must not probe.
  await run();
  await run();
  await run();
  addWrites(11);
  await run();
  addWrites(13, { fail: true });
  let r = await run();
  assert.equal(r.decision.provider, 'kimi');
  assert.equal(r.transition?.outcome, 'recovery_blocked');

  // 24 more clean calls: the next checkpoint probes.
  addWrites(24);
  r = await run();
  assert.equal(r.decision.provider, 'deepseek');
  assert.equal(r.decision.source, 'deescalation_probe');
});

test('C: an escalated task still never probes before the backoff is served', async () => {
  const { addWrites, run } = driver();
  await run();
  addWrites(21);
  await run();
  // 24 new calls arrive almost immediately (2 requests), before minKimiRequests=4.
  addWrites(12);
  await run();
  addWrites(12);
  const r = await run();
  assert.equal(r.decision.provider, 'kimi');
  assert.equal(r.decision.source, 'sticky');
});
