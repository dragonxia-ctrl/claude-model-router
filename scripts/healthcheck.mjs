import process from 'node:process';

const port = process.env.CLAUDE_ROUTER_PORT || 17861;
try {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) });
  if (!response.ok) process.exit(1);
  const health = await response.json();
  process.exit(health.ok ? 0 : 1);
} catch {
  process.exit(1);
}
