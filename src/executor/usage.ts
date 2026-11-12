import { lastAssistantStreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export interface ExecutorUsage { total: number; complete: boolean }
const LIMIT = 300_000_000
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

/** Counts each durable model attempt once, including cached input, without counting reasoning twice. */
export function executorUsage(events: readonly SessionEvent[]): ExecutorUsage {
  let total = 0, complete = true
  const seen = new Set<number>()
  for (const event of events) {
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    if (seen.has(event.seq)) { complete = false; continue }
    seen.add(event.seq)
    const usage: TokenUsage | undefined = event.type === 'assistant/message'
      ? event.data.usage : lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
    if (!usage || !count(usage.inputTokens) || !count(usage.outputTokens)
      || (usage.cacheReadTokens !== undefined && !count(usage.cacheReadTokens))
      || (usage.cacheWriteTokens !== undefined && !count(usage.cacheWriteTokens))) { complete = false; continue }
    const components = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    if (!count(components) || (usage.totalTokens !== undefined && !count(usage.totalTokens))) { complete = false; continue }
    // The installed client counts the four disjoint counters; mismatches must not silently authorize a handoff.
    if (components > 0 && usage.totalTokens !== undefined && usage.totalTokens !== components) complete = false
    const amount = components || usage.totalTokens || 0
    if (!count(amount) || !count(total + amount)) { complete = false; continue }
    total += amount
  }
  return { total, complete }
}

/** Unknown accounting cannot authorize a session handoff. */
export const overExecutorLimit = (usage: ExecutorUsage): boolean => usage.complete && usage.total > LIMIT
