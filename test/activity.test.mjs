import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivity, ingestLines, STALE_OPEN_MS } from '../src/activity.mjs';

const at = value => Date.parse(value);

function route(activity, id, provider, time) {
  return activity.ingest({ event: 'route_decision', requestId: id, provider, time });
}

function complete(activity, id, durationMs, purpose = 'main') {
  return activity.ingest({ event: 'request_complete', requestId: id, durationMs, purpose });
}

test('a request is active from its start until its completion', () => {
  const activity = createActivity();
  route(activity, 'r1', 'kimi', '2026-11-26T08:00:00.000Z');
  complete(activity, 'r1', 5000);
  assert.equal(activity.stateAt(at('2026-11-26T08:00:00.000Z')), 'kimi');
  assert.equal(activity.stateAt(at('2026-11-26T08:00:04.999Z')), 'kimi');
  assert.equal(activity.stateAt(at('2026-11-26T08:00:05.000Z')), 'idle');
  assert.equal(activity.stateAt(at('2026-11-26T08:00:06.000Z')), 'idle');
});

test('the most recently started request wins and the older one resumes', () => {
  const activity = createActivity();
  route(activity, 'long', 'deepseek', '2026-11-26T08:00:00.000Z');
  route(activity, 'short', 'kimi', '2026-11-26T08:00:10.000Z');
  complete(activity, 'long', 60000);
  complete(activity, 'short', 5000);
  assert.equal(activity.stateAt(at('2026-11-26T08:00:12.000Z')), 'kimi');
  assert.equal(activity.stateAt(at('2026-11-26T08:00:20.000Z')), 'deepseek');
  assert.equal(activity.stateAt(at('2026-11-26T08:01:01.000Z')), 'idle');
});

test('auxiliary requests never count as model work', () => {
  const activity = createActivity();
  route(activity, 'count', 'deepseek', '2026-11-26T08:00:00.000Z');
  complete(activity, 'count', 800, 'count_tokens');
  assert.equal(activity.stateAt(at('2026-11-26T08:00:00.200Z')), 'idle');
});

test('completions without a matching route decision are ignored', () => {
  const activity = createActivity();
  assert.equal(complete(activity, 'ghost', 1000), false);
  assert.equal(activity.size, 0);
  assert.equal(activity.stateAt(at('2026-11-26T08:00:01.000Z')), 'idle');
});

test('an open request goes stale instead of staying active forever', () => {
  const activity = createActivity();
  route(activity, 'r1', 'kimi', '2026-11-26T08:00:00.000Z');
  assert.equal(activity.stateAt(at('2026-11-26T08:05:00.000Z')), 'kimi');
  assert.equal(activity.stateAt(at('2026-11-26T08:00:00.000Z') + STALE_OPEN_MS), 'kimi');
  assert.equal(activity.stateAt(at('2026-11-26T08:00:00.000Z') + STALE_OPEN_MS + 1), 'idle');
});

test('a router restart closes requests that never completed', () => {
  const activity = createActivity();
  route(activity, 'r1', 'kimi', '2026-11-26T08:00:00.000Z');
  activity.ingest({ event: 'started' });
  assert.equal(activity.stateAt(at('2026-11-26T08:00:00.000Z')), 'idle');
  assert.equal(activity.inFlight(at('2026-11-26T08:00:01.000Z')).length, 0);
});

test('cells sample backwards from now and keep the given count', () => {
  const activity = createActivity();
  route(activity, 'r1', 'kimi', '2026-11-26T08:00:00.000Z');
  complete(activity, 'r1', 5000);
  const cells = activity.cells({ now: at('2026-11-26T08:00:10.000Z'), cellMs: 2000, count: 5 });
  assert.equal(cells.length, 5);
  assert.equal(cells[0].at, at('2026-11-26T08:00:02.000Z'));
  assert.equal(cells[2].at, at('2026-11-26T08:00:06.000Z'));
  assert.equal(cells[4].at, at('2026-11-26T08:00:10.000Z'));
  assert.deepEqual(cells.map(cell => cell.model), ['kimi', 'kimi', 'idle', 'idle', 'idle']);
});

test('cells do not drift when the refresh clock is off the sampling grid', () => {
  const activity = createActivity();
  route(activity, 'r1', 'kimi', '2026-11-26T08:00:01.900Z');
  complete(activity, 'r1', 300);
  const early = activity.cells({ now: at('2026-11-26T08:00:10.150Z'), cellMs: 2000, count: 5 });
  const late = activity.cells({ now: at('2026-11-26T08:00:11.850Z'), cellMs: 2000, count: 5 });
  assert.deepEqual(early.map(cell => cell.at), late.map(cell => cell.at));
  assert.deepEqual(early.map(cell => cell.model), late.map(cell => cell.model));
  assert.equal(early[4].at, at('2026-11-26T08:00:10.000Z'));
});

test('in-flight requests are newest first and skip auxiliary completions', () => {
  const activity = createActivity();
  route(activity, 'a', 'deepseek', '2026-11-26T08:00:00.000Z');
  route(activity, 'b', 'kimi', '2026-11-26T08:00:05.000Z');
  const open = activity.inFlight(at('2026-11-26T08:00:06.000Z'));
  assert.deepEqual(open.map(item => item.provider), ['kimi', 'deepseek']);
});

test('a session filter drops other sessions but keeps untagged records', () => {
  const activity = createActivity({ session: 'mine' });
  activity.ingest({ event: 'route_decision', requestId: 'other', provider: 'kimi', time: '2026-11-26T08:00:00.000Z', session: 'theirs' });
  activity.ingest({ event: 'route_decision', requestId: 'own', provider: 'deepseek', time: '2026-11-26T08:00:10.000Z', session: 'mine' });
  assert.equal(activity.stateAt(at('2026-11-26T08:00:05.000Z')), 'idle');
  assert.equal(activity.stateAt(at('2026-11-26T08:00:11.000Z')), 'deepseek');
  assert.deepEqual(activity.inFlight(at('2026-11-26T08:00:11.000Z')).map(item => item.provider), ['deepseek']);

  const legacy = createActivity({ session: 'mine' });
  route(legacy, 'untagged', 'kimi', '2026-11-26T08:00:00.000Z');
  assert.equal(legacy.stateAt(at('2026-11-26T08:00:01.000Z')), 'kimi');

  const all = createActivity();
  all.ingest({ event: 'route_decision', requestId: 'x', provider: 'kimi', time: '2026-11-26T08:00:00.000Z', session: 'theirs' });
  assert.equal(all.stateAt(at('2026-11-26T08:00:01.000Z')), 'kimi');
});

test('line ingestion tolerates garbage and ignores other events', () => {
  const activity = createActivity();
  assert.equal(activity.ingestLine('not json'), false);
  assert.equal(activity.ingestLine(''), false);
  assert.equal(activity.ingestLine('{"event":"version_check"}'), false);
  assert.equal(ingestLines(activity, [
    '{"event":"route_decision","time":"2026-11-26T08:00:00.000Z","requestId":"r1","provider":"deepseek"}',
    '',
    'garbage',
  ].join('\n')), 1);
  assert.equal(activity.lastEventAt, at('2026-11-26T08:00:00.000Z'));
});
