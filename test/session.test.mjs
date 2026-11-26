import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionIdFrom, sessionTag, sessionTagFor } from '../src/session.mjs';

test('the request header identifies the session', () => {
  assert.equal(sessionIdFrom({ 'x-claude-code-session-id': 'abc-123' }, null), 'abc-123');
  assert.equal(sessionTagFor({ 'x-claude-code-session-id': 'abc-123' }, null), sessionTag('abc-123'));
});

test('metadata.user_id JSON carries the same session id', () => {
  const metadata = {
    user_id: JSON.stringify({ device_id: 'device', account_uuid: '', session_id: 'session-uuid' }),
  };
  assert.equal(sessionIdFrom({}, metadata), 'session-uuid');
  assert.equal(sessionTagFor({}, metadata), sessionTag('session-uuid'));
});

test('the legacy user_id delimiter form still yields a session id', () => {
  const id = '0a4e58c7-46fb-4057-bee2-fa677ea6928c';
  assert.equal(sessionIdFrom({}, { user_id: `user_abc_account_def_session_${id}` }), id);
});

test('missing identifiers produce no tag', () => {
  assert.equal(sessionIdFrom({}, null), null);
  assert.equal(sessionIdFrom({}, { user_id: 'audit-test' }), null);
  assert.equal(sessionTag(null), null);
  assert.equal(sessionTag(''), null);
  assert.equal(sessionTagFor({}, { user_id: 'audit-test' }), null);
});

test('session tags are short, stable, and do not contain the uuid', () => {
  const a = sessionTag('session-a');
  assert.equal(a, sessionTag('session-a'));
  assert.match(a, /^[a-f0-9]{16}$/);
  assert.notEqual(a, sessionTag('session-b'));
  assert.ok(!a.includes('session'));
});
