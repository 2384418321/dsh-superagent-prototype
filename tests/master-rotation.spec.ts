import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { deferred } from './fixtures/async.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

it('rotates the main session without interrupting a running worker or its background work', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修复回归'))
  const old = h.runtime.masterId
  const previous = h.agents.get(old)!
  previous.status = 'idle'
  previous.inbox.nextTurn.length = 0
  previous.inbox.nextStep.length = 0
  const worker = h.agents.get(sessionId)!
  expect(worker.status).toBe('running')
  const job = h.jobs.run(sessionId)
  const child = h.subagents.spawn(sessionId)
  const assignment = h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)
  const restart = vi.spyOn(h.runtime.setup, 'restart')

  const preparing = deferred(), release = deferred()
  h.controller.rename.mockImplementationOnce(async () => { preparing.resolve(); await release.promise })
  const rotation = h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue.', manageProcessing: true })
  const phase = await Promise.race([preparing.promise.then(() => 'preparing'), rotation.then(() => 'completed')])
  try {
    expect(phase).toBe('preparing')
    h.runtime.engine.note(ticket.id, 'Continue working during the main Session handoff.')
    await h.runtime.effects.idle('delivery')
    expect(h.deliveries.mock.calls.some(([call]) => call.sessionId === sessionId && call.text.includes('Continue working during'))).toBe(true)
  } finally { release.resolve() }
  const response = await rotation
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  await h.runtime.idle()

  expect(h.runtime.masterId).toBe(response.body.masterId)
  expect(restart).not.toHaveBeenCalled()
  expect(h.agents.get(sessionId)).toBe(worker)
  expect(worker.status).toBe('running')
  expect(worker.cancel).not.toHaveBeenCalled()
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments).toEqual([expect.objectContaining({ ...assignment, deliveredAt: expect.any(String) })])
  expect(h.jobs.service.list(sessionId)).toContainEqual(expect.objectContaining({ id: job, status: 'running' }))
  expect(h.subagents.live(child)).toBe(true)
})

it('binds the existing idle router session instead of creating a second replacement', async () => {
  await h.runtime.settings.pause(true, 'panel')
  await h.runtime.idle()
  const old = h.runtime.masterId
  h.agents.get(old)!.status = 'idle'
  const target = 'session-existing-router'
  await h.ctx.sessionController.create({ sessionId: target as never, workspaceId: h.directory as never, agentPreset: 'dsh-superagent-router' })
  const agent = h.agents.get(target)!
  Object.assign((agent as unknown as { session: object }).session, { header: { agentPreset: 'dsh-superagent-router' } })
  const request = { expectedMasterId: old, targetMasterId: target, handoff: 'Continue the queue.' }
  agent.status = 'running'
  expect((await h.api('POST', 'master/rotate', request)).status).toBe(409)
  agent.status = 'idle'
  const response = await h.api('POST', 'master/rotate', request)
  expect(response.status).toBe(200)
  expect(response.body.masterId).toBe(target)
  expect(h.runtime.store.get(KV.runtime.masterId)).toBe(target)
  await h.runtime.idle()
  expect((await h.api('GET', 'state')).body.masterId).toBe(target)
  expect(h.deliveries.mock.calls.map(([call]) => [call.sessionId, call.text])).toContainEqual([target, 'Continue the queue.'])
  expect(h.agents.get(target)).toBe(agent)
  expect(h.agents.has(old)).toBe(true)
  expect(h.tools.get(old)?.has('orchestrator_route')).toBe(false)
  expect(h.tools.get(target)?.has('orchestrator_route')).toBe(true)
})

it('refuses unknown and non-router replacement sessions', async () => {
  await h.runtime.settings.pause(true, 'panel')
  const old = h.runtime.masterId
  h.agents.get(old)!.status = 'idle'
  const request = { expectedMasterId: old, targetMasterId: 'wrong', handoff: 'Continue.' }
  expect((await h.api('POST', 'master/rotate', request)).status).toBe(409)
  await h.ctx.sessionController.create({ sessionId: 'wrong' as never, workspaceId: h.directory as never, agentPreset: 'dsh-superagent-worker' })
  Object.assign((h.agents.get('wrong') as unknown as { session: object }).session, { header: { agentPreset: 'dsh-superagent-worker' } })
  expect((await h.api('POST', 'master/rotate', request)).status).toBe(409)
  expect(h.runtime.store.get(KV.runtime.masterId)).toBe(old)
})

