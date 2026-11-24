import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
const FOLLOW_UP = /^(?:继续|接着(?:做|说)?|请继续|按(?:这个|此)方案(?:执行|做)?|开始吧|执行吧|做吧|可以|好的?|是的?|没问题|嗯+|对|继续执行|go ahead|continue|proceed|yes|yep|ok(?:ay)?|sure|sounds good|do it|start)[\s。！!。.?？]*$/i;
const DEICTIC = /^(?:这个|那个|它|上述|上面|这里|刚才|结果|然后|为什么|怎么办|怎么做|this|that|it|above|previous|why|how)(?:呢|的话|问题)?[\s。！!。.?？]*$/i;

function clean(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<local-command-(?:stdout|stderr)>[\s\S]*?<\/local-command-(?:stdout|stderr)>/gi, ' ')
    .replace(/<caveat>[\s\S]*?<\/caveat>/gi, ' ')
    .trim();
}

export function userEntries(messages) {
  const entries = [];
  messages.forEach((message, index) => {
    if (message?.role !== 'user') return;
    const parts = typeof message.content === 'string'
      ? [message.content]
      : Array.isArray(message.content)
        ? message.content.filter(b => b?.type === 'text').map(b => b.text || '')
        : [];
    const text = clean(parts.join('\n'));
    if (text) entries.push({ index, text });
  });
  return entries;
}

export function selectTask(messages) {
  const entries = userEntries(messages);
  if (!entries.length) return { text: '', index: 0, followUp: false };
  const last = entries.at(-1);
  const isFollowUp = entry => FOLLOW_UP.test(entry.text)
    || (entry.text.length <= 24 && DEICTIC.test(entry.text));
  if (isFollowUp(last)) {
    const previous = entries.slice(0, -1).findLast(entry => !isFollowUp(entry));
    if (previous) {
      return { text: `${previous.text}\n${last.text}`, keyText: previous.text, index: previous.index, followUp: true };
    }
  }
  return { ...last, followUp: false };
}

export function segmentStats(messages, startIndex) {
  let toolUses = 0;
  let toolErrors = 0;
  for (const message of messages.slice(startIndex)) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === 'tool_use') toolUses += 1;
      if (block?.type === 'tool_result' && block.is_error) toolErrors += 1;
    }
  }
  return { toolUses, toolErrors };
}
