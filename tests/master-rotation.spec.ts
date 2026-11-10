import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { Runtime } from '../src/app/runtime.ts'
import { Context } from '@deepseek-ai/cordis'
import { startRuntime, type Host } from './fixtures/host.ts'
import { testMachine } from './fixtures/deployment.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

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
  await h.runtime.stop()
  const ctx = new Context()
  for (const name of ['agents', 'llm', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'subprocess', 'webServer', 'jobs', 'subagents'])
    ctx.reflect.provide(name, h.ctx.get(name))
  const next = new Runtime(ctx, testMachine({ stateDir: h.directory }), vi.fn())
  try {
    await next.ready
    expect(next.masterId).toBe(target)
    expect(h.deliveries.mock.calls.some(([call]) => call.sessionId === target && String(call.text).includes('Continue the queue.'))).toBe(true)
  } finally { await next.stop() }
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

it('restores processing if a panel-initiated switch finds running work', async () => {
  await h.runtime.idle()
  const old = h.runtime.masterId
  h.agents.get(old)!.status = 'running'
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue.', manageProcessing: true })
  expect(response.status).toBe(409)
  expect(h.runtime.store.settings().paused).toBe(false)
  expect(h.runtime.store.get(KV.runtime.masterId)).toBe(old)
  h.agents.get(old)!.status = 'idle'
})

