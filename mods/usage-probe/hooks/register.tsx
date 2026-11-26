import type { Register, TurnUsage } from 'claude-code'

type TokenCounts = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

type ModelBucket = {
  model: string
  requests: number
  requestsWithoutUsage: number
  durationMs: number
  tokens: TokenCounts
}

type TurnSummary = {
  turnId: string
  durationMs: number
  isAborted: boolean
  models: ModelBucket[]
}

type SessionTotals = {
  turnCount: number
  models: ModelBucket[]
}

const EMPTY_TOKENS = (): TokenCounts => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})

function bucketFor(models: Map<string, ModelBucket>, model: string): ModelBucket {
  const existing = models.get(model)
  if (existing) return existing
  const bucket: ModelBucket = {
    model,
    requests: 0,
    requestsWithoutUsage: 0,
    durationMs: 0,
    tokens: EMPTY_TOKENS(),
  }
  models.set(model, bucket)
  return bucket
}

function addUsage(target: TokenCounts, usage: TurnUsage) {
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
    target[key] += Number(usage[key]) || 0
  }
}

function addBucket(target: ModelBucket, source: ModelBucket) {
  target.requests += source.requests
  target.requestsWithoutUsage += source.requestsWithoutUsage
  target.durationMs += source.durationMs
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
    target.tokens[key] += source.tokens[key]
  }
}

function emptyTotals(): SessionTotals {
  return { turnCount: 0, models: [] }
}

// The session accumulator only ever adds a turn once, on turn.complete, so a
// compaction between turns loses nothing: the earlier turns are already summed
// here, and compaction's own summarization runs as a fork with an agentId,
// never as a main-conversation turn.
function accumulateTurn(totals: SessionTotals, summary: TurnSummary): SessionTotals {
  const models = new Map<string, ModelBucket>()
  for (const bucket of totals.models) models.set(bucket.model, { ...bucket, tokens: { ...bucket.tokens } })
  for (const bucket of summary.models) addBucket(bucketFor(models, bucket.model), bucket)
  return { turnCount: totals.turnCount + 1, models: [...models.values()] }
}

function tokenTotal(tokens: TokenCounts): number {
  return tokens.input_tokens + tokens.output_tokens + tokens.cache_read_input_tokens + tokens.cache_creation_input_tokens
}

export function modelLabel(model: string): string {
  const id = model.toLowerCase()
  if (id.includes('deepseek')) return 'DeepSeek'
  if (id.includes('kimi')) return 'Kimi'
  return model
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(Math.round(value))
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds >= 60_000) {
    const minutes = Math.floor(milliseconds / 60_000)
    const seconds = Math.floor((milliseconds % 60_000) / 1000)
    return `${minutes}m ${seconds}s`
  }
  return `${(milliseconds / 1000).toFixed(1)}s`
}

function percentage(value: number, total: number): string {
  return total > 0 ? `${Math.round((value / total) * 100)}%` : '0%'
}

// One row per model, the first prefixed by `label` and the rest aligned under
// its model column. Percentages are shares within this one set of rows.
function formatRows(models: ModelBucket[], label: string): string[] {
  const preferred = ['DeepSeek', 'Kimi']
  const ordered = [...models].sort((a, b) => {
    const aIndex = preferred.indexOf(modelLabel(a.model))
    const bIndex = preferred.indexOf(modelLabel(b.model))
    if (aIndex !== bIndex) return (aIndex < 0 ? 99 : aIndex) - (bIndex < 0 ? 99 : bIndex)
    return a.model.localeCompare(b.model)
  })
  const allTokens = ordered.reduce((sum, bucket) => sum + tokenTotal(bucket.tokens), 0)
  const allTime = ordered.reduce((sum, bucket) => sum + bucket.durationMs, 0)
  const indent = ' '.repeat(`${label} · `.length)
  return ordered.map((bucket, index) => {
    const tokens = tokenTotal(bucket.tokens)
    const missing = bucket.requestsWithoutUsage > 0
    const tokenText = missing && bucket.requests === bucket.requestsWithoutUsage
      ? 'usage unavailable'
      : `${formatTokens(tokens)} tok · ${percentage(tokens, allTokens)} tok`
    const timeText = `${formatDuration(bucket.durationMs)} · ${percentage(bucket.durationMs, allTime)} time`
    return `${index === 0 ? `${label} · ` : indent}${modelLabel(bucket.model).padEnd(8)} ${tokenText} · ${timeText}${missing ? ' · partial usage' : ''}`
  })
}

