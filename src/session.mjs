import { createHash } from 'node:crypto';

/**
 * Claude Code identifies the calling session in two places: the
 * `x-claude-code-session-id` request header, and `metadata.user_id`, which is
 * a JSON string carrying `session_id`. Older clients sometimes use the
 * `..._session_<uuid>` delimiter form instead.
 */
export function sessionIdFrom(headers = {}, metadata = null) {
  const header = headers?.['x-claude-code-session-id'];
  if (typeof header === 'string' && header) return header;
  const raw = metadata?.user_id;
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.session_id === 'string' && parsed.session_id) {
      return parsed.session_id;
    }
  } catch {
    // Not JSON: try the delimiter form below.
  }
  const legacy = /(?:^|[_\s])session[_-]([0-9a-f-]{8,})/i.exec(raw);
  return legacy ? legacy[1] : null;
}

/**
 * The log stores a short, non-reversible hash of the session uuid. That is
 * enough to tell two terminals apart without recording the uuid itself (or the
 * device id) anywhere.
 */
export function sessionTag(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  return createHash('sha256').update(`session\0${sessionId}`).digest('hex').slice(0, 16);
}

export function sessionTagFor(headers, metadata) {
  return sessionTag(sessionIdFrom(headers, metadata));
}
