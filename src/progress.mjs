import { createHash } from 'node:crypto';

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoRead', 'NotebookRead']);
const MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const VERIFY_COMMAND = /^(?:pytest|python3? -m pytest|npm (?:run )?test|pnpm (?:run )?test|yarn (?:run )?test|bun test|go test|cargo test|jest|vitest|rspec|mvn (?:\S+ )*test|gradle(?:w)? test|make test|ctest|ruff check|eslint|tsc(?: --noEmit)?|mypy|pyright)\b/i;
const READ_COMMAND = /^(?:ls|pwd|cat|rg|grep|find|fd|head|tail|wc|stat|file|du|df|echo|printf|true|false|date|whoami|hostname|uname|test|sleep|git (?:status|diff|log|show|branch|remote|rev-parse)|sed -n|awk|jq|which|type|env|printenv|cd)\b/i;
// Read-only API queries that still look like work (Kaggle, package inventories).
const READ_QUERY = /^(?:kaggle\s+(?:kernels?|competitions?)\s+(?:status|list|files|leaderboard|submissions)|pip3?\s+(?:list|show|freeze)|npm\s+(?:ls|list))\b/i;
// Inline Python can be scanned for write operations; a script file cannot.
const PYTHON_HEADER = /^(?:cd\s+[^&;]+&&\s*)?(?:python3?(?:\.\d+)?)(?:\s+--?[A-Za-z][\w-]*)*\s+(?:(?:-\s*)*<<-?\s*['"]?[\w.-]+['"]?|-c\s*['"])/i;
const PYTHON_WRITE = /(?:\.(?:write|write_text|write_bytes|to_csv|to_parquet|to_json|to_excel|to_pickle|savefig|unlink|mkdir|rename|remove|rmdir|dump)\s*\(|open\s*\([^)]*['"][wax+])|os\.(?:remove|unlink|rename|replace|makedirs|mkdir|rmdir|system|popen)|shutil\.|subprocess\.|pip3?\s+install/i;
const SHELL_REDIRECT = /(?:^|\s)\d?>{1,2}\s*(?!&|\|)(?!\/dev\/null)\S/;

function readOnlyInlinePython(text) {
  const header = text.split('\n')[0].trim();
  if (!PYTHON_HEADER.test(header)) return false;
  if (PYTHON_WRITE.test(text)) return false;
  if (SHELL_REDIRECT.test(header)) return false;
  return true;
}

const signature = value => createHash('sha256').update(value).digest('hex');

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function commandKind(command) {
  const text = String(command || '');
  if (readOnlyInlinePython(text)) return 'read';
  const parts = text.split(/&&|\|\||;/).map(part => part.trim()).filter(Boolean);
  if (parts.length && parts.some(part => VERIFY_COMMAND.test(part))) return 'verification';
  if (parts.length && parts.every(part => /^cd\s/.test(part)
    || ((READ_COMMAND.test(part) || READ_QUERY.test(part)) && !SHELL_REDIRECT.test(part)))) return 'read';
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

/**
 * Statistics for the most recent tool activity only.
 *
 * Escalation is cumulative: once a task has demonstrated repeated failure, the
 * fact remains true. De-escalation must not use those cumulative counters, or a
 * recovered task could never leave Kimi. This window can recover.
 */
export function analyzeRecoveryWindow(messages, startIndex, windowToolCalls = 24) {
  const events = [];
  const allUses = new Map();

  for (const message of messages.slice(Math.max(0, startIndex))) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (block?.type === 'tool_use') {
        const input = block.input || {};
        const kind = block.name === 'Bash' ? commandKind(input.command)
          : READ_TOOLS.has(block.name) ? 'read'
          : MUTATING_TOOLS.has(block.name) ? 'mutating'
          : 'other';
        const use = {
          type: 'use', id: block.id, kind, name: block.name,
          signature: kind === 'mutating' ? signature(`${block.name}:${canonical(input)}`) : null,
        };
        allUses.set(block.id, use);
        events.push(use);
      } else if (block?.type === 'tool_result') {
        events.push({
          type: 'result',
          id: block.tool_use_id,
          isError: Boolean(block.is_error),
          group: block.is_error ? errorGroup(block.content) : '',
        });
      }
    }
  }

  const useIndices = [];
  events.forEach((event, index) => { if (event.type === 'use') useIndices.push(index); });
  const firstIndex = useIndices.length > windowToolCalls
    ? useIndices[useIndices.length - windowToolCalls]
    : 0;
  const recent = events.slice(firstIndex);

  let toolCalls = 0;
  let failedResults = 0;
  let failedVerifications = 0;
  let successfulVerifications = 0;
  let successfulMutations = 0;
  let verificationCalls = 0;
  let trailingFailures = 0;
  const mutationCounts = new Map();
  const errorCounts = new Map();

  for (const event of recent) {
    if (event.type === 'use') {
      toolCalls += 1;
      if (event.kind === 'verification') verificationCalls += 1;
      if (event.kind === 'mutating') {
        mutationCounts.set(event.signature, (mutationCounts.get(event.signature) || 0) + 1);
      }
      continue;
    }
    const use = allUses.get(event.id);
    if (event.isError) {
      failedResults += 1;
      trailingFailures += 1;
      if (use?.kind === 'verification') failedVerifications += 1;
      if (event.group) errorCounts.set(event.group, (errorCounts.get(event.group) || 0) + 1);
    } else {
      trailingFailures = 0;
      if (use?.kind === 'verification') successfulVerifications += 1;
      if (use?.kind === 'mutating') successfulMutations += 1;
    }
  }

  return {
    toolCalls,
    failedResults,
    failedVerifications,
    successfulVerifications,
    successfulMutations,
    verificationCalls,
    trailingFailures,
    repeatedErrorGroups: [...errorCounts.values()].filter(count => count >= 2).length,
    maxMutationRepeats: Math.max(0, ...mutationCounts.values()),
    failureRate: toolCalls ? failedResults / toolCalls : 0,
  };
}
