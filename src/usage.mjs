const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_SSE_LINE = 4 * 1024 * 1024;

function normalizeUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const fields = {
    input_tokens: Number(value.input_tokens) || 0,
    output_tokens: Number(value.output_tokens) || 0,
    cache_read_input_tokens: Number(value.cache_read_input_tokens) || 0,
    cache_creation_input_tokens: Number(value.cache_creation_input_tokens) || 0,
  };
  return Object.values(fields).some(token => token > 0) ? fields : null;
}

function mergeUsage(current, incoming) {
  const next = normalizeUsage(incoming);
  if (!next) return current;
  if (!current) return { ...next };
  return {
    input_tokens: Math.max(current.input_tokens, next.input_tokens),
    output_tokens: Math.max(current.output_tokens, next.output_tokens),
    cache_read_input_tokens: Math.max(current.cache_read_input_tokens, next.cache_read_input_tokens),
    cache_creation_input_tokens: Math.max(current.cache_creation_input_tokens, next.cache_creation_input_tokens),
  };
}

function usageFromPayload(value) {
  if (!value || typeof value !== 'object') return null;
  return mergeUsage(
    mergeUsage(null, value.usage),
    mergeUsage(null, value.message?.usage),
  );
}

/**
 * Observes a response without changing a single byte.
 * JSON responses are parsed once at the end; SSE responses are parsed line by
 * line as they stream. Only token counts are retained, never prompt or answer
 * text.
 */
export function createUsageTap(contentType) {
  const isEventStream = /text\/event-stream/i.test(contentType || '');
  let pending = '';
  let raw = Buffer.alloc(0);
  let usage = null;

  function consumeLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      usage = mergeUsage(usage, usageFromPayload(JSON.parse(data)));
    } catch {
      // Non-JSON SSE comments and vendor extensions are ignored.
    }
  }

  return {
    push(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!isEventStream) {
        if (raw.length + bytes.length <= MAX_JSON_BYTES) raw = Buffer.concat([raw, bytes]);
        return;
      }
      pending += bytes.toString('utf8');
      let newline;
      while ((newline = pending.search(/\r?\n/)) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(pending[newline] === '\r' ? newline + 2 : newline + 1);
        if (line.length <= MAX_SSE_LINE) consumeLine(line);
      }
      if (pending.length > MAX_SSE_LINE) pending = '';
    },
    end() {
      if (isEventStream) {
        if (pending) consumeLine(pending);
        pending = '';
      } else if (raw.length > 0) {
        try {
          usage = mergeUsage(usage, usageFromPayload(JSON.parse(raw.toString('utf8'))));
        } catch {
          // Truncated or non-JSON bodies simply yield no usage.
        }
        raw = Buffer.alloc(0);
      }
      return usage;
    },
  };
}
