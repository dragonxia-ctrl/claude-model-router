import fs from 'node:fs';
import path from 'node:path';

export const MANAGED_ENV_KEYS = Object.freeze([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
]);

export const LEGACY_AUTH_ENV_KEYS = Object.freeze([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
]);

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

export function clone(value) {
  return structuredClone(value);
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function hashJson(value) {
  return canonicalJson(value);
}

function capture(object, key) {
  return Object.hasOwn(object, key)
    ? { present: true, value: object[key] }
    : { present: false };
}

export function planSettingsPatch(settings, { port, helperCommand }) {
  if (!isObject(settings)) throw new Error('settings.json must contain a JSON object');
  if (settings.env !== undefined && !isObject(settings.env)) throw new Error('settings.json env must be an object');
  const next = clone(settings);
  const env = { ...(settings.env || {}) };
  const previous = {
    model: capture(settings, 'model'),
    apiKeyHelper: capture(settings, 'apiKeyHelper'),
    env: {},
  };
  const changes = [];

  for (const key of [...MANAGED_ENV_KEYS, ...LEGACY_AUTH_ENV_KEYS]) {
    previous.env[key] = capture(env, key);
  }

  next.model = 'auto';
  next.apiKeyHelper = helperCommand;
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  env.ANTHROPIC_MODEL = 'auto';
  env.ANTHROPIC_DEFAULT_MODEL = 'auto';
  env.ANTHROPIC_SMALL_FAST_MODEL = 'deepseek-flash';

  const removedAuth = [];
  for (const key of LEGACY_AUTH_ENV_KEYS) {
    if (Object.hasOwn(env, key)) {
      removedAuth.push(key);
      delete env[key];
    }
  }
  next.env = env;

  changes.push('model -> auto');
  changes.push('apiKeyHelper -> generated local token helper');
  changes.push(`ANTHROPIC_BASE_URL -> http://127.0.0.1:${port}`);
  changes.push('ANTHROPIC_MODEL -> auto');
  changes.push('ANTHROPIC_DEFAULT_MODEL -> auto');
  changes.push('ANTHROPIC_SMALL_FAST_MODEL -> deepseek-flash');
  for (const key of removedAuth) changes.push(`${key} removed (it would bypass the router)`);

  const installed = {
    model: next.model,
    apiKeyHelper: next.apiKeyHelper,
    env: Object.fromEntries(MANAGED_ENV_KEYS.map(key => [key, env[key]])),
  };

  return { next, previous, installed, changes, removedAuth };
}

export function restoreManagedSettings(settings, previous) {
  if (!isObject(settings)) throw new Error('settings.json must contain a JSON object');
  const next = clone(settings);
  for (const key of ['model', 'apiKeyHelper']) {
    const saved = previous?.[key];
    if (saved?.present) next[key] = saved.value;
    else delete next[key];
  }
  if (isObject(next.env)) {
    for (const [key, saved] of Object.entries(previous?.env || {})) {
      if (saved?.present) next.env[key] = saved.value;
      else delete next.env[key];
    }
    if (Object.keys(next.env).length === 0) delete next.env;
  }
  return next;
}

export function readJsonFile(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Error(`${file}: ${error.message}`);
  }
}

export function writeJsonAtomic(file, value, { mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
    fs.renameSync(temp, file);
  } catch (error) {
    if (process.platform === 'win32' && ['EEXIST', 'EPERM'].includes(error.code) && fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      fs.renameSync(temp, file);
    } else {
      fs.rmSync(temp, { force: true });
      throw error;
    }
  }
}

export function backupFile(file, backupDir, prefix, now = new Date()) {
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupDir, `${prefix}-${stamp}.bak`);
  fs.copyFileSync(file, target);
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
  return target;
}

export function restoreFileFromBackup(backup, destination) {
  if (!backup) {
    fs.rmSync(destination, { force: true });
    return;
  }
  fs.copyFileSync(backup, destination);
  if (process.platform !== 'win32') fs.chmodSync(destination, 0o600);
}

export function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

export function fileModeWarning(file) {
  if (process.platform === 'win32' || !fs.existsSync(file)) return null;
  const mode = fs.statSync(file).mode & 0o777;
  return (mode & 0o077) === 0 ? null : `permissions are ${mode.toString(8)}; run: chmod 600 ${file}`;
}