it('refuses rotation until dispatch is paused and the main session is idle', async () => {
  const old = h.runtime.masterId
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue the existing queue.' })
  expect(response.status).toBe(409)
  expect(h.runtime.store.get(KV.runtime.masterId)).toBe(old)
})

it('keeps processing enabled when the old main session is running', async () => {
  await h.runtime.idle()
  const old = h.runtime.masterId
  h.agents.get(old)!.status = 'running'
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue.', manageProcessing: true })
  expect(response.status).toBe(409)
  expect(h.runtime.store.settings().paused).toBe(false)
  expect(h.runtime.store.get(KV.runtime.masterId)).toBe(old)
  h.agents.get(old)!.status = 'idle'
})

it('keeps the old main session active if preparing the replacement fails', async () => {
  const old = h.runtime.masterId
  h.controller.rename.mockRejectedValueOnce(new Error('Could not prepare router'))
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue.', manageProcessing: true })
  expect(response.status).toBe(500)
  expect(h.runtime.store.settings().paused).toBe(false)
  expect(h.runtime.masterId).toBe(old)
  expect(h.runtime.store.get(KV.runtime.handoff)).toBeUndefined()
  expect(h.tools.get(old)?.has('orchestrator_route')).toBe(true)
  const candidate = [...h.agents.keys()].find(id => id !== old)
  if (candidate) expect(h.tools.get(candidate)?.has('orchestrator_route')).not.toBe(true)
  h.runtime.sessions.relay('preparation-failed', 'Still routed to the old session')
  await h.runtime.idle()
  expect(h.deliveries.mock.calls.some(([call]) => call.sessionId === old && call.text === 'Still routed to the old session')).toBe(true)
})

it('rejects a stale main identity', async () => {
  await h.runtime.settings.pause(true, 'panel')
  const old = h.runtime.masterId
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: 'outdated', handoff: 'Continue.' })
  expect(response.status).toBe(409)
  expect(h.runtime.store.get(KV.runtime.masterId)).toBe(old)
})

it('accepts only one concurrent rotation', async () => {
  await h.runtime.settings.pause(true, 'panel')
  await h.runtime.idle()
  const old = h.runtime.masterId
  h.agents.get(old)!.status = 'idle'
  const request = { expectedMasterId: old, handoff: 'Continue.' }
  const responses = await Promise.all([h.api('POST', 'master/rotate', request), h.api('POST', 'master/rotate', request)])
  expect(responses.map(response => response.status).sort()).toEqual([200, 409])
  expect(h.runtime.store.get(KV.runtime.masterId)).not.toBe(old)
})

it('refuses to interrupt a background job owned by the main session', async () => {
  await h.runtime.settings.pause(true, 'panel')
  await h.runtime.idle()
  const old = h.runtime.masterId
  h.agents.get(old)!.status = 'idle'
  h.jobs.run(old, 'in-flight')
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue.' })
  expect(response.status).toBe(409)
  expect(h.runtime.store.get(KV.runtime.masterId)).toBe(old)
})

it('cancels rotation if the old main session becomes active during preparation', async () => {
  await h.runtime.settings.pause(true, 'panel')
  await h.runtime.idle()
  const old = h.runtime.masterId
  const agent = h.agents.get(old)!
  h.controller.rename.mockImplementationOnce(async () => { agent.status = 'running' })
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue.' })
  expect(response.status).toBe(409)
  expect(h.runtime.store.get(KV.runtime.masterId)).toBe(old)
  expect(agent.status).toBe('running')
  expect(agent.cancel).not.toHaveBeenCalled()
  agent.status = 'idle'
  h.runtime.sessions.relay('after-cancel', 'Still running')
  await h.runtime.idle()
  expect(h.deliveries.mock.calls.some(([call]) => call.sessionId === old && call.text === 'Still running')).toBe(true)
})

