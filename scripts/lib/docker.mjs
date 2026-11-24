import { spawn } from 'node:child_process';

function run(command, args, { env = process.env, stdio = 'inherit' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio, windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function capture(command, args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

function composeProjectName() {
  const name = process.env.CLAUDE_ROUTER_PROJECT || 'claude-model-router';
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new Error('CLAUDE_ROUTER_PROJECT must contain only lowercase letters, digits, underscores, and hyphens');
  }
  return name;
}

function composeArgs(composeFile, args) {
  return ['compose', '--project-name', composeProjectName(), '-f', composeFile, ...args];
}

function composeEnv(dataDir, port) {
  return { ...process.env, CLAUDE_ROUTER_DATA_DIR: dataDir, CLAUDE_ROUTER_PORT: String(port) };
}

export async function dockerComposeAvailable() {
  try {
    const result = await capture('docker', ['compose', 'version']);
    return result.code === 0;
  } catch {
    return false;
  }
}

export async function requireDockerCompose() {
  const version = await capture('docker', ['--version']).catch(() => null);
  if (!version || version.code !== 0) throw new Error('Docker is not installed or is not on PATH');
  if (!(await dockerComposeAvailable())) throw new Error('Docker Compose v2 is not available (docker compose version failed)');
}

export async function startDockerCompose({ composeFile, dataDir, port }) {
  await requireDockerCompose();
  await run('docker', composeArgs(composeFile, ['up', '-d', '--build']), {
    env: composeEnv(dataDir, port),
    stdio: 'inherit',
  });
}

export async function stopDockerCompose({ composeFile, dataDir, port }) {
  await run('docker', composeArgs(composeFile, ['down', '--remove-orphans']), {
    env: composeEnv(dataDir, port),
    stdio: 'inherit',
  });
}

export async function restartDockerCompose({ composeFile, dataDir, port }) {
  await run('docker', composeArgs(composeFile, ['restart']), {
    env: composeEnv(dataDir, port),
    stdio: 'inherit',
  });
}

export async function logsDockerCompose({ composeFile, dataDir, port, tail = 100 }) {
  await run('docker', composeArgs(composeFile, ['logs', '--tail', String(tail)]), {
    env: composeEnv(dataDir, port),
    stdio: 'inherit',
  });
}

export async function dockerComposeStatus({ composeFile, dataDir, port }) {
  return capture('docker', composeArgs(composeFile, ['ps', '--format', 'json']), {
    env: composeEnv(dataDir, port),
  });
}

export async function waitForHealth({ port, timeoutMs = 60000, intervalMs = 500 }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        const health = await response.json();
        if (health.ok) return health;
      }
      lastError = new Error(`health returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`router did not become healthy on port ${port}: ${lastError?.message || 'timeout'}`);
}
