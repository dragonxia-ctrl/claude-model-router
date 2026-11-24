import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRequest } from '../src/classifier.mjs';

function conversation(steps) {
  const messages = [{ role: 'user', content: '修复实现并验证结果' }];
  steps.forEach((step, index) => {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `call-${index}`, name: step.name, input: step.input }] });
    messages.push({ role: 'user', content: [{
      type: 'tool_result', tool_use_id: `call-${index}`,
      content: step.content || 'ok', is_error: Boolean(step.error),
    }] });
  });
  return { model: 'auto', messages };
}

const edit = (path = 'a.js', value = 'next') => ({
  name: 'Edit', input: { file_path: path, old_string: 'old', new_string: value },
});

test('two failed verification cycles after edits escalate', () => {
  const body = conversation([
    edit(), { name: 'Bash', input: { command: 'npm test' }, error: true, content: 'FAIL suite' },
    edit('a.js', 'fixed'), { name: 'Bash', input: { command: 'npm test' }, error: true, content: 'FAIL suite' },
  ]);
  const decision = classifyRequest(body);
  assert.equal(decision.stats.failedVerifications, 2);
  assert.equal(decision.provider, 'kimi');
});

test('one failed test and many reads remain on DeepSeek', () => {
  const steps = Array.from({ length: 30 }, (_, i) => ({ name: 'Read', input: { file_path: `f${i}.js` } }));
  steps.push(edit(), { name: 'Bash', input: { command: 'npm test' }, error: true, content: 'FAIL suite' });
  const decision = classifyRequest(conversation(steps));
  assert.equal(decision.stats.failedVerifications, 1);
  assert.equal(decision.provider, 'deepseek');
});

test('three consecutive real tool errors escalate', () => {
  const body = conversation(Array.from({ length: 3 }, () => ({
    name: 'Bash', input: { command: 'python worker.py' }, error: true, content: 'Connection refused',
  })));
  const decision = classifyRequest(body);
  assert.equal(decision.stats.maxConsecutiveFailures, 3);
  assert.equal(decision.provider, 'kimi');
});

test('repeating the same mutation three times escalates', () => {
  const decision = classifyRequest(conversation([edit(), edit(), edit()]));
  assert.equal(decision.stats.maxInvocationRepeats, 3);
  assert.equal(decision.provider, 'kimi');
});
