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
  }
  return copy;
}
