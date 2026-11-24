import { createHash } from 'node:crypto';

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoRead', 'NotebookRead']);
const MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const VERIFY_COMMAND = /^(?:pytest|python3? -m pytest|npm (?:run )?test|pnpm (?:run )?test|yarn (?:run )?test|bun test|go test|cargo test|jest|vitest|rspec|mvn (?:\S+ )*test|gradle(?:w)? test|make test|ctest|ruff check|eslint|tsc(?: --noEmit)?|mypy|pyright)\b/i;
const READ_COMMAND = /^(?:ls|pwd|cat|rg|grep|find|fd|head|tail|wc|stat|file|du|df|git (?:status|diff|log|show|branch|remote|rev-parse)|sed -n|awk|jq|which|type|env|printenv|cd)\b/i;

const signature = value => createHash('sha256').update(value).digest('hex');

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function commandKind(command) {
  const parts = String(command || '').split(/&&|\|\||;/).map(part => part.trim()).filter(Boolean);
  if (parts.length && parts.some(part => VERIFY_COMMAND.test(part))) return 'verification';
  if (parts.length && parts.every(part => READ_COMMAND.test(part) || /^cd\s/.test(part))) return 'read';
  return 'mutating';
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(block => block?.text || '').join(' ');
  return '';
}

function errorGroup(content) {
  return resultText(content)
    .slice(0, 1200)
    .replace(/\b(?:line|column|char)\s+\d+/gi, '<n>')
    .replace(/:\d+(?::\d+)?/g, ':<n>')
    .replace(/\b\d{2,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function analyzeProgress(messages, startIndex) {
  const uses = new Map();
  const invocationCounts = new Map();
  const errorCounts = new Map();
  const files = new Set();
  let toolCalls = 0;
  let readOnlyCalls = 0;
  let mutatingCalls = 0;
  let verificationCalls = 0;
  let failedResults = 0;
  let failedVerifications = 0;
  let successfulMutations = 0;
  let consecutiveFailures = 0;
  let maxConsecutiveFailures = 0;
  let maxInvocationRepeats = 0;

  for (const message of messages.slice(startIndex)) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (block?.type === 'tool_use') {
        toolCalls += 1;
        const input = block.input || {};
        const kind = block.name === 'Bash' ? commandKind(input.command)
          : READ_TOOLS.has(block.name) ? 'read'
          : MUTATING_TOOLS.has(block.name) ? 'mutating'
          : 'other';
        if (kind === 'read') readOnlyCalls += 1;
        if (kind === 'mutating') {
          mutatingCalls += 1;
          const repeated = (invocationCounts.get(signature(`${block.name}:${canonical(input)}`)) || 0) + 1;
          invocationCounts.set(signature(`${block.name}:${canonical(input)}`), repeated);
          if (repeated > maxInvocationRepeats) maxInvocationRepeats = repeated;
        }
        if (kind === 'verification') verificationCalls += 1;
        for (const key of ['file_path', 'path', 'notebook_path']) {
          if (typeof input[key] === 'string') files.add(input[key]);
        }
        uses.set(block.id, { kind, name: block.name });
      }
      if (block?.type === 'tool_result') {
        const use = uses.get(block.tool_use_id);
        const failed = Boolean(block.is_error);
        if (failed) {
          failedResults += 1;
          consecutiveFailures += 1;
          maxConsecutiveFailures = Math.max(maxConsecutiveFailures, consecutiveFailures);
          const group = errorGroup(block.content);
          if (group) errorCounts.set(group, (errorCounts.get(group) || 0) + 1);
          if (use?.kind === 'verification' && successfulMutations > 0) failedVerifications += 1;
        } else {
          consecutiveFailures = 0;
          if (use?.kind === 'mutating') successfulMutations += 1;
        }
      }
    }
  }

  return {
    toolCalls, readOnlyCalls, mutatingCalls, verificationCalls,
    failedResults, failedVerifications, successfulMutations,
    maxConsecutiveFailures, maxInvocationRepeats,
    repeatedErrorGroups: [...errorCounts.values()].filter(count => count >= 2).length,
    filesTouched: files.size,
  };
}

export function progressEscalations(stats, limits = {}) {
  const thresholds = {
    failedVerifications: 2,
    repeatedErrorGroups: 2,
    maxConsecutiveFailures: 3,
    mutatingCalls: 20,
    repeatedMutatingCalls: 3,
    ...limits,
  };
  const reasons = [];
  if (stats.failedVerifications >= thresholds.failedVerifications) {
    reasons.push(`${stats.failedVerifications} failed verification cycles after edits`);
  }
  if (stats.repeatedErrorGroups >= thresholds.repeatedErrorGroups) {
    reasons.push(`${stats.repeatedErrorGroups} repeated error signatures`);
  }
  if (stats.maxConsecutiveFailures >= thresholds.maxConsecutiveFailures) {
    reasons.push(`${stats.maxConsecutiveFailures} consecutive tool failures`);
  }
  if (stats.mutatingCalls >= thresholds.mutatingCalls) {
    reasons.push(`${stats.mutatingCalls} mutating tool calls: long-horizon execution`);
  }
  if (stats.maxInvocationRepeats >= thresholds.repeatedMutatingCalls) {
    reasons.push(`same mutating invocation repeated ${stats.maxInvocationRepeats} times`);
  }
  return reasons;
}
