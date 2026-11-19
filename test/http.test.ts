import { describe, expect, it } from 'vitest'
import { authedClient, fetchWithRetry } from '../src/http.js'

function scripted(responses: Array<() => Response>) {
  const seen: Array<{ url: string; auth: string | null; method: string }> = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), method: init?.method ?? 'GET' })
    const next = responses.shift()
    if (!next) throw new Error('no more responses')
    return next()
  }) as typeof fetch
  return { fn, seen }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('fetchWithRetry', () => {
  it('retries GET on 503 and honours Retry-After', async () => {
    const { fn, seen } = scripted([json(503, {}, { 'retry-after': '0' }), json(200, { ok: 1 })])
    const res = await fetchWithRetry(fn, 'https://api.test/x')
    expect(res.status).toBe(200)
    expect(seen).toHaveLength(2)
  })

  it('never retries POST', async () => {
    const { fn, seen } = scripted([json(503, {}), json(200, {})])
    const res = await fetchWithRetry(fn, 'https://api.test/x', { method: 'POST' })
    expect(res.status).toBe(503)
    expect(seen).toHaveLength(1)
  })
})

describe('authedClient', () => {
  it('refreshes the token once on 401', async () => {
    const { fn, seen } = scripted([json(401, {}), json(200, { value: 1 })])
    const forced: boolean[] = []
    const client = authedClient({
      provider: 'google',
      email: 'a@x.com',
      fetchFn: fn,
      getToken: async (force) => {
        forced.push(Boolean(force))
        return force ? 'fresh' : 'stale'
      },
    })
    expect(await client.json('https://api.test/x')).toEqual({ value: 1 })
    expect(forced).toEqual([false, true])
    expect(seen.map((s) => s.auth)).toEqual(['Bearer stale', 'Bearer fresh'])
  })

  it('maps a missing scope to a reconnect hint without leaking internals', async () => {
    const { fn } = scripted([json(403, { error: { code: 403, message: 'Request had insufficient authentication scopes.' } })])
    const client = authedClient({ provider: 'google', email: 'a@x.com', fetchFn: fn, getToken: async () => 't' })
    await expect(client.json('https://api.test/x')).rejects.toMatchObject({
      code: 'insufficient_scope',
      message: expect.stringContaining('Reconnect it with `inboxmux ui`'),
    })
  })

  it('reports a persistent 401 as reauth_required', async () => {
    const { fn } = scripted([json(401, {}), json(401, { error: { message: 'expired' } })])
    const client = authedClient({ provider: 'microsoft', email: 'a@x.com', fetchFn: fn, getToken: async () => 't' })
    await expect(client.json('https://api.test/x')).rejects.toMatchObject({ code: 'reauth_required' })
  })
})
