import { randomUUID } from 'node:crypto';
import { call, preview, clientConfig, assertModel, textOf } from './lib/live-client.mjs';

if (!process.argv.includes('--yes') && process.env.CLAUDE_ROUTER_LIVE_TESTS !== '1') {
  console.error('Refusing to spend real API tokens. Re-run with --yes or set CLAUDE_ROUTER_LIVE_TESTS=1.');
  process.exit(2);
}

const config = clientConfig();
const runId = randomUUID();
const results = [];
const pass = (name, detail = '') => {
  results.push({ name, ok: true });
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
};
const user = content => [{ role: 'user', content }];
const request = (body, options = {}) => call(body, { ...options, config });
const previewRequest = (body, options = {}) => preview(body, { ...options, config });

const deepseek = await request({ model: config.providers.deepseek.model, messages: user('Reply with exactly DS_OK.') });
assertModel(deepseek, config.providers.deepseek.model);
pass('DeepSeek real API and explicit selection');

const kimi = await request({ model: config.providers.kimi.model, messages: user('Reply with exactly KIMI_OK.') });
assertModel(kimi, config.providers.kimi.model);
pass('Kimi real API and explicit selection');

await request({ model: 'auto', messages: user('Reply with exactly STREAM_OK.') }, { stream: true, query: '?beta=true' });
pass('Automatic DeepSeek routing, streaming, and query compatibility');

const semanticText = '分析一个中等规模 Python 项目里的依赖注入和配置加载逻辑，找出循环依赖、重复初始化和难以测试的耦合点，并给出分步重构建议。';
const previewResult = await previewRequest({ model: 'auto', messages: user(semanticText) });
if (previewResult.source !== 'semantic') throw new Error(`Preview did not use semantic triage: ${JSON.stringify(previewResult)}`);
if (![config.providers.deepseek.model, config.providers.kimi.model].includes(previewResult.model)) {
  throw new Error(`Unexpected preview model: ${previewResult.model}`);
}
pass('Preview endpoint and real semantic triage', `${previewResult.provider}, ${previewResult.model}`);

const semantic = await request({ model: 'auto', messages: user(semanticText) });
if (semantic.router?.source !== 'semantic') throw new Error(`Real semantic triage did not run: ${JSON.stringify(semantic.router)}`);
pass('Routed message after semantic triage', `${semantic.router.provider}, ${semantic.model}`);

const tool = {
  name: 'get_time',
  description: 'Get the current UTC time for a city.',
  input_schema: {
    type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false,
  },
};
const toolPrompt = 'Call get_time exactly once for Paris. After receiving the tool result, reply with the returned time only. Do not answer directly before calling.';
const deepseekToolMetadata = { user_id: `router-live-deepseek-tool-${runId}` };
const toolCall = await request({
  model: config.providers.deepseek.model,
  metadata: deepseekToolMetadata,
  tools: [tool],
  tool_choice: { type: 'auto' },
  messages: user(toolPrompt),
}, { query: '?beta=true' });
const invocation = (toolCall.content || []).find(block => block.type === 'tool_use' && block.name === 'get_time');
if (!invocation) throw new Error(`DeepSeek did not call get_time: ${JSON.stringify(toolCall.content)}`);
pass('DeepSeek tool_use generation');

const toolAnswer = await request({
  model: config.providers.deepseek.model,
  metadata: deepseekToolMetadata,
  tools: [tool],
  tool_choice: { type: 'auto' },
  messages: [
    ...user(toolPrompt),
    { role: 'assistant', content: toolCall.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: invocation.id, content: '{"time":"12:00 UTC"}' }] },
  ],
});
if (!textOf(toolAnswer).includes('12:00')) throw new Error(`DeepSeek tool result was not preserved: ${textOf(toolAnswer)}`);
pass('DeepSeek tool result round-trip');

const kimiToolMetadata = { user_id: `router-live-kimi-tool-${runId}` };
const kimiToolCall = await request({
  model: config.providers.kimi.model,
  metadata: kimiToolMetadata,
  tools: [tool],
  tool_choice: { type: 'auto' },
  messages: user(toolPrompt),
});
const kimiInvocation = (kimiToolCall.content || []).find(block => block.type === 'tool_use' && block.name === 'get_time');
if (!kimiInvocation) throw new Error(`Kimi did not call get_time: ${JSON.stringify(kimiToolCall.content)}`);
pass('Kimi tool_use generation');

const kimiToolAnswer = await request({
  model: config.providers.kimi.model,
  metadata: kimiToolMetadata,
  tools: [tool],
  tool_choice: { type: 'auto' },
  messages: [
    ...user(toolPrompt),
    { role: 'assistant', content: kimiToolCall.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: kimiInvocation.id, content: '{"time":"12:30 UTC"}' }] },
  ],
});
if (!textOf(kimiToolAnswer).includes('12:30')) throw new Error(`Kimi tool result was not preserved: ${textOf(kimiToolAnswer)}`);
pass('Kimi tool result round-trip');

const crossMetadata = { user_id: `router-live-kimi-to-deepseek-${runId}` };
const first = await request({
  model: 'auto',
  metadata: crossMetadata,
  messages: user('自主完成一个端到端完整项目。现在只回答：开始。'),
});
assertModel(first, config.providers.kimi.model);
pass('Automatic Kimi routing for long-horizon task');

const switched = await request({
  model: 'auto',
  metadata: crossMetadata,
  messages: [
    ...user('自主完成一个端到端完整项目。现在只回答：开始。'),
    { role: 'assistant', content: first.content },
    ...user('新任务：只回答 2+2 等于几。'),
  ],
});
assertModel(switched, config.providers.deepseek.model);
pass('Kimi to DeepSeek switch with sanitized context');

await request({ model: config.providers.kimi.model, messages: user('Reply with exactly KIMI_STREAM_OK.') }, { stream: true, query: '?beta=true' });
pass('Kimi streaming and query compatibility');

const reverseMetadata = { user_id: `router-live-deepseek-to-kimi-${runId}` };
const deepseekFirst = await request({
  model: 'auto',
  metadata: reverseMetadata,
  messages: user('只回答：开始。'),
});
assertModel(deepseekFirst, config.providers.deepseek.model);
const switchedToKimi = await request({
  model: 'auto',
  metadata: reverseMetadata,
  messages: [
    ...user('只回答：开始。'),
    { role: 'assistant', content: deepseekFirst.content },
    ...user('新任务：自主完成一个端到端完整项目。现在只回答：开始。'),
  ],
});
assertModel(switchedToKimi, config.providers.kimi.model);
pass('DeepSeek to Kimi switch with sanitized context');

console.log(JSON.stringify({ ok: true, verified: results.length }));
