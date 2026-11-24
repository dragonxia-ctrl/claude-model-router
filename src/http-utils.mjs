import { timingSafeEqual } from 'node:crypto';

export function authorized(req, expected) {
  const supplied = String(req.headers['x-api-key'] || req.headers.authorization?.replace(/^Bearer\s+/i, '') || '');
  if (!expected || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export function json(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

export function error(res, status, type, message) {
  json(res, status, { type: 'error', error: { type, message } });
}

export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024 * 1024) throw new Error('Request body exceeds 128 MiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
