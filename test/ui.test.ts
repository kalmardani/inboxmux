import { request } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, type Config } from '../src/config.js'
import { AccountStore } from '../src/store.js'
import { TokenManager } from '../src/tokens.js'
import { startUi, type UiHandle } from '../src/ui/server.js'
import { tempDir, useTestKey } from './helpers.js'

const SESSION = 'test-session-secret-123456'

interface Res {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

function http(port: number, path: string, opts: { method?: string; host?: string; cookie?: string; origin?: string; form?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const body = opts.form ? new URLSearchParams(opts.form).toString() : undefined
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? (body ? 'POST' : 'GET'),
        headers: {
          Host: opts.host ?? `localhost:${port}`,
          ...(opts.cookie ? { Cookie: opts.cookie } : {}),
          ...(opts.origin ? { Origin: opts.origin } : {}),
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

describe('account manager UI', () => {
  let ui: UiHandle
  let port: number
  let store: AccountStore
  let config: Config
  const cookie = `inboxmux_session=${SESSION}`
  let fetchCalls: string[] = []

  beforeEach(async () => {
    useTestKey()
    const dir = tempDir()
    config = {
      ...loadConfig({ INBOXMUX_HOME: dir }),
      google: { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'csecret' },
      microsoft: { clientId: '11111111-2222-3333-4444-555555555555', tenant: 'common' },
    }
    store = new AccountStore(dir)
    port = 20000 + Math.floor(Math.random() * 20000)
    fetchCalls = []
    const fetchFn = (async (url: string | URL | Request) => {
      const u = String(url)
      fetchCalls.push(u)
      if (u === 'https://oauth2.googleapis.com/token') {
        return Response.json({ access_token: 'at', expires_in: 3600, refresh_token: 'rt', scope: 'https://www.googleapis.com/auth/gmail.modify' })
      }
      if (u === 'https://oauth2.googleapis.com/revoke') return new Response('', { status: 200 })
      if (u.endsWith('/profile')) return Response.json({ emailAddress: 'New@Gmail.com' })
      if (u.endsWith('/settings/sendAs')) return Response.json({ sendAs: [{ sendAsEmail: 'new@gmail.com', isPrimary: true, displayName: 'New' }] })
      return new Response('{}', { status: 404 })
    }) as typeof fetch
    ui = await startUi({ store, tokens: new TokenManager(store, config, fetchFn), config, port, fetchFn, session: SESSION })
  })

  afterEach(async () => {
    await ui.close()
  })

  it('refuses foreign Host headers (DNS rebinding)', async () => {
    const res = await http(port, '/', { host: 'attacker.example', cookie })
    expect(res.status).toBe(421)
  })

  it('requires the session link and then sets a strict cookie', async () => {
    expect((await http(port, '/')).status).toBe(401)
    expect((await http(port, '/?token=wrong')).status).toBe(403)
    const login = await http(port, `/?token=${SESSION}`)
    expect(login.status).toBe(303)
    expect(String(login.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/)
    const home = await http(port, '/', { cookie })
    expect(home.status).toBe(200)
    expect(home.headers['content-security-policy']).toContain("default-src 'none'")
    // no-referrer would make browsers send Origin: null on our own form posts
    expect(home.headers['referrer-policy']).toBe('same-origin')
    expect(home.body).toContain('Connect a Gmail account')
  })

  it('blocks cross site posts and missing form tokens', async () => {
    expect((await http(port, '/connect/google', { form: { csrf: SESSION } })).status).toBe(401)
    expect((await http(port, '/connect/google', { cookie, form: { csrf: 'nope' } })).status).toBe(403)
    expect((await http(port, '/connect/google', { cookie, origin: 'https://evil.example', form: { csrf: SESSION } })).status).toBe(403)
    expect((await http(port, '/connect/google', { cookie, origin: 'null', form: { csrf: SESSION } })).status).toBe(403)
  })

  it('runs the Google flow with PKCE and a single use state', async () => {
    const start = await http(port, '/connect/google', { cookie, origin: `http://localhost:${port}`, form: { csrf: SESSION } })
    expect(start.status).toBe(303)
    const auth = new URL(String(start.headers.location))
    expect(auth.origin).toBe('https://accounts.google.com')
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256')
    expect(auth.searchParams.get('redirect_uri')).toBe(`http://localhost:${port}/oauth/google/callback`)
    const state = auth.searchParams.get('state') ?? ''

    const bad = await http(port, `/oauth/google/callback?state=forged&code=c`)
    expect(bad.status).toBe(400)

    const ok = await http(port, `/oauth/google/callback?state=${state}&code=c`)
    expect(ok.status).toBe(200)
    expect(ok.body).toContain('new@gmail.com is now available')
    expect(store.list()).toMatchObject([{ email: 'new@gmail.com', provider: 'google', displayName: 'New' }])
    expect(store.refreshToken('new@gmail.com')).toBe('rt')

    const replay = await http(port, `/oauth/google/callback?state=${state}&code=c`)
    expect(replay.status).toBe(400)
  })

  it('explains admin approval for Microsoft work accounts', async () => {
    const start = await http(port, '/connect/microsoft', { cookie, form: { csrf: SESSION } })
    const auth = new URL(String(start.headers.location))
    expect(auth.origin).toBe('https://login.microsoftonline.com')
    expect(auth.searchParams.get('scope')).toBe('offline_access User.Read Mail.ReadWrite Mail.Send')
    const state = auth.searchParams.get('state') ?? ''
    const res = await http(port, `/oauth/microsoft/callback?error=access_denied&error_subcode=cancel&state=${state}`)
    expect(res.status).toBe(400)
    expect(res.body).toContain('Admin approval required')
    expect(res.body).toContain('https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=11111111-2222-3333-4444-555555555555')
    expect(res.body).toContain('Mail.ReadWrite')
  })

  it('escapes account data in the page', async () => {
    store.upsert({ email: 'x@y.com', provider: 'google', aliases: ['<script>alert(1)</script>@y.com'], scopes: [] }, 't')
    const home = await http(port, '/', { cookie })
    expect(home.body).not.toContain('<script>alert(1)</script>')
    expect(home.body).toContain('&lt;script&gt;')
  })

  it('removes an account and revokes its Google token', async () => {
    store.upsert({ email: 'x@y.com', provider: 'google', aliases: [], scopes: [] }, 'refresh-x')
    const res = await http(port, '/accounts/remove', { cookie, form: { csrf: SESSION, email: 'x@y.com' } })
    expect(res.status).toBe(303)
    const page = await http(port, String(res.headers.location), { cookie })
    expect(page.body).toContain('x@y.com removed and its access revoked at Google')
    expect((await http(port, String(res.headers.location), { cookie })).body).not.toContain('removed')
    expect(store.list()).toEqual([])
    expect(fetchCalls).toContain('https://oauth2.googleapis.com/revoke')
  })
})
