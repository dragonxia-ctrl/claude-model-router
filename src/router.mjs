import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createConfigStore } from './config-store.mjs';
import { createHandler } from './handler.mjs';

function defaultConfigPath() {
  return path.join(os.homedir(), '.claude', 'model-router', 'config.json');
}

const configPath = process.env.CLAUDE_ROUTER_CONFIG || defaultConfigPath();
const store = createConfigStore(configPath);
const initial = store.get();
const server = http.createServer(createHandler(() => store.get()));
server.on('clientError', (error, socket) => {
  console.error(JSON.stringify({ event: 'client_error', message: error.message }));
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});
const host = process.env.CLAUDE_ROUTER_HOST || initial.router.host || '127.0.0.1';
const port = Number(process.env.CLAUDE_ROUTER_PORT || initial.router.port || 17861);
server.listen(port, host, () => {
  console.log(JSON.stringify({
    event: 'started',
    address: `http://${host}:${server.address().port}`,
    config: configPath,
    revision: store.revision,
  }));
});
if (process.platform !== 'win32') {
  process.on('SIGHUP', () => {
    const result = store.reload();
    console.log(JSON.stringify({ event: 'config_reload', ...result }));
  });
}
process.on('unhandledRejection', error => {
  console.error(JSON.stringify({ event: 'unhandled_rejection', message: error?.message || String(error) }));
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(JSON.stringify({ event: 'graceful_shutdown', signal }));
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  });
}
