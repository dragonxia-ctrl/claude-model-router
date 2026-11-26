#!/usr/bin/env node
// Inspect in-memory routing state and schedule an operator-initiated DeepSeek
// recovery probe. Works both from the repository and the flattened manual
// installation, so this file deliberately has no local imports.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export async function controlRequest(config, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${config.router.port}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${config.router.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: { message: text } }; }
  if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`);
  return data;
}

function usage() {
  console.log(`Usage:
  node scripts/router-control.mjs state [--data-dir <dir>] [--json]
  node scripts/router-control.mjs deescalate (--conversation <key> | --all) [--data-dir <dir>]

deescalate schedules a recovery checkpoint for the next main request. The
ordinary clean-window and hard-capability gates still apply. State is in memory
and is cleared when the router restarts.`);
}

function parse(argv) {
  const command = argv.shift();
  const options = { command, dataDir: path.join(os.homedir(), '.claude', 'model-router') };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') options.all = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--data-dir' || arg === '--conversation') {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      const value = argv[++i];
      if (arg === '--data-dir') options.dataDir = value;
      else options.conversation = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

async function main(argv) {
  const options = parse(argv);
  if (options.help || !options.command) { usage(); return 0; }
  const config = JSON.parse(fs.readFileSync(path.join(options.dataDir, 'config.json'), 'utf8'));
  if (options.command === 'state') {
    const result = await controlRequest(config, '/v1/router/state');
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else if (!result.states.length) console.log('No in-memory routing state.');
    else {
      for (const state of result.states) {
        console.log(`${state.conversationKey.slice(0, 12)}  ${state.provider}/${state.phase}  kimi=${state.kimiRequests}/${state.requiredKimiRequests}  attempts=${state.attempts}${state.forced ? '  forced-checkpoint' : ''}`);
      }
    }
    return 0;
  }
  if (options.command === 'deescalate') {
    if (!options.all && !options.conversation) throw new Error('Use --conversation <key> or --all');
    const result = await controlRequest(config, '/v1/router/deescalate', {
      all: options.all === true,
      ...(options.conversation ? { conversationKey: options.conversation } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  usage();
  return 2;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
