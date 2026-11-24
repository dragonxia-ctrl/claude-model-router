import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { normalizeConfig, ROUTING_DEFAULTS } from '../../src/config-store.mjs';
import {
  backupsDirFor, COMPOSE_FILE, configPathFor, helperPathFor, manifestPathFor,
} from './paths.mjs';
import {
  backupFile, ensurePrivateDirectory, hashJson, planSettingsPatch, readJsonFile,
  restoreFileFromBackup, restoreManagedSettings, writeJsonAtomic,
} from './settings.mjs';
import {
  requireDockerCompose, startDockerCompose, stopDockerCompose, waitForHealth,
} from './docker.mjs';

const PROVIDER_DEFAULTS = Object.freeze({
  kimi: { baseUrl: 'https://api.moonshot.cn/anthropic', model: 'kimi-k3.1-pro' },
  deepseek: { baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash' },
});

const HELPER_SOURCE = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configPath = process.env.CLAUDE_ROUTER_CONFIG
  || path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!config?.router?.token) {
  console.error('Claude router token is missing from ' + configPath);
  process.exit(1);
}
process.stdout.write(config.router.token);
`;

function quoteCommandArg(value) {
  if (process.platform === 'win32') return `"${String(value).replaceAll('"', '""')}"`;
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function buildHelperCommand(helperPath = '') {
  return `${quoteCommandArg(process.execPath)} ${quoteCommandArg(helperPath)}`;
}

export function readConfigIfExists(configPath) {
  return readJsonFile(configPath, null);
}

export function buildConfig({ existing = null, providerKeys = {}, port, host, token } = {}) {
  const base = existing || {};
  const baseProviders = base.providers || {};
  const existingToken = base.router?.token;
  const config = {
    router: {
      host: host || base.router?.host || '127.0.0.1',
      port: port || base.router?.port || 17861,
      token: /^[a-f0-9]{32,}$/i.test(existingToken || '') ? existingToken : (token || randomBytes(32).toString('hex')),
    },
    providers: {},
    routing: { ...ROUTING_DEFAULTS, ...(base.routing || {}) },
  };
  for (const name of ['kimi', 'deepseek']) {
    const prior = baseProviders[name] || {};
    config.providers[name] = {
      baseUrl: prior.baseUrl || PROVIDER_DEFAULTS[name].baseUrl,
      model: prior.model || PROVIDER_DEFAULTS[name].model,
      apiKey: (providerKeys[name] || '').trim() || prior.apiKey || '',
    };
  }
  return normalizeConfig(config);
}

export function assertProviderKeys(config) {
  const missing = ['kimi', 'deepseek'].filter(name => !config.providers[name].apiKey.trim());
  if (missing.length) throw new Error(`Missing API key for: ${missing.join(', ')}. Provide it interactively or via CLAUDE_ROUTER_KIMI_KEY / CLAUDE_ROUTER_DEEPSEEK_KEY.`);
}

export function writeConfig({ dataDir, config, now = new Date() }) {
  ensurePrivateDirectory(dataDir);
  const backups = backupsDirFor(dataDir);
  ensurePrivateDirectory(backups);
  const configPath = configPathFor(dataDir);
  const configBackup = backupFile(configPath, backups, 'config', now);
  writeJsonAtomic(configPath, config, { mode: 0o600 });
  return { configPath, configBackup };
}

