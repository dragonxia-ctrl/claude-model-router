#!/usr/bin/env node
// Version segment for Claude Code's native status line, the same place Claude
// Code itself shows its version and upgrade notice.
//
//   "statusLine": { "type": "command", "command": "node .../version-status.mjs" }
//
// It only reads the router's local version cache (written by the running router
// at startup and at most every six hours) and never touches the network, so it
// is safe to run on every status line refresh. Without a cache it prints nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cachePath = process.env.CLAUDE_ROUTER_VERSION_CACHE
  || path.join(os.homedir(), '.claude', 'model-router', 'version-cache.json');

function label(value) {
  const text = String(value);
  return text.startsWith('v') ? text : `v${text}`;
}

let info = null;
try {
  info = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
} catch {
  info = null;
}

if (!info?.current) process.exit(0);

const current = label(info.current);
const latest = info.latest ? label(info.latest) : null;
const available = info.status === 'available' && latest;
const text = available
  ? `router ${current} · ${latest} available`
  : latest ? `router ${current} · latest ${latest}` : `router ${current}`;
// Dim while up to date; amber when an upgrade exists, like an update notice.
process.stdout.write(`${available ? '\u001b[33m' : '\u001b[2m'}${text}\u001b[0m\n`);
