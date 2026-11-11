/** Retry once after the lock's stale interval; proper-lockfile remains the sole lock arbiter. */
export async function retryStartupLock<T>(start: () => T, wait: () => Promise<void>): Promise<T> {
  try { return start() } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ELOCKED') throw error
    await wait()
    return start()
  }
}