export function writeTokenHelper(dataDir) {
  const helperPath = helperPathFor(dataDir);
  fs.writeFileSync(helperPath, HELPER_SOURCE, { mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(helperPath, 0o700);
  return helperPath;
}

export async function applyInstall({
  dataDir,
  settingsFile,
  providerKeys = {},
  port,
  host,
  runtime = 'docker',
  start = true,
  now = new Date(),
  hooks = {},
}) {
  const configPath = configPathFor(dataDir);
  const helperPath = helperPathFor(dataDir);
  const manifestPath = manifestPathFor(dataDir);
  const existingConfig = readConfigIfExists(configPath);
  const config = buildConfig({ existing: existingConfig, providerKeys, port, host });
  assertProviderKeys(config);
  const actualPort = config.router.port;

  // Parse every existing file and preflight Docker before the first mutation.
  const settingsExisted = fs.existsSync(settingsFile);
  const currentSettings = settingsExisted ? readJsonFile(settingsFile, {}) : {};
  const priorManifest = readJsonFile(manifestPath, null);
  if (runtime === 'docker' && start) await (hooks.preflight || requireDockerCompose)();

  ensurePrivateDirectory(dataDir);
  const backups = backupsDirFor(dataDir);
  ensurePrivateDirectory(backups);
  const configBackup = backupFile(configPath, backups, 'config', now);
  const helperBackup = backupFile(helperPath, backups, 'local-token', now);
  const settingsBackup = backupFile(settingsFile, backups, 'settings', now);
  const manifestBackup = backupFile(manifestPath, backups, 'install-manifest', now);

  const helperCommand = buildHelperCommand(helperPath);
  const patch = planSettingsPatch(currentSettings, { port: actualPort, helperCommand });
  const manifest = {
    version: 1,
    installedAt: now.toISOString(),
    settingsFile,
    settingsFileExisted: priorManifest?.settingsFileExisted ?? settingsExisted,
    settingsBackup,
    settingsHashAfterInstall: hashJson(patch.next),
    previous: priorManifest?.previous || patch.previous,
    installed: patch.installed,
    runtime,
    dataDir,
    port: actualPort,
    helperPath,
  };

  const startRuntime = hooks.startRuntime || startDockerCompose;
  const stopRuntime = hooks.stopRuntime || stopDockerCompose;
  const checkHealth = hooks.checkHealth || waitForHealth;
  const composeFile = hooks.composeFile || COMPOSE_FILE;
  let startAttempted = false;

  try {
    writeJsonAtomic(configPath, config, { mode: 0o600 });
    writeTokenHelper(dataDir);
    writeJsonAtomic(settingsFile, patch.next, { mode: 0o600 });
    writeJsonAtomic(manifestPath, manifest, { mode: 0o600 });

    if (runtime === 'docker' && start) {
      startAttempted = true;
      await startRuntime({ dataDir, port: actualPort, composeFile });
      await checkHealth({ port: actualPort });
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const [backup, destination] of [
      [settingsBackup, settingsFile],
      [configBackup, configPath],
      [helperBackup, helperPath],
      [manifestBackup, manifestPath],
    ]) {
      try { restoreFileFromBackup(backup, destination); }
      catch (rollbackError) { rollbackErrors.push(`${destination}: ${rollbackError.message}`); }
    }
    if (startAttempted) {
      try { await stopRuntime({ dataDir, port: actualPort, composeFile }); }
      catch (stopError) { rollbackErrors.push(`Docker stop: ${stopError.message}`); }
    }
    const suffix = rollbackErrors.length ? `; rollback warnings: ${rollbackErrors.join('; ')}` : '';
    throw new Error(`Installation rolled back: ${error.message}${suffix}`);
  }

  return {
    configPath,
    settingsFile,
    helperPath,
    manifestPath,
    manifest,
    changes: patch.changes,
    configBackup,
    settingsBackup,
    removedAuth: patch.removedAuth,
  };
}

export function planUninstall({ dataDir, settingsFile }) {
  const manifestPath = manifestPathFor(dataDir);
  const manifest = readJsonFile(manifestPath, null);
  if (!manifest) throw new Error(`No installation manifest found at ${manifestPath}`);
  const settingsExisted = fs.existsSync(manifest.settingsFile || settingsFile);
  const current = settingsExisted ? readJsonFile(manifest.settingsFile || settingsFile, {}) : {};
  const changed = settingsExisted && hashJson(current) !== manifest.settingsHashAfterInstall;
  return { manifest, manifestPath, settingsFile: manifest.settingsFile || settingsFile, current, settingsExisted, changed };
}

export async function applyUninstall({
  dataDir,
  settingsFile,
  force = false,
  now = new Date(),
  hooks = {},
}) {
  const plan = planUninstall({ dataDir, settingsFile });
  if (plan.changed && !force) {
    throw new Error('settings.json changed after installation. Re-run with --force to remove only router-managed keys, or inspect the diff first.');
  }
  const stopRuntime = hooks.stopRuntime || stopDockerCompose;
  const composeFile = hooks.composeFile || COMPOSE_FILE;
  const warnings = [];
  if (plan.manifest.runtime === 'docker') {
    try {
      await stopRuntime({ dataDir, port: plan.manifest.port, composeFile });
    } catch (error) {
      warnings.push(`Could not stop Docker Compose: ${error.message}`);
    }
  }

  const removeSettings = !plan.manifest.settingsFileExisted && !plan.changed;
  if (removeSettings) {
    fs.rmSync(plan.settingsFile, { force: true });
  } else if (plan.settingsExisted) {
    const backups = backupsDirFor(dataDir);
    const backup = backupFile(plan.settingsFile, backups, 'settings-before-uninstall', now);
    const restored = restoreManagedSettings(plan.current, plan.manifest.previous);
    writeJsonAtomic(plan.settingsFile, restored, { mode: 0o600 });
    plan.settingsBackup = backup;
  }
  fs.rmSync(plan.manifestPath, { force: true });
  return { ...plan, warnings };
}

export function updateProviderKeys({ dataDir, providerKeys, port, host, now = new Date() }) {
  const existing = readConfigIfExists(configPathFor(dataDir));
  const config = buildConfig({ existing, providerKeys, port, host });
  assertProviderKeys(config);
  const written = writeConfig({ dataDir, config, now });
  return { config, ...written };
}
