import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { applyInstall } from '../scripts/lib/install-core.mjs';
import { collectDoctor } from '../scripts/lib/doctor.mjs';

test('doctor validates a healthy install and detects a stale helper command', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-router-doctor-'));
  const dataDir = path.join(root, 'data');
  const settingsFile = path.join(root, 'settings.json');
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      ok: true, version: 2, revision: 1, semanticTriage: true,
      providers: { kimi: { configured: true, model: 'kimi' }, deepseek: { configured: true, model: 'deepseek' } },
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
    fs.rmSync(root, { recursive: true, force: true });
  });
  await applyInstall({
    dataDir, settingsFile, port: server.address().port,
    providerKeys: { kimi: 'dummy-kimi', deepseek: 'dummy-deepseek' },
    runtime: 'none', start: false,
  });

  const healthy = await collectDoctor({ dataDir, settingsFile });
  assert.equal(healthy.results.filter(result => result.status === 'fail').length, 0);
  assert.equal(healthy.results.find(result => result.name === 'apiKeyHelper').status, 'ok');

  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  settings.apiKeyHelper = 'stale-helper';
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  const stale = await collectDoctor({ dataDir, settingsFile });
  assert.equal(stale.results.find(result => result.name === 'apiKeyHelper').status, 'fail');
});
