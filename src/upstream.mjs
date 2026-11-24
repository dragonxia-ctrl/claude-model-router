import { error } from './http-utils.mjs';

export async function forward({ req, res, body, provider, requestId }) {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  const headers = {
    'content-type': 'application/json', accept: req.headers.accept || 'application/json',
    'accept-encoding': 'identity', authorization: `Bearer ${provider.apiKey}`,
    'x-api-key': provider.apiKey, 'x-client-request-id': requestId,
    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
  };
  if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
  let upstream;
  try {
    upstream = await fetch(`${provider.baseUrl.replace(/\/$/, '')}${req.url}`, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: controller.signal, redirect: 'error',
    });
  } catch (err) {
    if (!controller.signal.aborted) error(res, 502, 'upstream_connection_error', err.message);
    return;
  }
  res.statusCode = upstream.status;
  for (const name of ['content-type', 'cache-control', 'retry-after', 'x-request-id', 'x-should-retry']) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  res.flushHeaders();
  try {
    for await (const chunk of upstream.body || []) {
      if (!res.write(Buffer.from(chunk))) await new Promise(resolve => res.once('drain', resolve));
    }
    res.end();
  } catch (err) { res.destroy(err); }
}
