import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repository, 'bin', 'claude-router.mjs');

test('install defaults to a dry run and writes nothing', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-router-cli-'));
  const dataDir = path.join(root, 'data');
  const settings = path.join(root, 'settings.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = execFileSync(process.execPath, [
    cli, 'install', '--runtime', 'none', '--data-dir', dataDir, '--settings', settings,
  ], { encoding: 'utf8' });
  assert.match(output, /dry run/i);
  assert.match(output, /Nothing was written/);
  assert.equal(fs.existsSync(dataDir), false);
  assert.equal(fs.existsSync(settings), false);
});

test('token-helper writes only the helper and leaves Claude settings untouched', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-router-helper-'));
  const dataDir = path.join(root, 'data');
  const settings = path.join(root, 'settings.json');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    router: { host: '127.0.0.1', port: 17861, token: 'a'.repeat(64) },
    providers: {
      kimi: { baseUrl: 'https://kimi.invalid', model: 'kimi', apiKey: 'dummy-kimi' },
      deepseek: { baseUrl: 'https://deepseek.invalid', model: 'deepseek', apiKey: 'dummy-deepseek' },
    },
  }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = execFileSync(process.execPath, [cli, 'token-helper', '--data-dir', dataDir], { encoding: 'utf8' });
  assert.match(output, /apiKeyHelper:/);
  assert.match(output, /settings were not changed/);
  assert.equal(fs.existsSync(path.join(dataDir, 'local-token.mjs')), true);
  assert.equal(fs.existsSync(settings), false);
});

test('help exposes the safety model and commands', () => {
  const output = execFileSync(process.execPath, [cli, 'help'], { encoding: 'utf8' });
  assert.match(output, /install --apply/);
  assert.match(output, /dry runs unless --apply/);
  assert.match(output, /verify-live/);
});
