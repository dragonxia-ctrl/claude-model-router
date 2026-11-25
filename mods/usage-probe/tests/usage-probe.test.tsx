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

test('token formatting stays compact', () => {
  expect(formatTokens(0)).toBe('0')
  expect(formatTokens(999)).toBe('999')
  expect(formatTokens(1000)).toBe('1k')
  expect(formatTokens(6500)).toBe('6.5k')
  expect(formatTokens(1_200_000)).toBe('1.2M')
})
