import { expect, test } from 'claude-code/testing'
import { formatSummary, formatTokens } from '../hooks/register'

const FOOTER = {
  plugin: 'usage-probe',
  component: 'TurnDuration',
  requestId: 'turn-1',
  props: { word: 'Churned', durationMs: 22_000 },
} as const

function stubSession(on: (event: any, hook: any) => void) {
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', (_$: unknown, _e: unknown) => ({
    type: 'Text', props: {}, children: ['Churned for 22s · done Wednesday 10:00'],
  }))
}

async function completeStep($: any, input: { turnId: string; index: number; model: string; agentId?: string }) {
  const stream = $.turn.step({ ...input, messageCount: 1 })
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
  return step.value
}

test('mixed DeepSeek/Kimi usage is placed above the original footer', async ($, on) => {
  stubSession(on)
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number; model: string }) {
    yield { kind: 'text', index: 0, text: 'ok' }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: e.model.includes('kimi')
        ? { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, model: e.model }
        : { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 4500, cache_creation_input_tokens: 500, model: e.model },
    }
  })

  await $.turn.start({ turnId: 'turn-1', text: 'test' })
  await completeStep($, { turnId: 'turn-1', index: 0, model: 'deepseek-flash' })
  await completeStep($, { turnId: 'turn-1', index: 1, model: 'kimi-k3.1-pro' })
  await $.turn.complete({
    turnId: 'turn-1', answer: 'done', durationMs: 22_000, isAborted: false, reason: 'answer',
  })

  const ui = await $.ui.mount({ ...FOOTER, surface: 'terminal' })
  const drawn = await ui.drawn()
  const rendered = JSON.stringify(drawn)
  expect(rendered).toContain('DeepSeek')
  expect(rendered).toContain('Kimi')
  expect(rendered).toContain('6.5k tok')
  expect(rendered).toContain('93% tok')
  expect(rendered).toContain('500 tok')
  expect(rendered).toContain('7% tok')
  expect(rendered.indexOf('Usage')).toBeLessThan(rendered.indexOf('Churned for 22s'))
  await ui.unmount()

  const answer = await $.command.run({ command: 'router-usage', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(answer.text).toContain('Cache read: 4500')
  expect(answer.text).toContain('Output: 100')
})

test('a one-model turn reports an explicit zero for the other model', async ($, on) => {
  stubSession(on)
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number; model: string }) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: e.model },
    }
  })
  await $.turn.start({ turnId: 'turn-1', text: 'test' })
  await completeStep($, { turnId: 'turn-1', index: 0, model: 'deepseek-flash' })
  await $.turn.complete({ turnId: 'turn-1', answer: 'done', durationMs: 2000, isAborted: false, reason: 'answer' })

  const ui = await $.ui.mount({ ...FOOTER, surface: 'terminal' })
  const rendered = JSON.stringify(await ui.drawn())
  expect(rendered).toContain('DeepSeek 120 tok · 100% tok')
  expect(rendered).toContain('Kimi     0 tok · 0% tok')
  expect(rendered).not.toContain('Session')
  await ui.unmount()
})

test('missing usage and interruption are never presented as zero consumption', async ($, on) => {
  stubSession(on)
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number; model: string }) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })
  await $.turn.start({ turnId: 'turn-1', text: 'test' })
  await completeStep($, { turnId: 'turn-1', index: 0, model: 'deepseek-flash' })
  await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 1000, isAborted: true, reason: 'aborted' })

  const ui = await $.ui.mount({ ...FOOTER, surface: 'terminal' })
  const rendered = JSON.stringify(await ui.drawn())
  expect(rendered).toContain('Usage (partial)')
  expect(rendered).toContain('usage unavailable')
  expect(rendered).toContain('partial usage')
  await ui.unmount()
})

