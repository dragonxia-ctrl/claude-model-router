#!/usr/bin/env node
// Reproduce the v5 de-escalation measurements from router.log without prompts.
// The replay measures sticky runs and checkpoint opportunities; it does not
// claim that every opportunity would pass the clean-window or upstream probe.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const options = {
  log: path.join(process.env.HOME || '', '.claude', 'model-router', 'router.log'),
  out: null,
  from: null,
  to: null,
  toolWindow: 12,
  requestWindow: 6,
  idleMs: 300_000,
};
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (!arg.startsWith('--') && i === 0) options.log = arg;
  else if (arg === '--out') options.out = args[++i];
  else if (arg === '--from') options.from = args[++i];
  else if (arg === '--to') options.to = args[++i];
  else if (arg === '--tools') options.toolWindow = Number(args[++i]);
  else if (arg === '--requests') options.requestWindow = Number(args[++i]);
  else if (arg === '--idle-ms') options.idleMs = Number(args[++i]);
  else throw new Error(`Unknown argument: ${arg}`);
}

const events = fs.readFileSync(options.log, 'utf8').split('\n').flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const decisions = events.filter(event => event.event === 'route_decision'
  && event.stream === true
  && (!options.from || event.time >= options.from)
  && (!options.to || event.time <= options.to));
const completions = new Map(events.filter(event => event.event === 'request_complete')
  .map(event => [event.requestId, event]));
const conversations = new Map();
for (const event of decisions) {
  const key = event.conversationKey?.slice(0, 10) || 'legacy';
  if (!conversations.has(key)) conversations.set(key, []);
  conversations.get(key).push(event);
}

function opportunities(run, mode) {
  if (!run.length) return [];
  const found = [];
  let toolBase = run[0].stats?.toolCalls || 0;
  let requestBase = 0;
  let timeBase = Date.parse(run[0].time);
  for (let i = 1; i < run.length; i += 1) {
    const event = run[i];
    const tools = (event.stats?.toolCalls || 0) - toolBase;
    const requests = i - requestBase;
    const elapsed = Date.parse(event.time) - timeBase;
    const hit = mode === 'v4'
      ? tools >= 24
      : tools >= options.toolWindow || requests >= options.requestWindow || elapsed >= options.idleMs;
    if (hit) {
      const kind = tools >= (mode === 'v4' ? 24 : options.toolWindow) ? 'tool_window'
        : requests >= options.requestWindow ? 'request_window' : 'idle_window';
      found.push({ index: i, at: event.time, kind, afterRequests: i, afterMs: Date.parse(event.time) - Date.parse(run[0].time) });
      toolBase = event.stats?.toolCalls || 0;
      requestBase = i;
      timeBase = Date.parse(event.time);
    }
  }
  return found;
}

const runs = [];
for (const [conversation, list] of conversations) {
  let i = 0;
  while (i < list.length) {
    if (list[i].source !== 'sticky') { i += 1; continue; }
    let end = i;
    while (end + 1 < list.length && list[end + 1].source === 'sticky') end += 1;
    const run = list.slice(i, end + 1);
    const v4 = opportunities(run, 'v4');
    const v5 = opportunities(run, 'v5');
    runs.push({
      conversation,
      start: run[0].time,
      end: run.at(-1).time,
      requests: run.length,
      durationMs: Date.parse(run.at(-1).time) - Date.parse(run[0].time),
      toolCallsAtStart: run[0].stats?.toolCalls ?? null,
      toolCallsAtEnd: run.at(-1).stats?.toolCalls ?? null,
      toolDelta: (run.at(-1).stats?.toolCalls || 0) - (run[0].stats?.toolCalls || 0),
      v4Checkpoints: v4.length,
      v5Checkpoints: v5.length,
      v5CheckpointKinds: v5.reduce((kinds, point) => ({ ...kinds, [point.kind]: (kinds[point.kind] || 0) + 1 }), {}),
      v5FirstCheckpoint: v5[0] || null,
    });
    i = end + 1;
  }
}
runs.sort((a, b) => b.requests - a.requests || a.start.localeCompare(b.start));

const probes = decisions.filter(event => event.source === 'deescalation_probe').map(event => {
  const complete = completions.get(event.requestId);
  return {
    time: event.time,
    conversation: event.conversationKey?.slice(0, 10) || 'legacy',
    toolCalls: event.stats?.toolCalls ?? null,
    outcome: complete?.outcome || null,
    httpStatus: complete?.httpStatus ?? null,
  };
});
const sum = (items, field) => items.reduce((total, item) => total + item[field], 0);
const result = {
  generatedAt: new Date().toISOString(),
  experiment: 'v4 -> v5 de-escalation checkpoint replay',
  method: 'Interactive route_decision events only. Consecutive sticky events form a run. v4 opportunities use 24 new tool calls; v5 opportunities use 12 new tool calls OR 6 requests OR 5 elapsed minutes. New-user checkpoints, residency, clean-window gates, backoff and actual future provider responses are not simulated. Checkpoint opportunities are therefore not claimed as completed de-escalations.',
  settings: {
    v4: { windowToolCalls: 24 },
    v5: { windowToolCalls: options.toolWindow, windowRequests: options.requestWindow, windowMs: options.idleMs },
  },
  window: { from: decisions[0]?.time || null, to: decisions.at(-1)?.time || null },
  totals: {
    interactiveRequests: decisions.length,
    stickyRequests: sum(runs, 'requests'),
    stickyRuns: runs.length,
    runsWithToolDeltaBelow24: runs.filter(run => run.toolDelta < 24).length,
    runsWithV4Checkpoint: runs.filter(run => run.v4Checkpoints > 0).length,
    runsWithV5Checkpoint: runs.filter(run => run.v5Checkpoints > 0).length,
    v4CheckpointOpportunities: sum(runs, 'v4Checkpoints'),
    v5CheckpointOpportunities: sum(runs, 'v5Checkpoints'),
    v5CheckpointKinds: runs.reduce((kinds, run) => {
      for (const [kind, count] of Object.entries(run.v5CheckpointKinds)) kinds[kind] = (kinds[kind] || 0) + count;
      return kinds;
    }, {}),
    longestStickyRunRequests: Math.max(0, ...runs.map(run => run.requests)),
    longestStickyRunMinutes: Math.round(Math.max(0, ...runs.map(run => run.durationMs)) / 600) / 100,
    probes: probes.length,
    probeHttp400: probes.filter(probe => probe.httpStatus === 400).length,
  },
  probes,
  runs,
};

const text = `${JSON.stringify(result, null, 2)}\n`;
if (options.out) {
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, text);
}
console.log(JSON.stringify({ totals: result.totals, settings: result.settings, out: options.out }, null, 2));
