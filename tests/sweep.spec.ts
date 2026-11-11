import { describe, expect, it } from 'vitest'
import { DEFAULT_SWEEP, SWEEP_MARK, sweepCandidates, sweepRound, sweepTriggerId, sweepTrigger, type SweepDeps, type SweepIssue } from '../src/sources/sweep.ts'
import type { Trigger } from '../src/core/index.ts'

const issue = (number: number, extra: Partial<SweepIssue> = {}): SweepIssue => ({ number, title: `Issue ${number}`, url: `https://example/${number}`,
  updatedAt: '2026-11-07T10:00:00Z', body: 'body', labels: [{ name: 'status:ready' }], assignees: [], ...extra })

describe('sweep candidates', () => {
  it('includes failed and unclassified issues, preserves ready and excludes later phases', () => {
    const items = [issue(1), issue(2, { labels: [{ name: 'status:acceptance-not-passed' }] }),
      issue(3, { labels: [{ name: 'status:needs-triage' }] }), issue(4, { labels: [{ name: 'type:bug' }] }),
      issue(5, { labels: [{ name: 'status:released' }] }), issue(6, { labels: [{ name: 'status:blocked' }] }),
      issue(7, { labels: [{ name: 'status:ready' }, { name: 'status:needs-triage' }] })]
    expect(sweepCandidates(items, ['status:ready'], true).map(i => i.number)).toEqual([2, 3, 4, 7, 1])
    expect(sweepCandidates(items, ['status:ready'], false).map(i => i.number)).toEqual([1, 7])
  })
  it('does not miss attention issues beyond the first page and honors multi-label filters', () => {
    const items = [...Array.from({ length: 80 }, (_, i) => issue(i + 1, { labels: [{ name: 'status:released' }] })),
      issue(81, { labels: [{ name: 'status:acceptance-not-passed' }] }),
      issue(82, { labels: [{ name: 'status:ready' }, { name: 'area:web' }] }), issue(83)]
    expect(sweepCandidates(items, ['status:ready', 'area:web'], true).map(i => i.number)).toEqual([81, 82])
  })
  it('uses only the newest copy when a changing issue appears on two pages', () => {
    const older = issue(9, { updatedAt: '2026-11-07T09:00:00Z' })
    const newer = issue(9, { updatedAt: '2026-11-07T10:00:00Z', labels: [{ name: 'status:acceptance-not-passed' }] })
    expect(sweepCandidates([newer, older], ['status:ready'], true)).toEqual([newer])
  })
})

function deps(overrides: Partial<SweepDeps> = {}): SweepDeps & { received: Trigger[]; marked: string[] } {
  const received: Trigger[] = []
  const marked: string[] = []
  const emitted = new Set<string>()
  return { received, marked,
    list: async () => [issue(3310)],
    hasOpenPull: async () => false,
    inFlight: () => new Set<string>(),
    emitted: id => emitted.has(id),
    mark: id => { emitted.add(id); marked.push(id) },
    receive: trigger => { received.push(trigger); return 'stored' },
    openTickets: 0, actor: 'agent', repository: 'o/r', now: () => '2026-11-07T10:05:00Z', ...overrides }
}

