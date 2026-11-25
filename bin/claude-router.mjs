#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { loadConfig } from '../src/config-store.mjs';
import {
  COMPOSE_FILE, PACKAGE_VERSION, REPO_ROOT, configPathFor, defaultDataDir,
  defaultSettingsFile, expandHome, helperPathFor,
} from '../scripts/lib/paths.mjs';
import {
  applyInstall, applyUninstall, assertProviderKeys, buildConfig, buildHelperCommand,
  planUninstall, readConfigIfExists, updateProviderKeys, writeTokenHelper,
} from '../scripts/lib/install-core.mjs';
import {
  dockerComposeAvailable, logsDockerCompose, requireDockerCompose, restartDockerCompose,
  startDockerCompose, stopDockerCompose, waitForHealth,
} from '../scripts/lib/docker.mjs';
import { planSettingsPatch, readJsonFile } from '../scripts/lib/settings.mjs';
import { doctorExitCode } from '../scripts/lib/doctor.mjs';

const PROVIDERS = [
  { name: 'kimi', label: 'Kimi', env: 'CLAUDE_ROUTER_KIMI_KEY' },
  { name: 'deepseek', label: 'DeepSeek', env: 'CLAUDE_ROUTER_DEEPSEEK_KEY' },
];

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const body = arg.slice(2);
    const equals = body.indexOf('=');
    const name = equals === -1 ? body : body.slice(0, equals);
    if (equals !== -1) {
      flags[name] = body.slice(equals + 1);
    } else if (['apply', 'force', 'no-start', 'no-restart', 'allow-root', 'help', 'json', 'yes'].includes(name)) {
      flags[name] = true;
    } else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
      flags[name] = value;
      i += 1;
    }
  }
  return flags;
}

function numberFlag(value, label) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`${label} must be an integer from 1 to 65535`);
  return parsed;
}

function runtimePaths(flags) {
  return {
    dataDir: expandHome(flags['data-dir']) || defaultDataDir(),
    settingsFile: expandHome(flags.settings) || defaultSettingsFile(),
  };
}

