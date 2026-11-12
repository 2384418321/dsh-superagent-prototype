import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { executorUsage, overExecutorLimit } from '../src/executor/usage.ts'

const events = (...items: object[]) => items as SessionEvent[]
const message = (seq: number, usage?: object) => ({ type: 'assistant/message', seq, data: { usage, stream: [] } })
const attempt = (seq: number, usage?: object) => ({ type: 'assistant/attempt', seq, data: { stream: usage
  ? [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage } }] : [] } })

describe('executor lifetime usage', () => {
  it('counts exact totals once per settled request, including failed attempts and cache tokens', () => {
    const data = events(message(1, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 88, totalTokens: 100 }),
      attempt(2, { inputTokens: 5, outputTokens: 3, cacheReadTokens: 12, totalTokens: 20 }))
    expect(executorUsage(data)).toEqual({ total: 120, complete: true })
  })

  it('does not add reasoning tokens twice and reconstructs totals from disjoint counters', () => {
    const usage = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, reasoningTokens: 7 }
    expect(executorUsage(events(message(1, usage)))).toEqual({ total: 100, complete: true })
  })

  it('never treats missing or invalid usage as known zero', () => {
    expect(executorUsage(events(message(1)))).toEqual({ total: 0, complete: false })
    expect(executorUsage(events(attempt(1)))).toEqual({ total: 0, complete: false })
    expect(executorUsage(events(message(1, { inputTokens: -1, outputTokens: 2 })))).toEqual({ total: 0, complete: false })
  })

  it('rejects duplicate events and unsafe totals rather than guessing', () => {
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    expect(executorUsage(events(message(1, usage), message(1, usage)))).toEqual({ total: 2, complete: false })
    expect(executorUsage(events(message(1, { ...usage, totalTokens: Number.MAX_SAFE_INTEGER + 1 })))).toEqual({ total: 0, complete: false })
  })

  it('requires a verified count strictly above 300 million', () => {
    expect(overExecutorLimit({ total: 300_000_000, complete: true })).toBe(false)
    expect(overExecutorLimit({ total: 300_000_001, complete: true })).toBe(true)
    expect(overExecutorLimit({ total: 300_000_001, complete: false })).toBe(false)
  })
})