describe('sweepRound', () => {
  it('proposes an unassigned Issue with no pull request and marks it', async () => {
    const d = deps()
    const outcome = await sweepRound({ ...DEFAULT_SWEEP, labels: ['status:ready'] }, d)
    expect(outcome.emitted).toBe(1)
    expect(d.received).toHaveLength(1)
    expect(d.marked).toEqual([sweepTriggerId(3310, '2026-11-07T10:00:00Z')])
  })

  it('does not mark a candidate when asynchronous intake rejects it', async () => {
    const d = deps({ receive: async () => { throw new Error('intake unavailable') } })
    await expect(sweepRound({ ...DEFAULT_SWEEP, labels: ['status:ready'] }, d)).rejects.toThrow('intake unavailable')
    expect(d.marked).toEqual([])
  })

  it('does not claim a filtered candidate was accepted', async () => {
    const d = deps({ receive: async () => 'filtered' as const })
    const result = await sweepRound({ ...DEFAULT_SWEEP, labels: ['status:ready'] }, d)
    expect(result.emitted).toBe(0)
    expect(d.marked).toEqual([])
  })

  it('deduplicates an already stored trigger without counting it as newly accepted', async () => {
    const d = deps({ receive: async () => 'duplicate' as const })
    const result = await sweepRound({ ...DEFAULT_SWEEP, labels: ['status:ready'] }, d)
    expect(result.emitted).toBe(0)
    expect(result.skipped).toEqual([{ number: 3310, why: 'duplicate' }])
    expect(d.marked).toEqual([sweepTriggerId(3310, '2026-11-07T10:00:00Z')])
  })

  it('does nothing without labels', async () => {
    const d = deps()
    const outcome = await sweepRound({ ...DEFAULT_SWEEP, labels: [] }, d)
    expect(outcome.emitted).toBe(0)
    expect(d.received).toHaveLength(0)
  })

  it('skips the same Issue revision after a restart', async () => {
    const d = deps({ emitted: id => id === sweepTriggerId(3310, '2026-11-07T10:00:00Z') })
    const outcome = await sweepRound({ ...DEFAULT_SWEEP, labels: ['status:ready'] }, d)
    expect(outcome.emitted).toBe(0)
    expect(outcome.skipped).toEqual([{ number: 3310, why: 'done' }])
  })

  it('reconsiders a previously ignored issue after the repository baseline changes, without duplicating active work', async () => {
    const seen = new Set<string>()
    const d = deps({ emitted: id => seen.has(id), mark: id => { seen.add(id) }, contextRevision: 'main-a:window-1' })
    const config = { ...DEFAULT_SWEEP, labels: ['status:ready'] }
    expect((await sweepRound(config, d)).emitted).toBe(1)
    expect((await sweepRound(config, d)).emitted).toBe(0)
    d.contextRevision = 'main-b:window-1'
    expect((await sweepRound(config, d)).emitted).toBe(1)
    d.contextRevision = 'main-c:window-1'
    d.inFlight = () => new Set(['github:3310'])
    expect((await sweepRound(config, d)).skipped).toEqual([{ number: 3310, why: 'in-flight' }])
    expect(d.received).toHaveLength(2)
  })

  it('skips an Issue a live Ticket already follows', async () => {
    const d = deps({ inFlight: () => new Set(['github:3310']) })
    const outcome = await sweepRound({ ...DEFAULT_SWEEP, labels: ['status:ready'] }, d)
    expect(outcome.skipped).toEqual([{ number: 3310, why: 'in-flight' }])
    expect(d.received).toHaveLength(0)
  })

  it('skips an Issue that appears in an open pull request', async () => {
    const d = deps({ hasOpenPull: async () => true })
    const outcome = await sweepRound({ ...DEFAULT_SWEEP, labels: ['status:ready'] }, d)
    expect(outcome.skipped).toEqual([{ number: 3310, why: 'has-open-pr' }])
    expect(d.marked).toHaveLength(0)
  })

  it('proposes an Issue whose only pull request was closed without merging it', async () => {
    const d = deps({ hasOpenPull: async () => false })
    const outcome = await sweepRound({ ...DEFAULT_SWEEP, labels: ['status:ready'] }, d)
    expect(outcome.emitted).toBe(1)
    expect(d.received).toHaveLength(1)
  })

  it('skips an assigned Issue', async () => {
    const d = deps({ list: async () => [issue(3310, { assignees: [{ login: 'someone' }] })] })
    const outcome = await sweepRound({ ...DEFAULT_SWEEP, labels: ['status:ready'] }, d)
    expect(outcome.skipped).toEqual([{ number: 3310, why: 'assigned' }])
  })

  it('stops while the configured number of Tickets is open', async () => {
    const d = deps({ openTickets: 3 })
    const outcome = await sweepRound({ ...DEFAULT_SWEEP, labels: ['status:ready'], maxOpenTickets: 3 }, d)
    expect(outcome.emitted).toBe(0)
    expect(d.received).toHaveLength(0)
  })

  it('fills at most the round ceiling, in order', async () => {
    const d = deps({ list: async () => [issue(1), issue(2), issue(3)] })
    const outcome = await sweepRound({ ...DEFAULT_SWEEP, labels: ['status:ready'], maxPerRound: 2 }, d)
    expect(outcome.emitted).toBe(2)
    expect(d.received.map(trigger => trigger.meta.number)).toEqual([1, 2])
  })
})

describe('sweepTrigger', () => {
  it('is a non-human inferred candidate on the Issue Thread, marked as a sweep', () => {
    const trigger = sweepTrigger(issue(3310, { body: 'keep <!-- hidden -->this' }), 'agent', '2026-11-07T10:05:00Z')
    expect(trigger.human).toBe(false)
    expect(trigger.source).toBe('github')
    expect(trigger.threads).toEqual([{ source: 'github', id: '3310' }])
    expect(trigger.meta).toMatchObject({ number: 3310, kind: 'issue', sweep: true })
    expect(trigger.addressed).toBeUndefined()
    expect(trigger.text.startsWith(SWEEP_MARK)).toBe(true)
    expect(trigger.text).not.toContain('hidden')
  })
})