it('does not strand unconsumed messages in the old main inbox', async () => {
  await h.runtime.settings.pause(true, 'panel')
  await h.runtime.idle()
  const old = h.runtime.masterId
  const agent = h.agents.get(old)!
  agent.status = 'idle'
  agent.inbox.nextTurn.push({ id: 'pending', role: 'user', content: [{ type: 'text', text: 'unconsumed' }] } as never)
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue.' })
  expect(response.status).toBe(409)
  expect(h.runtime.store.get(KV.runtime.masterId)).toBe(old)
})

it('moves an unopened offer ahead of waiting assessments without resuming processing', async () => {
  const old = h.runtime.masterId
  const trigger = feishu('1', '@bot 查一下回归')
  h.runtime.receive(trigger)
  await h.runtime.idle()
  expect(h.candidates()).toEqual([trigger.id])
  const waiting = feishu('2', '@bot 查另一条回归')
  h.runtime.receive(waiting)
  await h.runtime.idle()
  await h.runtime.settings.pause(true, 'panel')
  await h.runtime.idle()
  const evaluation = h.runtime.store.threads.active().find(thread => thread.evaluating?.triggerIds.includes(trigger.id))!.evaluating!
  expect(evaluation.offeredAt).toBeDefined()
  expect(evaluation.delivered).toBeUndefined()
  expect(evaluation.pausedAt).toBeDefined()
  const oldAgent = h.agents.get(old)!
  oldAgent.status = 'idle'
  oldAgent.inbox.nextStep.length = 0
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue.' })
  expect(response.status).toBe(200)
  const replacementDeliveries = () => h.deliveries.mock.calls.map(([call]) => call)
    .filter(call => call.sessionId === response.body.masterId).map(({ text }) => text)
  await h.runtime.idle()
  expect(h.runtime.store.settings().paused).toBe(true)
  expect(h.runtime.store.threads.active().find(thread => thread.evaluating?.id === evaluation.id)?.evaluating).toEqual(evaluation)
  expect(replacementDeliveries()).toEqual(['Continue.'])
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.idle()
  expect(replacementDeliveries()).toEqual(['Continue.', expect.stringContaining(trigger.id)])
})

it('keeps an opened assessment with the old main session', async () => {
  const old = h.runtime.masterId
  const trigger = feishu('1', '@bot 查一下回归')
  h.runtime.receive(trigger)
  await h.runtime.idle()
  const evaluation = h.runtime.store.threads.active().find(thread => thread.evaluating?.triggerIds.includes(trigger.id))!.evaluating!
  h.runtime.engine.candidateRead(evaluation.id)
  const oldAgent = h.agents.get(old)!
  oldAgent.status = 'idle'
  oldAgent.inbox.nextStep.length = 0
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue.', manageProcessing: true })
  expect(response.status).toBe(409)
  expect(h.runtime.masterId).toBe(old)
  expect(h.runtime.store.threads.active().find(thread => thread.evaluating?.id === evaluation.id)?.evaluating?.delivered).toBeDefined()
})

it('routes an assessment that was still queued to the replacement', async () => {
  await h.runtime.settings.pause(true, 'panel')
  const old = h.runtime.masterId
  const trigger = feishu('1', '@bot 查一下回归')
  h.runtime.receive(trigger)
  await h.runtime.idle()
  expect(h.candidates()).toEqual([])
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue.' })
  expect(response.status).toBe(200)
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.idle()
  expect(h.deliveries.mock.calls.map(([call]) => call)).toEqual([
    expect.objectContaining({ sessionId: response.body.masterId, text: 'Continue.' }),
    expect.objectContaining({ sessionId: response.body.masterId, text: expect.stringContaining(trigger.id) }),
  ])
})

