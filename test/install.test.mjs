import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyInstall, applyUninstall, buildConfig, buildHelperCommand,
  planUninstall, readConfigIfExists,
} from '../scripts/lib/install-core.mjs';
import { loadConfig } from '../src/config-store.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-router-install-'));
  const dataDir = path.join(root, 'router');
  const settingsFile = path.join(root, 'claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dataDir, settingsFile };
}

const originalSettings = () => ({
  model: 'claude-opus-5-5',
  apiKeyHelper: 'old-helper',
  env: {
    ANTHROPIC_BASE_URL: 'https://old.example',
    ANTHROPIC_AUTH_TOKEN: 'old-token',
    KEEP_ME: 'yes',
  },
  permissions: { allow: [] },
});

test('install patches only managed settings and keeps a rollback manifest', async t => {
  const { dataDir, settingsFile } = fixture(t);
  fs.writeFileSync(settingsFile, JSON.stringify(originalSettings(), null, 2));
  const result = await applyInstall({
    dataDir, settingsFile, providerKeys: { kimi: 'kimi-test', deepseek: 'deepseek-test' },
    runtime: 'none', start: false,
  });
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(settings.model, 'auto');
  assert.match(settings.apiKeyHelper, /local-token\.mjs/);
  assert.equal(settings.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${result.manifest.port}`);
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(settings.env.KEEP_ME, 'yes');
  assert.deepEqual(settings.permissions, { allow: [] });
  assert.ok(fs.existsSync(result.manifestPath));
  assert.ok(result.settingsBackup && fs.existsSync(result.settingsBackup));
  const config = loadConfig(result.configPath);
  assert.equal(config.providers.kimi.apiKey, 'kimi-test');
  assert.equal(config.providers.deepseek.apiKey, 'deepseek-test');
  assert.equal(config.routing.semanticTriage, true);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(result.configPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(settingsFile).mode & 0o777, 0o600);
  }
});

test('uninstall restores the original managed values and preserves unrelated edits', async t => {
  const { dataDir, settingsFile } = fixture(t);
  fs.writeFileSync(settingsFile, JSON.stringify(originalSettings(), null, 2));
  await applyInstall({
    dataDir, settingsFile, providerKeys: { kimi: 'kimi-test', deepseek: 'deepseek-test' },
    runtime: 'none', start: false,
  });
  const edited = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  edited.theme = 'dark';
  fs.writeFileSync(settingsFile, JSON.stringify(edited, null, 2));
  assert.equal(planUninstall({ dataDir, settingsFile }).changed, true);
  await assert.rejects(() => applyUninstall({ dataDir, settingsFile }), /changed after installation/);
  await applyUninstall({ dataDir, settingsFile, force: true });
  const restored = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(restored.model, 'claude-opus-5-5');
  assert.equal(restored.apiKeyHelper, 'old-helper');
  assert.equal(restored.env.ANTHROPIC_BASE_URL, 'https://old.example');
  assert.equal(restored.env.ANTHROPIC_AUTH_TOKEN, 'old-token');
  assert.equal(restored.env.KEEP_ME, 'yes');
  assert.equal(restored.env.ANTHROPIC_MODEL, undefined);
  assert.equal(restored.theme, 'dark');
  assert.equal(fs.existsSync(path.join(dataDir, 'install-manifest.json')), false);
});

test('failed container startup restores settings and removes the manifest', async t => {
  const { dataDir, settingsFile } = fixture(t);
  const before = JSON.stringify(originalSettings(), null, 2);
  fs.writeFileSync(settingsFile, before);
  await assert.rejects(() => applyInstall({
    dataDir, settingsFile, providerKeys: { kimi: 'kimi-test', deepseek: 'deepseek-test' },
    runtime: 'docker', start: true,
    hooks: {
      preflight: async () => {},
      startRuntime: async () => { throw new Error('simulated docker failure'); },
      stopRuntime: async () => {},
      checkHealth: async () => {},
    },
  }), /Installation rolled back: simulated docker failure/);
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(dataDir, 'install-manifest.json')), false);
});

test('failed first startup removes newly created settings, config, helper, and manifest', async t => {
  const { dataDir, settingsFile } = fixture(t);
  await assert.rejects(() => applyInstall({
    dataDir, settingsFile, providerKeys: { kimi: 'kimi-test', deepseek: 'deepseek-test' },
    runtime: 'docker', start: true,
    hooks: {
      preflight: async () => {},
      startRuntime: async () => { throw new Error('simulated unhealthy container'); },
      stopRuntime: async () => {},
      checkHealth: async () => {},
    },
  }), /Installation rolled back/);
  for (const file of [settingsFile, path.join(dataDir, 'config.json'), path.join(dataDir, 'local-token.mjs'), path.join(dataDir, 'install-manifest.json')]) {
    assert.equal(fs.existsSync(file), false, `${file} should not remain after rollback`);
  }
});

test('Docker preflight failure happens before any file mutation', async t => {
  const { dataDir, settingsFile } = fixture(t);
  const before = JSON.stringify(originalSettings(), null, 2);
  fs.writeFileSync(settingsFile, before);
  await assert.rejects(() => applyInstall({
    dataDir, settingsFile, providerKeys: { kimi: 'kimi-test', deepseek: 'deepseek-test' },
    runtime: 'docker', start: true,
    hooks: { preflight: async () => { throw new Error('Docker unavailable'); } },
  }), /Docker unavailable/);
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), before);
  assert.equal(fs.existsSync(dataDir), false);
});

test('failed upgrade restores the prior config, helper, settings, and manifest', async t => {
  const { dataDir, settingsFile } = fixture(t);
  fs.writeFileSync(settingsFile, JSON.stringify(originalSettings(), null, 2));
  await applyInstall({
    dataDir, settingsFile, providerKeys: { kimi: 'old-kimi', deepseek: 'old-deepseek' },
    runtime: 'none', start: false,
  });
  const files = [settingsFile, path.join(dataDir, 'config.json'), path.join(dataDir, 'local-token.mjs'), path.join(dataDir, 'install-manifest.json')];
  const before = files.map(file => fs.readFileSync(file, 'utf8'));
  await assert.rejects(() => applyInstall({
    dataDir, settingsFile, providerKeys: { kimi: 'new-kimi', deepseek: 'new-deepseek' },
    runtime: 'docker', start: true,
    hooks: {
      preflight: async () => {},
      startRuntime: async () => { throw new Error('upgrade failed'); },
      stopRuntime: async () => {},
      checkHealth: async () => {},
    },
  }), /Installation rolled back: upgrade failed/);
  assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), before);
});

test('settings file created by the installer is removed on clean uninstall', async t => {
  const { dataDir, settingsFile } = fixture(t);
  await applyInstall({
    dataDir, settingsFile, providerKeys: { kimi: 'kimi-test', deepseek: 'deepseek-test' },
    runtime: 'none', start: false,
  });
  assert.ok(fs.existsSync(settingsFile));
  await applyUninstall({ dataDir, settingsFile });
  assert.equal(fs.existsSync(settingsFile), false);
});

test('config builder preserves existing keys and rotates an invalid token', () => {
  const existing = {
    router: { host: '127.0.0.1', port: 17861, token: 'invalid' },
    providers: {
      kimi: { baseUrl: 'https://k.example', model: 'k', apiKey: 'existing-kimi' },
      deepseek: { baseUrl: 'https://d.example', model: 'd', apiKey: 'existing-deepseek' },
    },
  };
  const config = buildConfig({ existing, providerKeys: { kimi: '', deepseek: '' } });
  assert.equal(config.providers.kimi.apiKey, 'existing-kimi');
  assert.match(config.router.token, /^[a-f0-9]{64}$/);
  assert.equal(config.providers.kimi.baseUrl, 'https://k.example');
  assert.ok(buildHelperCommand('/tmp/local-token.mjs').includes('local-token.mjs'));
});

test('missing configuration returns null without throwing', t => {
  const { dataDir } = fixture(t);
  assert.equal(readConfigIfExists(path.join(dataDir, 'config.json')), null);
});
