import { error } from './http-utils.mjs';
import { createUsageTap } from './usage.mjs';

export async function forward({
  req, res, body, provider, requestId, telemetry, route,
  conversationKey, taskKey, purpose = 'main', onOutcome,
}) {
  const controller = new AbortController();
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let clientClosed = false;
  let status = 0;
  let ttfbMs = null;
  let usage = null;
  let outcome = 'unknown';
  let failureKind = null;
  let responseBytes = 0;
  let finished = false;
  let tap = null;

  const finish = () => {
    if (finished) return;
    finished = true;
    const record = {
      at: startedAt,
      requestId,
      provider: provider.name,
      model: provider.model,
      purpose,
      outcome,
      httpStatus: status || null,
      ttfbMs,
      durationMs: Math.round(performance.now() - start),
      responseBytes,
      usage,
      errorKind: failureKind,
      route,
      conversationKey,
      taskKey,
    };
    let observed = null;
    try { observed = onOutcome?.(record); } catch (err) {
      console.error(JSON.stringify({ event: 'outcome_observer_error', requestId, message: err.message }));
    }
    if (observed?.outcome) record.route = { ...route, deescalationOutcome: observed.outcome };
    telemetry?.recordRequest?.(record);
  };

  res.on('close', () => {
    if (!res.writableEnded) {
      clientClosed = true;
      controller.abort();
    }
  });

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
    if (clientClosed) {
      outcome = 'client_aborted';
      failureKind = 'client_aborted';
    } else {
      outcome = 'upstream_error';
      failureKind = err?.name === 'AbortError' ? 'timeout' : 'connection';
      if (!res.headersSent) error(res, 502, 'upstream_connection_error', err.message);
    }
    finish();
    return;
  }

  status = upstream.status;
  ttfbMs = Math.round(performance.now() - start);
  outcome = status >= 200 && status < 300
    ? 'success'
    : status >= 500 ? 'upstream_5xx' : status >= 400 ? 'upstream_4xx' : 'upstream_other';
  if (outcome !== 'success') failureKind = `http_${status}`;
  tap = createUsageTap(upstream.headers.get('content-type'));

  res.statusCode = upstream.status;
  for (const name of ['content-type', 'cache-control', 'retry-after', 'x-request-id', 'x-should-retry']) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  res.flushHeaders();
  try {
    for await (const chunk of upstream.body || []) {
      const bytes = Buffer.from(chunk);
      responseBytes += bytes.length;
      tap.push(bytes);
      if (!res.write(bytes)) {
        await new Promise(resolve => {
          const done = () => {
            res.off('drain', done);
            res.off('close', done);
            resolve();
          };
          res.once('drain', done);
          res.once('close', done);
        });
        if (clientClosed) break;
      }
    }
    usage = tap.end();
    if (clientClosed) {
      outcome = 'client_aborted';
      failureKind = 'client_aborted';
    }
    res.end();
  } catch (err) {
    usage = tap.end();
    if (clientClosed || controller.signal.aborted) {
      outcome = 'client_aborted';
      failureKind = 'client_aborted';
    } else {
      outcome = 'stream_error';
      failureKind = 'stream_error';
    }
    res.destroy(err);
  } finally {
    finish();
  }
}