async function readSecret(question) {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: false });
    const answer = await rl.question(question);
    rl.close();
    return answer;
  }
  return new Promise((resolve, reject) => {
    let value = '';
    const stdin = process.stdin;
    const wasRaw = Boolean(stdin.isRaw);
    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(new Error('Cancelled'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (char >= ' ') {
          value += char;
          process.stdout.write('*');
        }
      }
    };
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function collectKeys(existingConfig) {
  const keys = {};
  for (const provider of PROVIDERS) {
    const existing = existingConfig?.providers?.[provider.name]?.apiKey || '';
    let value = (process.env[provider.env] || '').trim();
    if (!value && process.stdin.isTTY) {
      const suffix = existing ? ' [Enter to keep existing]' : '';
      value = (await readSecret(`${provider.label} API key${suffix}: `)).trim();
    }
    keys[provider.name] = value || existing;
  }
  return keys;
}

function printHeader(title) {
  console.log(`\nClaude Model Router ${PACKAGE_VERSION}`);
  console.log(`${title}\n`);
}

function printChanges(changes) {
  console.log('Claude Code settings changes:');
  for (const change of changes) console.log(`  - ${change}`);
}

async function installCommand(flags) {
  const { dataDir, settingsFile } = runtimePaths(flags);
  const apply = Boolean(flags.apply);
  const runtime = flags.runtime || 'docker';
  if (!['docker', 'none'].includes(runtime)) throw new Error('--runtime must be "docker" or "none"');
  const start = !flags['no-start'] && runtime === 'docker';
  const portFlag = numberFlag(flags.port, 'Port');
  const host = flags.host;

  if (apply && process.platform !== 'win32' && process.getuid?.() === 0 && !flags['allow-root']) {
    throw new Error('Refusing to install as root. Run as the user who owns Claude Code settings, or pass --allow-root intentionally.');
  }

  const existingConfig = readConfigIfExists(configPathFor(dataDir));
  const currentSettings = fs.existsSync(settingsFile) ? readJsonFile(settingsFile, {}) : {};
  const helperCommand = buildHelperCommand(helperPathFor(dataDir));
  const plannedConfig = buildConfig({
    existing: existingConfig,
    providerKeys: Object.fromEntries(PROVIDERS.map(provider => [provider.name, process.env[provider.env] || ''])),
    port: portFlag,
    host,
  });
  const port = plannedConfig.router.port;
  const patch = planSettingsPatch(currentSettings, { port, helperCommand });
  const missing = PROVIDERS.filter(provider => !plannedConfig.providers[provider.name].apiKey);

  printHeader(apply ? 'Installing' : 'Install plan (dry run — nothing will be written)');
  console.log(`Data directory: ${dataDir}`);
  console.log(`Claude settings: ${settingsFile}`);
  console.log(`Runtime: ${runtime}${start ? ' (will build and start the container)' : ''}`);
  console.log(`Local router: http://127.0.0.1:${port}`);
  console.log(`Provider keys: ${PROVIDERS.map(provider => `${provider.name}=${plannedConfig.providers[provider.name].apiKey ? 'configured' : 'missing'}`).join(', ')}`);
  printChanges(patch.changes);

  if (!apply) {
    if (missing.length) console.log(`\nKeys to provide during --apply: ${missing.map(item => item.name).join(', ')}`);
    console.log('\nNothing was written. Run with --apply to install:');
    console.log('  npm run setup -- --apply');
    return 0;
  }

  const keys = await collectKeys(existingConfig);
  assertProviderKeys(buildConfig({ existing: existingConfig, providerKeys: keys, port, host }));

  const result = await applyInstall({
    dataDir,
    settingsFile,
    providerKeys: keys,
    port,
    host,
    runtime,
    start,
    hooks: { preflight: start ? requireDockerCompose : undefined },
  });

  console.log('\nInstallation complete.');
  console.log(`Config: ${result.configPath}`);
  console.log(`Settings: ${result.settingsFile}`);
  if (result.settingsBackup) console.log(`Settings backup: ${result.settingsBackup}`);
  if (result.configBackup) console.log(`Config backup: ${result.configBackup}`);
  console.log(`Rollback manifest: ${result.manifestPath}`);
  if (start) console.log(`Router health: http://127.0.0.1:${port}/health`);
  console.log('\nRestart Claude Code (terminal, desktop, and IDE sessions) to load the router.');
  console.log('Then run: npm run doctor');
  return 0;
}

async function uninstallCommand(flags) {
  const { dataDir, settingsFile } = runtimePaths(flags);
  const plan = planUninstall({ dataDir, settingsFile });
  printHeader(Boolean(flags.apply) ? 'Uninstalling' : 'Uninstall plan (dry run — nothing will be written)');
  console.log(`Claude settings: ${plan.settingsFile}`);
  console.log(`Rollback manifest: ${plan.manifestPath}`);
  if (plan.changed) console.log('WARNING: settings.json changed after installation. --force will restore only router-managed keys and keep other edits.');
  if (!flags.apply) {
    console.log('\nNothing was written. Re-run with --apply to uninstall:');
    console.log('  node bin/claude-router.mjs uninstall --apply');
    return 0;
  }
  const result = await applyUninstall({ dataDir, settingsFile, force: Boolean(flags.force) });
  console.log('\nUninstall complete. Router-managed settings were restored or removed.');
  for (const warning of result.warnings) console.log(`WARN: ${warning}`);
  console.log('Restart Claude Code to apply the restored settings.');
  return 0;
}

async function configureCommand(flags) {
  const { dataDir } = runtimePaths(flags);
  const configPath = configPathFor(dataDir);
  if (!fs.existsSync(configPath)) throw new Error(`No router config at ${configPath}. Run setup first.`);
  const existing = loadConfig(configPath);
  const keys = await collectKeys(existing);
  const result = updateProviderKeys({ dataDir, providerKeys: keys });
  console.log(`Updated ${result.configPath}`);
  if (!flags['no-restart'] && existing.router && await dockerComposeAvailable()) {
    await restartDockerCompose({ composeFile: COMPOSE_FILE, dataDir, port: result.config.router.port });
    const health = await waitForHealth({ port: result.config.router.port });
    console.log(`Router restarted: revision ${health.revision}`);
  } else {
    console.log('Restart the router process to apply the new keys.');
  }
  return 0;
}

function tokenHelperCommand(flags) {
  const { dataDir } = runtimePaths(flags);
  const configPath = configPathFor(dataDir);
  if (!fs.existsSync(configPath)) throw new Error(`No router config at ${configPath}. Create it before generating the helper.`);
  loadConfig(configPath);
  const helperPath = writeTokenHelper(dataDir);
  console.log(`Token helper: ${helperPath}`);
  console.log(`apiKeyHelper: ${buildHelperCommand(helperPath)}`);
  console.log('Only the helper file was written; Claude settings were not changed.');
  return 0;
}

function loadRuntimeConfig(flags) {
  const { dataDir } = runtimePaths(flags);
  const configPath = configPathFor(dataDir);
  if (!fs.existsSync(configPath)) throw new Error(`No router config at ${configPath}. Run setup first.`);
  return { dataDir, config: loadConfig(configPath) };
}

async function statusCommand(flags) {
  const { config } = loadRuntimeConfig(flags);
  const port = config.router.port;
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) });
  const health = await response.json();
  if (flags.json) console.log(JSON.stringify(health, null, 2));
  else {
    console.log(`Router: ${response.ok && health.ok ? 'healthy' : 'unhealthy'}`);
    console.log(`Version: ${health.version}, revision: ${health.revision}, semantic triage: ${health.semanticTriage}`);
    for (const [name, provider] of Object.entries(health.providers || {})) {
      console.log(`${name}: ${provider.model} (${provider.configured ? 'configured' : 'missing key'})`);
    }
  }
  return response.ok && health.ok ? 0 : 1;
}

