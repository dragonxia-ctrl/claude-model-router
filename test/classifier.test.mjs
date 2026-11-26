import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRequest } from '../src/classifier.mjs';
import { sanitizeForProvider } from '../src/sanitize.mjs';

const request = (text, extra = {}) => ({ model: 'auto', stream: true, messages: [{ role: 'user', content: text }], ...extra });
const tools = (count, mutating = false) => {
  const messages = [{ role: 'user', content: '修改一个函数' }];
  for (let i = 0; i < count; i++) {
    const name = mutating ? 'Edit' : 'Read';
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name, input: { file_path: `f${i}.js` } }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] });
  }
  return { model: 'auto', messages };
};

test('routine and complex-sounding coding stay on DeepSeek', () => {
  for (const text of ['你好', '翻译这句话', '请进行架构设计', '重构整个模块', '修复这个报错', '设计分布式系统', '为 Kaggle 表格竞赛设计交叉验证和特征工程方案', '用 5 折交叉验证比较模型表现并分析分数波动', '训练一个端到端的深度学习模型并做交叉验证', 'Kaggle 环境搭建与数据预处理', '多阶段训练一个推荐模型', '设计一个完整的分布式系统']) {
    assert.equal(classifyRequest(request(text)).provider, 'deepseek', text);
  }
});

test('only demonstrated Kimi advantage categories switch', () => {
  for (const text of ['自主完成一个端到端完整项目', '从零构建一个端到端应用并交付', '做深度研究并交叉验证来源', '核对多个来源，交叉验证关键数据后撰写调查报告', '完成竞赛数学证明', '分析这个复杂图表的视觉推理']) {
    assert.equal(classifyRequest(request(text)).provider, 'kimi', text);
  }
});

test('text mentions of video are not a capability requirement', () => {
  for (const text of ['分析这个 mp4 视频', 'how do I analyze video understanding benchmarks', '整理 .mov 文件名列表']) {
    const decision = classifyRequest(request(text));
    assert.equal(decision.provider, 'deepseek', text);
    assert.equal(decision.hardCapability, false, text);
    assert.deepEqual(decision.media, { video: false, image: false });
  }
});

test('a video block is a hard capability even without matching words', () => {
  const body = request('处理这个附件', {
    messages: [{ role: 'user', content: [
      { type: 'text', text: '处理这个附件' },
      { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: 'AAAA' } },
    ] }],
  });
  const decision = classifyRequest(body);
  assert.equal(decision.provider, 'kimi');
  assert.equal(decision.hardCapability, true);
  assert.deepEqual(decision.media, { video: true, image: false });
});

test('an image block alone does not hard-lock routing', () => {
  const body = request('这个截图里的报错怎么修', {
    messages: [{ role: 'user', content: [
      { type: 'text', text: '这个截图里的报错怎么修' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ] }],
  });
  const decision = classifyRequest(body);
  assert.equal(decision.provider, 'deepseek');
  assert.equal(decision.hardCapability, false);
  assert.deepEqual(decision.media, { video: false, image: true });
});

test('non-streaming auxiliary calls keep the default provider', () => {
  for (const stream of [false, undefined]) {
    const auxiliary = classifyRequest(request('自主完成一个端到端完整项目', { stream }));
    assert.equal(auxiliary.provider, 'deepseek', String(stream));
    assert.equal(auxiliary.interactive, false, String(stream));
    assert.equal(auxiliary.triageCandidate, false, String(stream));
  }
  assert.equal(classifyRequest(request('自主完成一个端到端完整项目', { stream: true })).provider, 'kimi');
});

test('read-only work never escalates; long mutation sequences do', () => {
  assert.equal(classifyRequest(tools(30)).provider, 'deepseek');
  assert.equal(classifyRequest(tools(19, true)).provider, 'deepseek');
  assert.equal(classifyRequest(tools(20, true)).provider, 'kimi');
});

test('follow-up inherits the current task', () => {
  const body = { model: 'auto', stream: true, messages: [
    { role: 'user', content: '自主完成一个端到端完整项目' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '继续' },
  ] };
  assert.equal(classifyRequest(body).provider, 'kimi');
});

test('repeated follow-ups retain the last substantive task', () => {
  const body = { model: 'auto', stream: true, messages: [
    { role: 'user', content: '自主完成一个端到端完整项目' },
    { role: 'assistant', content: '第一阶段完成' },
    { role: 'user', content: '继续' },
    { role: 'assistant', content: '第二阶段完成' },
    { role: 'user', content: '请继续' },
  ] };
  assert.equal(classifyRequest(body).provider, 'kimi');
});

test('explicit model choice wins', () => {
  assert.equal(classifyRequest(request('你好', { model: 'kimi-k3.1-pro' })).provider, 'kimi');
  assert.equal(classifyRequest(request('自主完成完整项目', { model: 'deepseek-flash' })).provider, 'deepseek');
});

test('provider switch strips incompatible thinking and adds a DeepSeek reasoning placeholder', () => {
  const body = { messages: [{ role: 'assistant', content: [
    { type: 'thinking', thinking: 'reasoning', signature: 'sig' },
    { type: 'redacted_thinking', data: 'opaque' },
    { type: 'text', text: 'answer' },
  ] }] };
  assert.equal(sanitizeForProvider(body, 'kimi', 'kimi').messages[0].content.length, 3);
  const switched = sanitizeForProvider(body, 'kimi', 'deepseek');
  assert.deepEqual(switched.messages[0].content, [
    { type: 'thinking', thinking: ' ', signature: '' },
    { type: 'text', text: 'answer' },
  ]);
  const unchanged = sanitizeForProvider(body, 'deepseek', 'deepseek');
  assert.equal(unchanged.messages[0].content[0].thinking, 'reasoning');
});
