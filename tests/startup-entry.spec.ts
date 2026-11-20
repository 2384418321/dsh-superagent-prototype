import { expect, it, vi } from 'vitest'

const fakes = vi.hoisted(() => ({ lock: vi.fn(), release: vi.fn(), runtime: vi.fn(), sleep: vi.fn() }))
vi.mock('proper-lockfile', () => ({ lockSync: fakes.lock }))
vi.mock('node:timers/promises', () => ({ setTimeout: fakes.sleep }))
vi.mock('../src/deployment.ts', () => ({ Config: {}, machineOf: () => ({ stateDir: '/tmp' }) }))
vi.mock('../src/app/runtime.ts', () => ({ Runtime: fakes.runtime }))

it('checks and releases the startup lock before registering the runtime', async () => {
  fakes.lock.mockImplementationOnce(() => { throw Object.assign(new Error('locked'), { code: 'ELOCKED' }) })
    .mockReturnValueOnce(fakes.release)
  fakes.sleep.mockResolvedValue(undefined)
  fakes.runtime.mockImplementation(function () {
    expect(fakes.release).toHaveBeenCalledOnce()
    return { ready: Promise.resolve(), configured: () => true, stop: vi.fn() }
  })
  const { apply } = await import('../src/index.ts')
  const ctx = { get: vi.fn(() => ({ name: 'desktop' })), inject: vi.fn(), effect: (fn: () => unknown) => fn(), logger: { warn: vi.fn(), info: vi.fn() } }
  await apply(ctx as never, {} as never)
  expect(fakes.lock).toHaveBeenCalledTimes(2)
  expect(fakes.sleep).toHaveBeenCalledOnce()
  expect(fakes.runtime).toHaveBeenCalledOnce()
})


it.each(['web', 'superagent', undefined])('keeps the runtime out of the %s standalone profile', async (name) => {
  fakes.lock.mockClear()
  fakes.runtime.mockClear()
  const { apply } = await import('../src/index.ts')
  const ctx = { get: vi.fn(() => name ? { name } : undefined), inject: vi.fn(), effect: vi.fn(), logger: { warn: vi.fn(), info: vi.fn() } }
  await apply(ctx as never, {} as never)
  expect(ctx.effect).not.toHaveBeenCalled()
  expect(fakes.lock).not.toHaveBeenCalled()
  expect(fakes.runtime).not.toHaveBeenCalled()
})