test('subagent requests do not contaminate the main turn', async ($, on) => {
  stubSession(on)
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number; model: string }) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { input_tokens: 999, output_tokens: 999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: e.model },
    }
  })
  await $.turn.start({ turnId: 'turn-1', text: 'test' })
  await completeStep($, { turnId: 'turn-1', index: 0, model: 'kimi-k3.1-pro', agentId: 'subagent-1' })
  await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer' })

  const ui = await $.ui.mount({ ...FOOTER, surface: 'terminal' })
  const rendered = JSON.stringify(await ui.drawn())
  expect(rendered).not.toContain('2k tok')
  expect(rendered).toContain('Kimi     0 tok · 0% tok')
  await ui.unmount()
})

// Usage per step, by model: DeepSeek 6.5k tokens, Kimi 500 tokens.
function usageByModel(on: (event: any, hook: any) => void) {
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number; model: string }) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: e.model.includes('kimi')
        ? { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, model: e.model }
        : { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 4500, cache_creation_input_tokens: 500, model: e.model },
    }
  })
}

async function runTurn($: any, turnId: string, model: string) {
  await $.turn.start({ turnId, text: 'test' })
  await completeStep($, { turnId, index: 0, model })
  await $.turn.complete({ turnId, answer: 'done', durationMs: 2000, isAborted: false, reason: 'answer' })
}

test('session rows keep the turns a compaction dropped from the footer', async ($, on) => {
  stubSession(on)
  usageByModel(on)
  await runTurn($, 'turn-1', 'deepseek-flash')
  // Auto-compaction runs between turns and continues as a fresh turn id, so the
  // last-turn rows alone would show only what came after it.
  await runTurn($, 'turn-2', 'kimi-k3.1-pro')

  const ui = await $.ui.mount({ ...FOOTER, surface: 'terminal' })
  const rendered = JSON.stringify(await ui.drawn())
  // Last turn: DeepSeek unused, Kimi the whole turn.
  expect(rendered).toContain('Usage · DeepSeek 0 tok · 0% tok')
  expect(rendered).toContain('Kimi     500 tok · 100% tok')
  // Session: both turns, still dominated by the pre-compaction DeepSeek turn.
  expect(rendered).toContain('Session · DeepSeek 6.5k tok · 93% tok')
  expect(rendered).toContain('Kimi     500 tok · 7% tok')
  expect(rendered.indexOf('Usage')).toBeLessThan(rendered.indexOf('Session'))
  expect(rendered.indexOf('Session')).toBeLessThan(rendered.indexOf('Churned for 22s'))
  await ui.unmount()

  const answer = await $.command.run({ command: 'router-usage', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(answer.text).toContain('Session: 2 completed main-conversation turns')
  expect(answer.text).toContain('Cache read: 4500')
  expect(answer.text).toContain('Last turn turn-2')
})

test('session rows grow across three turns instead of resetting per turn', async ($, on) => {
  stubSession(on)
  usageByModel(on)
  await runTurn($, 'turn-1', 'deepseek-flash')
  await runTurn($, 'turn-2', 'deepseek-flash')
  await runTurn($, 'turn-3', 'kimi-k3.1-pro')

  const ui = await $.ui.mount({ ...FOOTER, surface: 'terminal' })
  const rendered = JSON.stringify(await ui.drawn())
  expect(rendered).toContain('Session · DeepSeek 13k tok · 96% tok')
  expect(rendered).toContain('Kimi     500 tok · 4% tok')
  await ui.unmount()
})

test('a new session starts the totals over', async ($, on) => {
  stubSession(on)
  usageByModel(on)
  await runTurn($, 'turn-1', 'deepseek-flash')
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await runTurn($, 'turn-2', 'kimi-k3.1-pro')
  await runTurn($, 'turn-3', 'kimi-k3.1-pro')

  const ui = await $.ui.mount({ ...FOOTER, surface: 'terminal' })
  const rendered = JSON.stringify(await ui.drawn())
  expect(rendered).toContain('Session · DeepSeek 0 tok · 0% tok')
  expect(rendered).toContain('Kimi     1k tok · 100% tok')
  await ui.unmount()
})

test('token formatting stays compact', () => {
  expect(formatTokens(0)).toBe('0')
  expect(formatTokens(999)).toBe('999')
  expect(formatTokens(1000)).toBe('1k')
  expect(formatTokens(6500)).toBe('6.5k')
  expect(formatTokens(1_200_000)).toBe('1.2M')
})
