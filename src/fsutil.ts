import { closeSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Creates a directory (and parents) readable only by the current user. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/**
 * Writes a file atomically: the data goes to a temporary sibling first and is
 * renamed over the target, so a crash never leaves a half written file.
 */
export function writeFileAtomic(path: string, data: string | Buffer, mode = 0o600): void {
  ensureDir(dirname(path))
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, data, { mode })
  try {
    renameSync(tmp, path)
  } catch (err) {
    removeQuietly(tmp)
    throw err
  }
}

/**
 * Runs `fn` while holding an exclusive lock file. The MCP server and the
 * account manager UI may run as separate processes and both write the account
 * store, so every read-modify-write cycle goes through this lock.
 */
export function withFileLock<T>(lockPath: string, fn: () => T, timeoutMs = 5000): T {
  const started = Date.now()
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx', 0o600))
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (isStale(lockPath)) {
        removeQuietly(lockPath)
        continue
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for the lock file ${lockPath}`)
      }
      sleepSync(25)
    }
  }
  try {
    return fn()
  } finally {
    removeQuietly(lockPath)
  }
}

function isStale(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > 10_000
  } catch {
    // The holder released the lock between our open and stat calls.
    return false
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Already gone, nothing to clean up.
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
