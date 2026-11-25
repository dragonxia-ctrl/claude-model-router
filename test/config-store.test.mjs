import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfigStore, loadConfig } from '../src/config-store.mjs';

const valid = () => ({
  router: { host: '127.0.0.1', port: 17861, token: 'a'.repeat(64) },
  providers: {
    deepseek: { baseUrl: 'https://ds.invalid', model: 'ds', apiKey: 'one' },
    kimi: { baseUrl: 'https://k.invalid', model: 'k', apiKey: 'two' },
  },
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'router-config-'));
  const file = path.join(directory, 'config.json');
  fs.writeFileSync(file, JSON.stringify(valid()), { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return file;
}

test('valid config loads and provider-only reload does not require restart', t => {
  const file = fixture(t);
  const store = createConfigStore(file);
  assert.equal(store.revision, 1);
  assert.equal(loadConfig(file).providers.deepseek.model, 'ds');
  const next = valid();
  next.providers.deepseek.model = 'ds-next';
  fs.writeFileSync(file, JSON.stringify(next));
  assert.deepEqual(store.reload(), { ok: true, revision: 2, restartRequired: false });
  assert.equal(store.get().providers.deepseek.model, 'ds-next');
  assert.equal(store.get().revision, 2);
});

test('listener changes are reported and invalid reload preserves active config', t => {
  const file = fixture(t);
  const store = createConfigStore(file);
  const changed = valid();
  changed.router.port = 17862;
  fs.writeFileSync(file, JSON.stringify(changed));
  assert.deepEqual(store.reload(), { ok: true, revision: 2, restartRequired: true });
  const active = store.get();
  fs.writeFileSync(file, '{broken');
  const failed = store.reload();
  assert.equal(failed.ok, false);
  assert.equal(failed.revision, 2);
  assert.match(failed.error, /JSON/);
  assert.equal(store.get(), active);
  assert.equal(store.get().router.port, 17862);
});

test('de-escalation policy validates ranges and backoff consistency', t => {
  const file = fixture(t);
  const next = valid();
  next.routing = {
    deescalation: {
      enabled: true, minKimiRequests: 4, probeRequests: 2, maxAttempts: 3,
      maxBackoffRequests: 32, windowToolCalls: 24, minRecentToolCalls: 4,
      maxFailureRate: 0.1, maxMutationRepeats: 2,
    },
  };
  fs.writeFileSync(file, JSON.stringify(next));
  assert.equal(loadConfig(file).routing.deescalation.minKimiRequests, 4);

  next.routing.deescalation.maxBackoffRequests = 2;
  fs.writeFileSync(file, JSON.stringify(next));
  assert.throws(() => loadConfig(file), /maxBackoffRequests/);

  next.routing.deescalation.maxBackoffRequests = 32;
  next.routing.deescalation.probeRequests = 0;
  fs.writeFileSync(file, JSON.stringify(next));
  assert.throws(() => loadConfig(file), /probeRequests/);

  next.routing.deescalation.probeRequests = 2;
  next.routing.deescalation.maxFailureRate = 1.5;
  fs.writeFileSync(file, JSON.stringify(next));
  assert.throws(() => loadConfig(file), /maxFailureRate/);
});

test('missing providers and short tokens are rejected', t => {
  const file = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ router: { port: 17861, token: 'a'.repeat(64) }, providers: {} }));
  assert.throws(() => loadConfig(file), /Missing provider/);
  const missingToken = valid();
  missingToken.router.token = 'short';
  fs.writeFileSync(file, JSON.stringify(missingToken));
  assert.throws(() => loadConfig(file), /token/);
});
