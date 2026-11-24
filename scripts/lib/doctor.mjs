import fs from 'node:fs';
import { loadConfig } from '../../src/config-store.mjs';
import { configPathFor, helperPathFor, manifestPathFor } from './paths.mjs';
import { fileModeWarning, readJsonFile } from './settings.mjs';
import { dockerComposeAvailable } from './docker.mjs';
import { buildHelperCommand } from './install-core.mjs';

export async function collectDoctor({ dataDir, settingsFile, defaultPort = 17861 }) {
  const results = [];
  const add = (status, name, detail = '') => results.push({ status, name, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 20 ? 'ok' : 'fail', 'Node.js', `v${process.versions.node}${major >= 20 ? '' : ' (Node.js 20 or newer is required)'}`);

  let settings = null;
  if (!fs.existsSync(settingsFile)) {
    add('fail', 'Claude settings', `not found: ${settingsFile}`);
  } else {
    try {
      settings = readJsonFile(settingsFile, {});
      add('ok', 'Claude settings', settingsFile);
    } catch (error) {
      add('fail', 'Claude settings', error.message);
    }
  }

  const configPath = configPathFor(dataDir);
  const helperPath = helperPathFor(dataDir);
  let config = null;
  if (!fs.existsSync(configPath)) {
    add('fail', 'Router config', `not found: ${configPath}. Run: npm run setup -- --apply`);
  } else {
    try {
      config = loadConfig(configPath);
      add('ok', 'Router config', configPath);
    } catch (error) {
      add('fail', 'Router config', error.message);
    }
  }

  const port = config?.router?.port || defaultPort;
  if (settings && typeof settings === 'object') {
    add(settings.model === 'auto' ? 'ok' : 'fail', 'Claude model', settings.model === 'auto' ? 'auto' : `expected "auto", found ${JSON.stringify(settings.model)}`);
    const expectedHelper = buildHelperCommand(helperPath);
    add(settings.apiKeyHelper === expectedHelper ? 'ok' : 'fail', 'apiKeyHelper', settings.apiKeyHelper === expectedHelper ? 'generated helper command matches' : 'missing or stale; run setup --apply to regenerate it');
    const base = settings.env?.ANTHROPIC_BASE_URL;
    add(base === `http://127.0.0.1:${port}` ? 'ok' : 'fail', 'Router URL', base === `http://127.0.0.1:${port}` ? base : `expected http://127.0.0.1:${port}, found ${JSON.stringify(base)}`);
    for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
      if (settings.env?.[key]) add('fail', key, 'present in settings.env and would bypass the router; run setup again to remove it');
    }
  }

  if (config) {
    const missing = ['kimi', 'deepseek'].filter(name => !config.providers[name].apiKey.trim());
    add(missing.length ? 'fail' : 'ok', 'Provider keys', missing.length ? `missing: ${missing.join(', ')}` : 'Kimi and DeepSeek configured');
    const warning = fileModeWarning(configPath);
    add(warning ? 'warn' : 'ok', 'Config permissions', warning || 'private');
  }

  add(fs.existsSync(helperPath) ? 'ok' : 'warn', 'Token helper', fs.existsSync(helperPath) ? helperPath : 'missing; run setup --apply');
  add(fs.existsSync(manifestPathFor(dataDir)) ? 'ok' : 'warn', 'Install manifest', fs.existsSync(manifestPathFor(dataDir)) ? 'present (uninstall can restore settings)' : 'missing');

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    const health = await response.json();
    if (!response.ok || !health.ok) throw new Error(`HTTP ${response.status}`);
    add(health.version === 2 ? 'ok' : 'warn', 'Router health', `v${health.version}, revision ${health.revision}, semanticTriage=${health.semanticTriage}`);
    for (const name of ['kimi', 'deepseek']) {
      add(health.providers?.[name]?.configured ? 'ok' : 'fail', `${name} health`, health.providers?.[name]?.configured ? health.providers[name].model : 'not configured');
    }
  } catch (error) {
    add('fail', 'Router health', `cannot reach http://127.0.0.1:${port}/health: ${error.message}`);
  }

  const composeAvailable = await dockerComposeAvailable();
  add(composeAvailable ? 'ok' : 'warn', 'Docker Compose', composeAvailable ? 'available' : 'not available');
  return { results, port, configPath, settingsFile };
}

export function printDoctor(results) {
  for (const result of results) {
    const label = result.status === 'ok' ? 'OK  ' : result.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(`[${label}] ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
  }
}

export async function doctorExitCode(options) {
  const { results } = await collectDoctor(options);
  printDoctor(results);
  return results.some(result => result.status === 'fail') ? 1 : 0;
}
