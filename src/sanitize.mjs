export function sanitizeForProvider(body, previousProvider, nextProvider) {
  const copy = structuredClone(body);
  const switched = previousProvider && previousProvider !== nextProvider;
  if (!switched && nextProvider !== 'deepseek') return copy;
  for (const message of copy.messages || []) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    message.content = message.content.filter(block => {
      if (block?.type === 'redacted_thinking') return false;
      if (block?.type === 'thinking' && switched) return false;
      return true;
    });
    if (!message.content.length) {
      message.content = [{ type: 'text', text: '[Prior reasoning omitted during provider routing.]' }];
    }
    if (switched && nextProvider === 'deepseek') {
      // DeepSeek thinking models can reject replayed assistant turns that carry
      // no reasoning content. A non-empty placeholder is the workaround used by
      // OmniRoute for this same deepseek-flash 400 (issue #20260). The synthetic
      // value is never persisted into the client conversation.
      message.content.unshift({ type: 'thinking', thinking: ' ', signature: '' });
    }
  }
  return copy;
}