it('preserves pending orchestrator notices in the handoff', async () => {
  await h.runtime.settings.pause(true, 'panel')
  await h.runtime.idle()
  const old = h.runtime.masterId
  const agent = h.agents.get(old)!
  agent.status = 'idle'
  agent.inbox.nextStep.push({ id: 'notice', role: 'user', content: [{ type: 'text', text: 'Ticket #3438 ended.' }], source: { kind: 'dsh-superagent', form: 'notice' } } as never)
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue.' })
  expect(response.status).toBe(200)
  await h.runtime.idle()
  expect(h.deliveries.mock.calls.find(([call]) => call.sessionId === response.body.masterId)?.[0].text).toContain('Ticket #3438 ended.')
  expect(agent.inbox.nextStep).toEqual([])
})

it('delivers the handoff before relays queued during cutover', async () => {
  const old = h.runtime.masterId
  const draining = deferred(), release = deferred()
  const idle = h.runtime.effects.idle.bind(h.runtime.effects)
  vi.spyOn(h.runtime.effects, 'idle').mockImplementationOnce(async kind => {
    draining.resolve()
    await release.promise
    await idle(kind)
  })
  const rotation = h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue.', manageProcessing: true })
  await Promise.race([draining.promise, rotation])
  try {
    h.runtime.sessions.relay('during-rotation', 'Newly queued work')
    await h.runtime.effects.idle('relay')
    expect(h.runtime.effects.pending('relay', 'during-rotation')).toBe(true)
    expect(h.deliveries.mock.calls).toHaveLength(0)
    expect(h.runtime.store.settings().paused).toBe(false)
  } finally { release.resolve() }
  const response = await rotation
  expect(response.status).toBe(200)
  await h.runtime.idle()
  expect(h.deliveries.mock.calls.map(([call]) => [call.sessionId, call.text])).toEqual([
    [response.body.masterId, 'Continue.'], [response.body.masterId, 'Newly queued work'],
  ])
  expect(h.runtime.store.get(KV.runtime.handoff)).toBeUndefined()
})

it('retains the handoff after a persistence failure and recovers without a duplicate message', async () => {
  const old = h.runtime.masterId
  const flush = vi.mocked(h.ctx.get('sessionPersistence')!.flush)
  flush.mockImplementation(async () => {
    if (h.deliveries.mock.calls.some(([call]) => call.text === 'Continue safely.')) throw new Error('disk unavailable')
  })
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue safely.', manageProcessing: true })
  expect(response.status).toBe(200)
  const target = response.body.masterId as string
  h.runtime.sessions.relay('after-failed-handoff', 'Waiting work')
  await h.runtime.idle()
  expect(h.runtime.store.get(KV.runtime.handoff)).toMatchObject({ masterId: target, text: 'Continue safely.' })
  // The first handoff turn can use its tools while a persistence retry still holds later automatic deliveries.
  await expect(h.runTool(target, 'orchestrator_read', { resource: 'tickets' })).resolves.toBeDefined()
  expect(h.deliveries.mock.calls.map(([call]) => [call.sessionId, call.text])).toEqual([[target, 'Continue safely.']])
  expect((await h.api('POST', 'master/rotate', { expectedMasterId: target, handoff: 'Replace again.', manageProcessing: true })).status).toBe(409)
  flush.mockResolvedValue(undefined)
  h.runtime.store.db.prepare("UPDATE effect SET due = 0 WHERE kind = 'handoff'").run()
  await h.runtime.idle()
  expect(h.runtime.store.get(KV.runtime.handoff)).toBeUndefined()
  expect(h.deliveries.mock.calls.map(([call]) => [call.sessionId, call.text])).toEqual([
    [target, 'Continue safely.'], [target, 'Waiting work'],
  ])
})

it('preserves a pause applied by the operator while a replacement is being prepared', async () => {
  const old = h.runtime.masterId
  h.controller.rename.mockImplementationOnce(async () => { await h.runtime.settings.pause(true, 'panel') })
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue.', manageProcessing: true })
  expect(response.status).toBe(200)
  await h.runtime.idle()
  expect(h.runtime.store.settings().paused).toBe(true)
})