async function restartCommand(flags) {
  const { dataDir, config } = loadRuntimeConfig(flags);
  await restartDockerCompose({ composeFile: COMPOSE_FILE, dataDir, port: config.router.port });
  const health = await waitForHealth({ port: config.router.port });
  console.log(`Router restarted: revision ${health.revision}`);
  return 0;
}

async function deployCommand(flags) {
  const { dataDir, config } = loadRuntimeConfig(flags);
  await startDockerCompose({ composeFile: COMPOSE_FILE, dataDir, port: config.router.port });
  const health = await waitForHealth({ port: config.router.port });
  console.log(`Router is healthy: revision ${health.revision}`);
  return 0;
}

async function stopCommand(flags) {
  const { dataDir, config } = loadRuntimeConfig(flags);
  await stopDockerCompose({ composeFile: COMPOSE_FILE, dataDir, port: config.router.port });
  console.log('Router container stopped.');
  return 0;
}

async function logsCommand(flags) {
  const { dataDir, config } = loadRuntimeConfig(flags);
  await logsDockerCompose({ composeFile: COMPOSE_FILE, dataDir, port: config.router.port, tail: Number(flags.tail) || 100 });
  return 0;
}

function runNode(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env, cwd: REPO_ROOT, windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Command exited with code ${code}`)));
  });
}

async function testCommand() {
  await runNode(['--test', path.join(REPO_ROOT, 'test', 'run.mjs')]);
  return 0;
}

async function verifyCommand(flags, live = false) {
  const { dataDir, config } = loadRuntimeConfig(flags);
  const script = path.join(REPO_ROOT, 'scripts', live ? 'verify-live.mjs' : 'verify-deployment.mjs');
  const env = { ...process.env, CLAUDE_ROUTER_CONFIG: configPathFor(dataDir), CLAUDE_ROUTER_PORT: String(config.router.port) };
  const args = [script];
  if (flags.yes) args.push('--yes');
  await runNode(args, env);
  return 0;
}

async function versionCommand(flags) {
  if (flags.json) console.log(JSON.stringify({ cli: PACKAGE_VERSION }, null, 2));
  else console.log(`CLI: ${PACKAGE_VERSION}`);
  const { config } = loadRuntimeConfig(flags);
  const port = config.router.port;
  const response = await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(4000) });
  const info = await response.json();
  if (flags.json) console.log(JSON.stringify(info, null, 2));
  else {
    const status = info.status === 'available' ? `update available: ${info.latest}`
      : info.status === 'ahead' ? 'ahead of the latest release'
        : info.status === 'current' ? 'up to date' : 'latest release unknown';
    console.log(`Running: ${info.current}`);
    console.log(`Latest: ${info.latest || 'unknown'}`);
    console.log(`Status: ${status}`);
    console.log(`Last checked: ${info.checkedAt || 'never'}`);
  }
  return 0;
}

function help() {
  console.log(`Claude Model Router ${PACKAGE_VERSION}

Usage:
  claude-router <command> [options]

Commands:
  install          Show a safe dry-run install plan (alias: setup)
  install --apply  Write config, patch settings with backups, start Docker
  uninstall        Show a dry-run uninstall plan
  uninstall --apply  Stop router and restore router-managed Claude settings
  configure        Update provider API keys and restart the container
  token-helper     Generate only the local token helper; do not change settings
  status           Show router health
  version          Show CLI and running router version plus the latest release
  doctor           Check Node, config, settings, helper, Docker, and router health
  deploy           Build and start the Docker container
  restart          Restart the Docker container
  stop             Stop the Docker container
  logs             Show recent container logs
  test             Run the offline test suite
  verify           Health check plus one real model request
  verify-live      Comprehensive real-provider tests (opt-in, costs tokens)

Common options:
  --data-dir <path>   Configuration directory (default: ~/.claude/model-router)
  --settings <path>   Claude settings.json (default: ~/.claude/settings.json)
  --runtime <name>    docker (default) or none (manual Node runtime)
  --port <number>     Local router port (default: 17861)
  --help              Show this help

Safety: install and uninstall are dry runs unless --apply is passed.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv.shift() || 'help';
  const flags = parseFlags(argv);
  if (flags.help || command === 'help' || command === '--help' || command === '-h') {
    help();
    return 0;
  }
  switch (command) {
    case 'install': case 'setup': return installCommand(flags);
    case 'uninstall': return uninstallCommand(flags);
    case 'configure': return configureCommand(flags);
    case 'token-helper': return tokenHelperCommand(flags);
    case 'status': return statusCommand(flags);
    case 'doctor': {
      const { dataDir, settingsFile } = runtimePaths(flags);
      return doctorExitCode({ dataDir, settingsFile });
    }
    case 'deploy': return deployCommand(flags);
    case 'restart': return restartCommand(flags);
    case 'stop': return stopCommand(flags);
    case 'logs': return logsCommand(flags);
    case 'test': return testCommand();
    case 'verify': return verifyCommand(flags, false);
    case 'verify-live': return verifyCommand(flags, true);
    case 'version': return versionCommand(flags);
    default:
      help();
      return 2;
  }
}

main().then(code => { process.exitCode = code || 0; }).catch(error => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