export function formatSummary(summary: TurnSummary): string[] {
  return formatRows(summary.models, summary.isAborted ? 'Usage (partial)' : 'Usage')
}

// A single completed turn would print the same numbers twice, so the session
// block starts at the second turn.
export function formatSession(totals: SessionTotals): string[] {
  if (totals.turnCount < 2) return []
  return formatRows(totals.models, 'Session')
}

function appendBucketDetails(lines: string[], models: ModelBucket[]) {
  for (const bucket of models) {
    lines.push(
      '',
      `${modelLabel(bucket.model)} (${bucket.model})`,
      `  Requests: ${bucket.requests}`,
      `  Input: ${bucket.tokens.input_tokens}`,
      `  Output: ${bucket.tokens.output_tokens}`,
      `  Cache read: ${bucket.tokens.cache_read_input_tokens}`,
      `  Cache creation: ${bucket.tokens.cache_creation_input_tokens}`,
      `  Total tokens: ${tokenTotal(bucket.tokens)}`,
      `  Model request time: ${formatDuration(bucket.durationMs)}`,
    )
    if (bucket.requestsWithoutUsage > 0) lines.push(`  Requests without reported usage: ${bucket.requestsWithoutUsage}`)
  }
}

export function formatDetailed(summary: TurnSummary | null, totals: SessionTotals = emptyTotals()): string {
  if (!summary && totals.turnCount === 0) return 'No completed main-conversation turn has been recorded yet.'
  const lines: string[] = []
  if (totals.turnCount > 0) {
    lines.push(`Session: ${totals.turnCount} completed main-conversation turn${totals.turnCount === 1 ? '' : 's'}, summed across context compactions`)
    appendBucketDetails(lines, totals.models)
  }
  if (summary) {
    if (lines.length) lines.push('', '---')
    lines.push(
      `Last turn ${summary.turnId}${summary.isAborted ? ' (partial: interrupted)' : ''}`,
      `Turn wall time: ${formatDuration(summary.durationMs)} (includes tools and other non-model work)`,
    )
    appendBucketDetails(lines, summary.models)
  }
  return lines.join('\n')
}

export const register: Register = on => {
  let active: { turnId: string; models: Map<string, ModelBucket> } | null = null
  let lastSummary: TurnSummary | null = null
  // Module scope is deliberate: it outlives a compaction, which rewrites the
  // transcript but does not reload this mod. A fresh session (or a resumed one)
  // starts over, because earlier turns are no longer observable here.
  let session = emptyTotals()

  on('session.start', async ($, e, next) => {
    session = emptyTotals()
    await $.command.register({
      name: 'router-usage',
      description: 'Show real token usage and model request time for the session and the last turn',
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      const models = new Map<string, ModelBucket>()
      // This plugin belongs to the DeepSeek/Kimi router. Keep both models
      // visible, including an explicit zero when one was not selected.
      bucketFor(models, 'deepseek-flash')
      bucketFor(models, 'kimi-k3.1-pro')
      active = { turnId: e.turnId, models }
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const started = Date.now()
    const result = yield* next(e)
    const durationMs = Math.max(0, Date.now() - started)
    if (!e.agentId && active?.turnId === e.turnId) {
      const bucket = bucketFor(active.models, result.usage?.model || e.model)
      bucket.requests += 1
      bucket.durationMs += durationMs
      if (result.usage) addUsage(bucket.tokens, result.usage)
      else bucket.requestsWithoutUsage += 1
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && active?.turnId === e.turnId) {
      lastSummary = {
        turnId: e.turnId,
        durationMs: e.durationMs,
        isAborted: e.isAborted,
        models: [...active.models.values()],
      }
      active = null
      session = accumulateTurn(session, lastSummary)
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const original = await next(e)
    if (!lastSummary || e.surface !== 'terminal') return original
    const { Box, Text } = $.ui.resolve(e)
    const lines = [...formatSummary(lastSummary), ...formatSession(session)]
    if (!lines.length) return original
    return Box({
      flexDirection: 'column',
      children: [
        ...lines.map((line, index) => Text({ children: [line], dimColor: true })),
        original,
      ],
    })
  })

  on('command.run', { command: 'router-usage' }, async () => ({ text: formatDetailed(lastSummary, session) }))
}