it('uses a distinct handoff when a previously used router is selected again', async () => {
  const original = h.runtime.masterId
  const second = 'existing-router'
  await h.ctx.sessionController.create({ sessionId: second as never, workspaceId: h.directory as never, agentPreset: 'dsh-superagent-router' })
  for (const id of [original, second]) {
    const agent = h.agents.get(id)!
    Object.assign((agent as unknown as { session: object }).session, { header: { agentPreset: 'dsh-superagent-router' } })
  }
  for (const [from, to, handoff] of [[original, second, 'First.'], [second, original, 'Return.'], [original, second, 'Again.']] as const) {
    const fromAgent = h.agents.get(from)!
    fromAgent.status = 'idle'
    // The fake inbox retains claimed messages; finishing a turn clears the consumed handoff.
    fromAgent.inbox.nextTurn.length = 0
    const response = await h.api('POST', 'master/rotate', { expectedMasterId: from, targetMasterId: to, handoff, manageProcessing: true })
    expect(response.status).toBe(200)
    await h.runtime.idle()
  }
  const sentToSecond = h.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === second)
  expect(sentToSecond.map(call => call.text)).toEqual(['First.', 'Again.'])
  expect(sentToSecond[0]?.id).not.toBe(sentToSecond[1]?.id)
})

it('restores a handoff recorded by the previous version', async () => {
  await h.stop()
  const replacement = 'legacy-router'
  h = await startRuntime(store => {
    store.set(KV.runtime.masterId, replacement)
    store.set(KV.runtime.handoff, { masterId: replacement, text: 'Continue after restart.' })
    store.saveSettings({ ...store.settings(), paused: true })
  })
  await h.runtime.idle()
  expect(h.runtime.masterId).toBe(replacement)
  expect(h.runtime.store.settings().paused).toBe(true)
  expect(h.runtime.store.get(KV.runtime.handoff)).toBeUndefined()
  const messages = h.agents.get(replacement)!.followup.mock.calls.flatMap(([message]) => message.content)
  expect(messages).toContainEqual({ type: 'text', text: 'Continue after restart.' })
})

it('rotates with the current host descendant API without listChildren', async () => {
  await h.runtime.idle()
  const old = h.runtime.masterId
  h.agents.get(old)!.status = 'idle'
  const listDescendants = vi.fn(async () => [])
  Object.assign(h.subagents.service, { listChildren: undefined, listDescendants })
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue.', manageProcessing: true })
  expect(response.status).toBe(200)
  expect(listDescendants).toHaveBeenCalledWith(old)
})

it.each([
  { kind: 'child', id: 'external-child', activity: 'running' },
  { kind: 'diagnostic', id: 'unreadable-child', reason: 'unavailable' },
])('refuses rotation when the current host reports unresolved descendant work: %j', async row => {
  await h.runtime.idle()
  const old = h.runtime.masterId
  h.agents.get(old)!.status = 'idle'
  Object.assign(h.subagents.service, { listChildren: undefined, listDescendants: vi.fn(async () => [row]) })
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue.', manageProcessing: true })
  expect(response.status).toBe(409)
  expect(h.runtime.masterId).toBe(old)
  expect(h.runtime.store.settings().paused).toBe(false)
})

it('allows inactive historical descendants without loading them', async () => {
  await h.runtime.idle()
  const old = h.runtime.masterId
  h.agents.get(old)!.status = 'idle'
  Object.assign(h.subagents.service, {
    listChildren: undefined,
    listDescendants: vi.fn(async () => [{ kind: 'child', id: 'ended-child', activity: 'inactive' }]),
  })
  expect((await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue.', manageProcessing: true })).status).toBe(200)
  expect(h.agents.has('ended-child')).toBe(false)
})

it('refuses an unsupported discovery API without changing dispatch or the main session', async () => {
  await h.runtime.idle()
  const old = h.runtime.masterId
  h.agents.get(old)!.status = 'idle'
  Object.assign(h.subagents.service, { listChildren: undefined })
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue.', manageProcessing: true })
  expect(response.status).toBe(409)
  expect(h.runtime.masterId).toBe(old)
  expect(h.runtime.store.settings().paused).toBe(false)
})
