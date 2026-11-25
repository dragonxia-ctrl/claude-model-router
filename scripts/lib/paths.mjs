import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const COMPOSE_FILE = path.join(REPO_ROOT, 'compose.yaml');
export const PACKAGE_VERSION = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;

export function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

export function defaultDataDir() {
  return expandHome(process.env.CLAUDE_ROUTER_DATA_DIR)
    || path.join(os.homedir(), '.claude', 'model-router');
}

export function defaultSettingsFile() {
  const configDir = expandHome(process.env.CLAUDE_CONFIG_DIR)
    || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'settings.json');
}

export function configPathFor(dataDir) {
  return path.join(dataDir, 'config.json');
}

export function helperPathFor(dataDir) {
  return path.join(dataDir, 'local-token.mjs');
}

export function manifestPathFor(dataDir) {
  return path.join(dataDir, 'install-manifest.json');
}

export function backupsDirFor(dataDir) {
  return path.join(dataDir, 'backups');
}
