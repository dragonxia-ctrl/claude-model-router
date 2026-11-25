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

export function formatSummary(summary: TurnSummary): string[] {
  const preferred = ['DeepSeek', 'Kimi']
  const ordered = [...summary.models].sort((a, b) => {
    const aIndex = preferred.indexOf(modelLabel(a.model))
    const bIndex = preferred.indexOf(modelLabel(b.model))
    if (aIndex !== bIndex) return (aIndex < 0 ? 99 : aIndex) - (bIndex < 0 ? 99 : bIndex)
    return a.model.localeCompare(b.model)
  })
  const allTokens = ordered.reduce((sum, bucket) => sum + tokenTotal(bucket.tokens), 0)
  const allTime = ordered.reduce((sum, bucket) => sum + bucket.durationMs, 0)
  const prefix = summary.isAborted ? 'Usage (partial)' : 'Usage'
  return ordered.map((bucket, index) => {
    const tokens = tokenTotal(bucket.tokens)
    const missing = bucket.requestsWithoutUsage > 0
    const tokenText = missing && bucket.requests === bucket.requestsWithoutUsage
      ? 'usage unavailable'
      : `${formatTokens(tokens)} tok · ${percentage(tokens, allTokens)} tok`
    const timeText = `${formatDuration(bucket.durationMs)} · ${percentage(bucket.durationMs, allTime)} time`
    const indent = index === 0 ? '' : '        '
    return `${index === 0 ? `${prefix} · ` : indent}${modelLabel(bucket.model).padEnd(8)} ${tokenText} · ${timeText}${missing ? ' · partial usage' : ''}`
  })
}

export function formatDetailed(summary: TurnSummary | null): string {
  if (!summary) return 'No completed main-conversation turn has been recorded yet.'
  const lines = [
    `Turn ${summary.turnId}${summary.isAborted ? ' (partial: interrupted)' : ''}`,
    `Turn wall time: ${formatDuration(summary.durationMs)} (includes tools and other non-model work)`,
  ]
  for (const bucket of summary.models) {
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
  return lines.join('\n')
}

export const register: Register = on => {
  let active: { turnId: string; models: Map<string, ModelBucket> } | null = null
  let lastSummary: TurnSummary | null = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'router-usage',
      description: 'Show real token usage and model request time for the last completed turn',
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
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const original = await next(e)
    if (!lastSummary || e.surface !== 'terminal') return original
    const { Box, Text } = $.ui.resolve(e)
    const lines = formatSummary(lastSummary)
    if (!lines.length) return original
    return Box({
      flexDirection: 'column',
      children: [
        ...lines.map((line, index) => Text({ children: [line], dimColor: true })),
        original,
      ],
    })
  })

  on('command.run', { command: 'router-usage' }, async () => ({ text: formatDetailed(lastSummary) }))
}
