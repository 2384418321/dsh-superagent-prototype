/** Policy-constrained sweep of existing open Issues: it proposes at most an inferred candidate, never a person's request. */
import { z } from 'zod'
import { key, type ReceiveResult, type Trigger } from '../core/index.ts'

/** Prefix every swept trigger's text carries, so a reader can tell it from a person's or a bot's message. */
export const SWEEP_MARK = '[orchestrator-sweep]'

export const SweepConfigSchema = z.object({
  /** Issue labels that must all be present; the first is what `gh issue list --label` filters on. */
  labels: z.array(z.string().regex(/^[A-Za-z0-9:_.\- ]{1,60}$/)).max(3).default([]),
  /** Seconds between sweeps. */
  everySeconds: z.number().int().min(300).max(86_400).default(900),
  /** Triggers one round may emit. */
  maxPerRound: z.number().int().min(1).max(5).default(1),
  /** Stop sweeping while this many Tickets are open anywhere; 0 disables the ceiling. */
  maxOpenTickets: z.number().int().min(0).max(20).default(3),
  /** Skip an Issue whose number appears in an open pull request; a closed or merged one does not block a later sweep. */
  skipWithOpenPull: z.boolean().default(true),
  /** Skip an Issue that still has an assignee. */
  skipAssigned: z.boolean().default(true),
}).strict()
export type SweepConfig = z.infer<typeof SweepConfigSchema>
export const DEFAULT_SWEEP: SweepConfig = SweepConfigSchema.parse({})

/** The parts of an Issue the sweep reads; `gh issue list --json` produces them. */
export interface SweepIssue {
  number: number; title: string; url: string; updatedAt: string
  body?: string | null
  labels?: { name: string }[] | null
  assignees?: { login: string }[] | null
}
export const SweepIssueSchema = z.looseObject({
  number: z.number().int().positive(), title: z.string(), url: z.string(), updatedAt: z.string(),
  body: z.string().nullish(), labels: z.array(z.looseObject({ name: z.string() })).nullish(),
  assignees: z.array(z.looseObject({ login: z.string() })).nullish(),
})

/** Additional statuses are candidates for assessment, not proof that development is needed. */
export function sweepCandidates(issues: SweepIssue[], labels: string[], includeAttention: boolean): SweepIssue[] {
  const latest = new Map<number, SweepIssue>()
  for (const issue of issues) {
    const previous = latest.get(issue.number)
    if (!previous || issue.updatedAt > previous.updatedAt) latest.set(issue.number, issue)
  }
  const priority = (issue: SweepIssue): number => {
    const names = (issue.labels ?? []).map(label => label.name)
    if (includeAttention && (names.includes('status:acceptance-not-passed') || names.includes('status:needs-triage') ||
      !names.some(name => name.startsWith('status:')))) return 0
    return labels.length && labels.every(label => names.includes(label)) ? 1 : 2
  }
  return [...latest.values()].filter(issue => priority(issue) < 2).sort((a, b) => priority(a) - priority(b))
}
export interface SweepDeps {
  /** Lists the Issues the source may propose; the caller filters by label. */
  list(): Promise<SweepIssue[]>
  /** True when an open pull request mentions `number`; closed or merged pull requests do not block a sweep. */
  hasOpenPull(number: number): Promise<boolean>
  /** Thread keys (`source:id`) whose Issue a live Ticket already follows. */
  inFlight(): Set<string>
  /** True when a trigger with this ID was already emitted, including before a restart. */
  emitted(id: string): boolean
  mark(id: string): void
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
  openTickets: number
  /** Changes when the default branch advances or a bounded recheck window passes. */
  contextRevision?: string
  actor: string
  repository: string
  now(): string
}
export interface SweepOutcome { emitted: number; considered: number; skipped: { number: number; why: string }[] }

/** Identity of one swept Trigger: the Issue and the revision that produced it, so a later update sweeps once more. */
export const sweepTriggerId = (number: number, updatedAt: string, contextRevision?: string): string =>
  contextRevision ? key('sweep-issue', String(number), updatedAt, contextRevision) : key('sweep-issue', String(number), updatedAt)

/** Builds the inferred candidate a sweep proposes for one Issue; the text names the sweep so it cannot pass for a person. */
export function sweepTrigger(issue: SweepIssue, actor: string, now: string, contextRevision?: string): Trigger {
  const labels = (issue.labels ?? []).map(label => label.name).join(', ')
  const body = (issue.body ?? '').replace(/<!--[\s\S]*?-->/g, '').trim().slice(0, 1200)
  const text = `${SWEEP_MARK} 存量 Issue #${issue.number} 满足扫描条件，作为推断候选提交评估。重新评估不代表依赖已解除；须核当前历史、负责人和已有成果，禁止重复派工。\n标题：${issue.title}\n标签：${labels || '无'}\n最近更新：${issue.updatedAt}\n正文摘录：\n${body || '（空）'}`
  return { id: sweepTriggerId(issue.number, issue.updatedAt, contextRevision), source: 'github', threads: [{ source: 'github', id: String(issue.number) }],
    actor: { source: 'github', id: actor }, human: false, at: now, text, url: issue.url,
    meta: { number: issue.number, isPr: false, kind: 'issue', sweep: true } }
}

/**
 * Runs one sweep round: it proposes up to `maxPerRound` Issues that are unassigned, have no pull request, and whose Thread no
 * live Ticket follows, and marks each emitted Trigger so a restart does not propose it again.
 */
export async function sweepRound(config: SweepConfig, deps: SweepDeps): Promise<SweepOutcome> {
  const outcome: SweepOutcome = { emitted: 0, considered: 0, skipped: [] }
  if (!config.labels.length) return outcome
  if (config.maxOpenTickets > 0 && deps.openTickets >= config.maxOpenTickets) return outcome
  const issues = await deps.list()
  const flight = deps.inFlight()
  for (const issue of issues) {
    if (outcome.emitted >= config.maxPerRound) break
    outcome.considered += 1
    const skip = (why: string) => { outcome.skipped.push({ number: issue.number, why }) }
    if (config.skipAssigned && (issue.assignees ?? []).length) { skip('assigned'); continue }
    if (flight.has(`github:${issue.number}`)) { skip('in-flight'); continue }
    const id = sweepTriggerId(issue.number, issue.updatedAt, deps.contextRevision)
    if (deps.emitted(id)) { skip('done'); continue }
    if (config.skipWithOpenPull && await deps.hasOpenPull(issue.number)) { skip('has-open-pr'); continue }
    const received = await deps.receive(sweepTrigger(issue, deps.actor, deps.now(), deps.contextRevision))
    if (received === 'filtered') { skip('filtered'); continue }
    if (received === 'duplicate') { deps.mark(id); skip('duplicate'); continue }
    deps.mark(id)
    outcome.emitted += 1
  }
  return outcome
}
