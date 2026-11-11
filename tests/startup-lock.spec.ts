import { mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { afterEach, expect, it, vi } from 'vitest'
import { retryStartupLock } from '../src/app/startup-lock.ts'

const dir = mkdtempSync(join(tmpdir(), 'startup-lock-'))
afterEach(() => { rmSync(`${dir}.lock`, { recursive: true, force: true }) })

it('retries once after a stale startup lock, without removing an active lock', async () => {
  const release = lockSync(dir, { stale: 30_000 })
  const start = () => lockSync(dir, { stale: 30_000 })
  const sleep = vi.fn(async () => { utimesSync(`${dir}.lock`, new Date(0), new Date(0)) })
  const recovered = await retryStartupLock(start, sleep)
  expect(sleep).toHaveBeenCalledOnce()
  expect(() => start()).toThrow()
  recovered()
  try { release() } catch { /* The test simulates a crashed lock holder. */ }
})

it('does not retry unrelated errors or a lock that is still active', async () => {
  const sleep = vi.fn(async () => {})
  await expect(retryStartupLock(() => { throw new Error('unrelated') }, sleep)).rejects.toThrow('unrelated')
  expect(sleep).not.toHaveBeenCalled()
  const release = lockSync(dir, { stale: 30_000 })
  await expect(retryStartupLock(() => lockSync(dir, { stale: 30_000 }), sleep)).rejects.toThrow()
  release()
})

it('does not restart the runtime when waiting is cancelled', async () => {
  const start = vi.fn(() => { throw Object.assign(new Error('held'), { code: 'ELOCKED' }) })
  await expect(retryStartupLock(start, async () => { throw new Error('cancelled') })).rejects.toThrow('cancelled')
  expect(start).toHaveBeenCalledOnce()
})
