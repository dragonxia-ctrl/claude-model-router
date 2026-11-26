import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStatusState } from '../src/status-line.mjs';
import { sessionTag } from '../src/session.mjs';

test('started closes requests the previous process left open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-started-'));
  const logPath = path.join(dir, 'router.log');
  const t0 = Date.parse('2026-11-26T09:00:00.000Z');
  const at = ms => new Date(t0 + ms).toISOString();

  // A request from the previous process never completed, then the router
  // restarted, then two sessions made tagged requests.
  const lines = [
    { event: 'route_decision', time: at(0), requestId: 'orphan', provider: 'deepseek' },
    { event: 'started', time: at(5000) },
    { event: 'route_decision', time: at(10000), requestId: 'a-1', provider: 'deepseek', session: sessionTag('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') },
    { event: 'route_decision', time: at(12000), requestId: 'b-1', provider: 'kimi', session: sessionTag('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') },
  ];
  fs.writeFileSync(logPath, lines.map(line => JSON.stringify(line)).join('\n') + '\n');

  try {
    const now = t0 + 20000;
    const globalView = readStatusState({ logPath, now, session: null });
    assert.deepEqual(globalView.inFlight.map(entry => entry.provider).sort(), ['deepseek', 'kimi'],
      'the orphan is closed by started, the two tagged requests stay open');

    const otherView = readStatusState({
      logPath, now, session: sessionTag('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
    });
    assert.deepEqual(otherView.inFlight, [], 'a session with no requests sees nothing in flight');
    // Cells before the restart keep their real history; nothing is active after it.
    assert.ok(otherView.cells.filter(cell => cell.at >= t0 + 5000).every(cell => cell.model === 'idle'),
      'nothing is active after the restart');

    const aView = readStatusState({
      logPath, now, session: sessionTag('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    });
    assert.deepEqual(aView.inFlight.map(entry => entry.provider), ['deepseek'], 'each session sees only itself');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
