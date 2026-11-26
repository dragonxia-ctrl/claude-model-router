// Replay a router.log through the v3 routing rule and regenerate data/v2-v3.json.
// No request bodies are read: the replay uses route_decision (provider, source,
// stream flag) plus request_complete token usage. No prompts or file contents.
//
//   node docs/versions/replay-v3.mjs [router.log]
//   node docs/versions/replay-v3.mjs --from 2026-11-25T13:02:29Z --to 2026-11-25T16:40:00Z
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const logPath = args.find(a => !a.startsWith('--'))
  || path.join(os.homedir(), '.claude', 'model-router', 'router.log');
const from = option('--from', '2026-11-25T13:02:29');
const to = option('--to', '2026-11-25T16:40');
const outPath = option('--out', path.join(here, 'data', 'v2-v3.json'));

const events = fs.readFileSync(logPath, 'utf8').trim().split('\n')
  .map(line => { try { return JSON.parse(line); } catch { return null; } })
  .filter(Boolean);
const decisions = new Map();
const completions = new Map();
for (const event of events) {
  if (event.event === 'route_decision') decisions.set(event.requestId, event);
  if (event.event === 'request_complete') completions.set(event.requestId, event);
}

const rows = [...decisions.values()]
  .filter(e => e.time >= from && e.time <= to)
  .sort((a, b) => a.time.localeCompare(b.time));
if (!rows.length) throw new Error(`No route_decision entries between ${from} and ${to} in ${logPath}`);

const total = { requests: 0, tokens: 0, kimiRequests: 0, kimiTokens: 0, v3KimiRequests: 0, v3KimiTokens: 0 };
const channels = {};
for (const event of rows) {
  const usage = completions.get(event.requestId)?.usage;
  const tokens = usage
    ? (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_read_input_tokens || 0)
    : 0;
  const key = event.conversationKey ? event.conversationKey.slice(0, 10) : 'none';
  const interactive = event.stream === true;
  // v3: only interactive (streaming) requests use benchmark text heuristics and
  // semantic triage. Explicit model selection still wins; v2 had no media
  // detection, so every "video input is Kimi-only" reason was a text match.
  const staysOnKimi = event.provider === 'kimi' && (interactive || event.source === 'explicit');
  const channel = (channels[key] ??= {
    key, requests: 0, kimiRequests: 0, tokens: 0, kimiTokens: 0,
    v3KimiRequests: 0, v3KimiTokens: 0, interactive, sources: {},
    firstAt: event.time, lastAt: event.time,
  });
  channel.requests += 1;
  channel.tokens += tokens;
  channel.sources[event.source] = (channel.sources[event.source] || 0) + 1;
  channel.lastAt = event.time;
  if (event.provider === 'kimi') { channel.kimiRequests += 1; channel.kimiTokens += tokens; }
  if (staysOnKimi) { channel.v3KimiRequests += 1; channel.v3KimiTokens += tokens; }
  total.requests += 1;
  total.tokens += tokens;
  if (event.provider === 'kimi') { total.kimiRequests += 1; total.kimiTokens += tokens; }
  if (staysOnKimi) { total.v3KimiRequests += 1; total.v3KimiTokens += tokens; }
}

const share = (part, whole) => Math.round((1000 * part) / Math.max(1, whole)) / 10;
const output = {
  generatedAt: new Date().toISOString(),
  experiment: 'v2 vs v3 routing on the live 2026-11-25 session window (router.log replay, no request bodies)',
  method: 'Each logged route_decision is re-classified with the v3 rule: non-streaming requests keep the default provider (explicit selection and real media still win); streaming decisions are unchanged. Token totals come from request_complete usage (input + output + cache reads).',
  window: { from: rows[0].time, to: rows.at(-1).time },
  totals: {
    requests: total.requests,
    tokens: total.tokens,
    v2: {
      kimiRequests: total.kimiRequests,
      kimiTokens: total.kimiTokens,
      requestShare: share(total.kimiRequests, total.requests),
      tokenShare: share(total.kimiTokens, total.tokens),
    },
    v3: {
      kimiRequests: total.v3KimiRequests,
      kimiTokens: total.v3KimiTokens,
      requestShare: share(total.v3KimiRequests, total.requests),
      tokenShare: share(total.v3KimiTokens, total.tokens),
    },
  },
  channels: Object.values(channels)
    .sort((a, b) => b.tokens - a.tokens)
    .map(channel => ({ ...channel, interactive: channel.interactive === true })),
};

fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`wrote ${path.relative(process.cwd(), outPath)}: ${output.totals.requests} requests, `
  + `Kimi tokens ${output.totals.v2.tokenShare}% → ${output.totals.v3.tokenShare}%`);