it('restores processing if pausing fails after the setting was saved', async () => {
  await h.runtime.idle()
  const old = h.runtime.masterId
  h.agents.get(old)!.status = 'idle'
  const pause = h.runtime.settings.pause.bind(h.runtime.settings)
  vi.spyOn(h.runtime.settings, 'pause').mockImplementationOnce(async () => { await pause(true, 'tool'); throw new Error('delivery failed') })
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue.', manageProcessing: true })
  expect(response.status).toBe(500)
  expect(h.runtime.store.settings().paused).toBe(false)
  expect(h.runtime.store.get(KV.runtime.masterId)).toBe(old)
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

it('cancels rotation without restarting if a session becomes active while draining', async () => {
  await h.runtime.settings.pause(true, 'panel')
  await h.runtime.idle()
  const old = h.runtime.masterId
  const agent = h.agents.get(old)!
  agent.status = 'idle'
  const drain = h.runtime.effects.drain.bind(h.runtime.effects)
  vi.spyOn(h.runtime.effects, 'drain').mockImplementationOnce(async () => { await drain(); agent.status = 'running' })
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue.' })
  expect(response.status).toBe(409)
  expect(h.runtime.store.get(KV.runtime.masterId)).toBe(old)
  expect(agent.status).toBe('running')
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

it('preserves pending orchestrator notices in the handoff', async () => {
  await h.runtime.settings.pause(true, 'panel')
  await h.runtime.idle()
  const old = h.runtime.masterId
  const agent = h.agents.get(old)!
  agent.status = 'idle'
  agent.inbox.nextStep.push({ id: 'notice', role: 'user', content: [{ type: 'text', text: 'Ticket #3438 ended.' }], source: { kind: 'dsh-superagent', form: 'notice' } } as never)
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue.' })
  expect(response.status).toBe(200)
  expect(h.runtime.store.get(KV.runtime.handoff)?.text).toContain('Ticket #3438 ended.')
})

it('starts the replacement as the actual main session after restart', async () => {
  await h.runtime.settings.pause(true, 'panel')
  await h.runtime.idle()
  const old = h.runtime.masterId
  h.agents.get(old)!.status = 'idle'
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue the existing queue.', manageProcessing: true })
  expect(response.status).toBe(200)
  await h.runtime.stop()
  const ctx = new Context()
  for (const name of ['agents', 'llm', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'subprocess', 'webServer', 'jobs', 'subagents'])
    ctx.reflect.provide(name, h.ctx.get(name))
  const next = new Runtime(ctx, testMachine({ stateDir: h.directory }), vi.fn())
  try {
    await next.ready
    expect(next.masterId).toBe(response.body.masterId)
    expect(next.store.settings().paused).toBe(true)
    expect(h.agents.has(next.masterId)).toBe(true)
    await next.idle()
    expect(next.store.get(KV.runtime.handoff)).toBeUndefined()
    expect(h.deliveries.mock.calls.some(([call]) => call.sessionId === next.masterId && String(call.text).includes('Continue the existing queue.'))).toBe(true)
  } finally { await next.stop() }
})

it('resumes processing after a panel-initiated switch has delivered its handoff', async () => {
  await h.runtime.idle()
  const old = h.runtime.masterId
  h.agents.get(old)!.status = 'idle'
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue.', manageProcessing: true })
  expect(response.status).toBe(200)
  await h.runtime.stop()
  const ctx = new Context()
  for (const name of ['agents', 'llm', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'subprocess', 'webServer', 'jobs', 'subagents'])
    ctx.reflect.provide(name, h.ctx.get(name))
  const next = new Runtime(ctx, testMachine({ stateDir: h.directory }), vi.fn())
  try {
    await next.ready
    expect(next.store.settings().paused).toBe(false)
    expect(h.deliveries.mock.calls.some(([call]) => call.sessionId === next.masterId && call.text.includes('Continue.'))).toBe(true)
  } finally { await next.stop() }
})

it('does not override a pause changed while rotation was pending', async () => {
  await h.runtime.idle()
  const old = h.runtime.masterId
  h.agents.get(old)!.status = 'idle'
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue.', manageProcessing: true })
  expect(response.status).toBe(200)
  await h.runtime.settings.pause(false, 'tool')
  await h.runtime.settings.pause(true, 'tool')
  await h.runtime.stop()
  const ctx = new Context()
  for (const name of ['agents', 'llm', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'subprocess', 'webServer', 'jobs', 'subagents'])
    ctx.reflect.provide(name, h.ctx.get(name))
  const next = new Runtime(ctx, testMachine({ stateDir: h.directory }), vi.fn())
  try { await next.ready; expect(next.store.settings().paused).toBe(true) } finally { await next.stop() }
})

it('retains the handoff if replacement startup cannot persist its inbox', async () => {
  await h.runtime.settings.pause(true, 'panel')
  await h.runtime.idle()
  const old = h.runtime.masterId
  h.agents.get(old)!.status = 'idle'
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue safely.' })
  expect(response.status).toBe(200)
  await h.runtime.stop()
  const ctx = new Context()
  for (const name of ['agents', 'llm', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'subprocess', 'webServer', 'jobs', 'subagents'])
    ctx.reflect.provide(name, h.ctx.get(name))
  const persistence = h.ctx.get('sessionPersistence')!
  vi.mocked(persistence.flush).mockRejectedValueOnce(new Error('disk unavailable'))
  const next = new Runtime(ctx, testMachine({ stateDir: h.directory }), vi.fn())
  try {
    await expect(next.ready).rejects.toThrow('disk unavailable')
    expect(next.store.get(KV.runtime.handoff)).toEqual({ masterId: response.body.masterId, text: 'Continue safely.' })
  } finally { await next.stop() }
})

it('keeps queued effects and records a new main session for restart', async () => {
  await h.runtime.settings.pause(true, 'panel')
  await h.runtime.idle()
  const old = h.runtime.masterId
  const agent = h.agents.get(old)!
  agent.status = 'idle'
  h.runtime.sessions.relay('rotation-test', 'Preserve this queued item')
  h.runtime.store.db.prepare('UPDATE effect SET due = ? WHERE kind = ? AND key = ?').run(Date.now() + 60000, 'relay', 'rotation-test')
  const response = await h.api('POST', 'master/rotate', { expectedMasterId: old, handoff: 'Continue the existing queue.' })
  expect(response.status).toBe(200)
  expect(response.body.masterId).not.toBe(old)
  expect(h.runtime.store.get(KV.runtime.masterId)).toBe(response.body.masterId)
  expect(h.runtime.effects.pending('relay', 'rotation-test')).toBe(true)
})
