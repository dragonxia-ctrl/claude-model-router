export function sanitizeForProvider(body, previousProvider, nextProvider) {
  const copy = structuredClone(body);
  const switched = previousProvider && previousProvider !== nextProvider;
  const deepseek = nextProvider === 'deepseek';
  if (!switched && !deepseek) return copy;
  for (const message of copy.messages || []) {
    if (message?.role !== 'assistant') continue;
    if (typeof message.content === 'string') {
      // DeepSeek's thinking mode wants a thinking block on every assistant
      // turn; a client can replay turns as plain strings.
      if (deepseek) {
        message.content = [
          { type: 'thinking', thinking: ' ', signature: '' },
          { type: 'text', text: message.content },
        ];
      }
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    message.content = message.content.filter(block => {
      if (block?.type === 'redacted_thinking') return false;
      if (block?.type === 'thinking' && switched) return false;
      return true;
    });
    if (!message.content.length) {
      message.content = [{ type: 'text', text: '[Prior reasoning omitted during provider routing.]' }];
    }
    // DeepSeek's thinking mode rejects a request (HTTP 400, "content[].thinking
    // ... must be passed back") when any assistant turn — especially a tool_use
    // turn — has no thinking block. Kimi's signatures are not valid for
    // DeepSeek, so after a switch they are replaced by this placeholder. Apply
    // it on every DeepSeek request, not only on a switch: a client can replay
    // plain-string or tool-only turns, and a probe must not fail for this.
    if (deepseek && !message.content.some(block => block?.type === 'thinking')) {
      message.content.unshift({ type: 'thinking', thinking: ' ', signature: '' });
    }
  }
  return copy;
}
