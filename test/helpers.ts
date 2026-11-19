import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AuthedClient } from '../src/http.js'
import type { AccountMeta } from '../src/types.js'

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'inboxmux-test-'))
}

export function useTestKey(): void {
  process.env.INBOXMUX_MASTER_KEY = randomBytes(32).toString('base64')
  process.env.INBOXMUX_NO_KEYCHAIN = '1'
}

export interface Call {
  url: string
  method: string
  body?: unknown
  headers: Record<string, string>
}

/** AuthedClient double. `route` returns the JSON body for a call or throws. */
export function fakeClient(route: (call: Call) => unknown): AuthedClient & { calls: Call[] } {
  const calls: Call[] = []
  const record = (url: string, init?: RequestInit): Call => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
    let body: unknown = init?.body
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch {
        // keep raw string
      }
    }
    const call = { url, method: (init?.method ?? 'GET').toUpperCase(), body, headers }
    calls.push(call)
    return call
  }
  return {
    calls,
    async json<T>(url: string, init?: RequestInit) {
      return route(record(url, init)) as T
    },
    async buffer(url: string, init?: RequestInit) {
      return route(record(url, init)) as Buffer
    },
    async send(url: string, init?: RequestInit) {
      route(record(url, init))
    },
  }
}

export function account(partial: Partial<AccountMeta> = {}): AccountMeta {
  const email = partial.email ?? 'me@example.com'
  return {
    email,
    provider: 'google',
    aliases: [email],
    scopes: [],
    addedAt: '2026-01-01T00:00:00.000Z',
    status: 'ok',
    ...partial,
  }
}

export function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}
