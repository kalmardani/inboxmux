import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { loadConfig, updateConfigFile, type Config } from '../config.js'
import type { FetchFn } from '../http.js'
import { log } from '../log.js'
import {
  authorizationUrl,
  createPkce,
  exchangeCode,
  GOOGLE_REQUIRED_SCOPE,
  microsoftAdminConsentUrl,
  randomState,
  revokeToken,
  type Pkce,
} from '../oauth.js'
import { clientFor } from '../providers/index.js'
import { gmailProfile } from '../providers/gmail.js'
import { graphProfile } from '../providers/graph.js'
import type { AccountStore } from '../store.js'
import type { TokenManager } from '../tokens.js'
import { UserFacingError, type ProviderKind } from '../types.js'
import { homePage, resultPage } from './page.js'

/**
 * Local account manager. Listens on loopback only and defends against the
 * usual attacks on localhost web apps:
 *  - DNS rebinding: requests with an unexpected Host header are refused
 *  - CSRF: state changing requests need the session cookie (SameSite=Strict),
 *    a matching csrf form field and a same origin Origin header
 *  - OAuth: PKCE plus a single use, expiring state parameter
 */
export interface UiOptions {
  store: AccountStore
  tokens: TokenManager
  config?: Config
  port: number
  fetchFn?: FetchFn
  /** Fixed session secret for tests. Random when omitted. */
  session?: string
}

export interface UiHandle {
  url: string
  loginUrl: string
  close(): Promise<void>
  server: Server
}

const PENDING_TTL_MS = 10 * 60 * 1000
const COOKIE = 'inboxmux_session'

export async function startUi(opts: UiOptions): Promise<UiHandle> {
  const session = opts.session ?? randomBytes(24).toString('base64url')
  const fetchFn = opts.fetchFn ?? fetch
  const base = `http://localhost:${opts.port}`
  const allowedHosts = new Set([`localhost:${opts.port}`, `127.0.0.1:${opts.port}`, `[::1]:${opts.port}`])
  const pending = new Map<string, { provider: ProviderKind; pkce: Pkce; created: number }>()
  const config = () => opts.config ?? loadConfig()
  // Post/redirect/get: action results travel to the home page through a short lived flash id.
  const flashes = new Map<string, { message: { kind: 'info' | 'error'; text: string }; created: number }>()

  const sameSecret = (a: string | undefined) =>
    typeof a === 'string' && a.length === session.length && timingSafeEqual(Buffer.from(a), Buffer.from(session))

  const send = (res: ServerResponse, status: number, html: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; " +
        "form-action 'self' https://accounts.google.com https://login.microsoftonline.com",
      ...extra,
    })
    res.end(html)
  }
  const redirect = (res: ServerResponse, location: string, extra: Record<string, string> = {}) => {
    res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin', ...extra })
    res.end()
  }
  const done = (res: ServerResponse, message: { kind: 'info' | 'error'; text: string }) => {
    for (const [key, value] of flashes) if (Date.now() - value.created > 60_000) flashes.delete(key)
    const id = randomBytes(9).toString('base64url')
    flashes.set(id, { message, created: Date.now() })
    return redirect(res, `/?flash=${id}`)
  }
  const home = (res: ServerResponse, message?: { kind: 'info' | 'error'; text: string }, status = 200) => {
    const c = config()
    send(
      res,
      status,
      homePage({
        accounts: opts.store.list(),
        csrf: session,
        googleReady: Boolean(c.google.clientId && c.google.clientSecret),
        microsoftReady: Boolean(c.microsoft.clientId),
        microsoftTenant: c.microsoft.tenant,
        redirectBase: base,
        capabilities: c.capabilities,
        configDir: c.dir,
        message,
      }),
    )
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host ?? ''
    if (!allowedHosts.has(host)) return send(res, 421, resultPage('Wrong host', 'This server only answers on localhost.', false))
    const url = new URL(req.url ?? '/', base)
    const cookie = parseCookies(req.headers.cookie)[COOKIE]
    const authed = sameSecret(cookie)

    if (req.method === 'GET' && (url.pathname === '/oauth/google/callback' || url.pathname === '/oauth/microsoft/callback')) {
      const provider: ProviderKind = url.pathname.includes('google') ? 'google' : 'microsoft'
      return callback(provider, url, res)
    }

    if (req.method === 'GET' && url.pathname === '/') {
      const token = url.searchParams.get('token')
      if (token !== null) {
        if (!sameSecret(token)) return send(res, 403, resultPage('Link expired', 'Open the link printed by `inboxmux ui` again.', false))
        return redirect(res, '/', { 'Set-Cookie': `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/` })
      }
      if (!authed) return send(res, 401, resultPage('Locked', 'Open the link printed by `inboxmux ui` in your terminal.', false))
      const flash = flashes.get(url.searchParams.get('flash') ?? '')
      flashes.delete(url.searchParams.get('flash') ?? '')
      return home(res, flash?.message)
    }

    if (req.method === 'POST') {
      if (!authed) return send(res, 401, resultPage('Locked', 'Session missing. Open the link printed by `inboxmux ui`.', false))
      const origin = req.headers.origin
      if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) {
        return send(res, 403, resultPage('Blocked', 'Cross-site request refused.', false))
      }
      const form = await readForm(req)
      if (!sameSecret(form.get('csrf') ?? undefined)) return send(res, 403, resultPage('Blocked', 'Invalid form token.', false))
      try {
        return await action(url.pathname, form, res)
      } catch (err) {
        if (err instanceof UserFacingError) return done(res, { kind: 'error', text: err.message })
        throw err
      }
    }
    send(res, 404, resultPage('Not found', 'Nothing here.', false))
  }

  const action = async (path: string, form: URLSearchParams, res: ServerResponse) => {
    const email = (form.get('email') ?? '').toLowerCase()
    switch (path) {
      case '/connect/google':
      case '/connect/microsoft': {
        const provider: ProviderKind = path.endsWith('google') ? 'google' : 'microsoft'
        const state = randomState()
        const pkce = createPkce()
        sweep()
        pending.set(state, { provider, pkce, created: Date.now() })
        return redirect(res, authorizationUrl(config(), provider, { redirectUri: redirectUri(provider), state, pkce }))
      }
      case '/accounts/remove': {
        const account = opts.store.resolve(email)
        let revoked = false
        try {
          revoked = await revokeToken(account.provider, opts.store.refreshToken(account.email), fetchFn)
        } catch (err) {
          log.warn(`Token revocation failed for a removed account: ${(err as Error).message}`)
        }
        opts.store.remove(account.email)
        opts.tokens.forget(account.email)
        return done(res, { kind: 'info', text: `${account.email} removed${revoked ? ' and its access revoked at Google' : ''}.` })
      }
      case '/accounts/label': {
        const label = (form.get('label') ?? '').trim()
        opts.store.setLabel(email, label || undefined)
        return done(res, { kind: 'info', text: `Label saved for ${email}.` })
      }
      case '/accounts/check': {
        const account = opts.store.resolve(email)
        await opts.tokens.get(account, true)
        return done(res, { kind: 'info', text: `${account.email} works.` })
      }
      case '/setup/google': {
        const clientId = (form.get('clientId') ?? '').trim()
        const clientSecret = (form.get('clientSecret') ?? '').trim()
        if (!/\.apps\.googleusercontent\.com$/.test(clientId) || !clientSecret) {
          throw new UserFacingError('invalid_client', 'Paste the client ID (ends with .apps.googleusercontent.com) and the client secret.')
        }
        updateConfigFile(config().dir, (c) => {
          c.google = { clientId, clientSecret }
        })
        return done(res, { kind: 'info', text: 'Google client saved.' })
      }
      case '/setup/microsoft': {
        const clientId = (form.get('clientId') ?? '').trim()
        const tenant = (form.get('tenant') ?? '').trim() || 'common'
        if (!/^[0-9a-f-]{36}$/i.test(clientId)) throw new UserFacingError('invalid_client', 'The application (client) ID is a GUID.')
        updateConfigFile(config().dir, (c) => {
          c.microsoft = { ...(c.microsoft ?? {}), clientId, tenant }
        })
        return done(res, { kind: 'info', text: 'Microsoft app saved.' })
      }
      default:
        return send(res, 404, resultPage('Not found', 'Unknown action.', false))
    }
  }

  const redirectUri = (provider: ProviderKind) => `${base}/oauth/${provider}/callback`

  const sweep = () => {
    for (const [key, value] of pending) if (Date.now() - value.created > PENDING_TTL_MS) pending.delete(key)
  }

  const callback = async (provider: ProviderKind, url: URL, res: ServerResponse) => {
    sweep()
    const state = url.searchParams.get('state') ?? ''
    const flow = pending.get(state)
    pending.delete(state)
    if (!flow || flow.provider !== provider) {
      return send(res, 400, resultPage('Sign-in expired', 'Start the connection again from the account page.', false))
    }
    const error = url.searchParams.get('error')
    if (error) {
      const detail = (url.searchParams.get('error_description') ?? error).slice(0, 300)
      const consent = /AADSTS65001|AADSTS90094|AADSTS90008|consent|admin/i.test(detail)
      if (provider === 'microsoft' && (error === 'access_denied' || consent)) {
        return send(
          res,
          400,
          resultPage(
            'Not connected',
            'The sign-in was cancelled, or your organisation lets only an administrator approve apps with mail access ' +
              '(the Microsoft page then says Admin approval required). In that case send this approval link to your ' +
              'Microsoft 365 administrator, then connect again once it is approved.',
            false,
            microsoftAdminConsentUrl(config(), redirectUri('microsoft')),
          ),
        )
      }
      return send(res, 400, resultPage('Sign-in cancelled', detail, false))
    }
    const code = url.searchParams.get('code')
    if (!code) return send(res, 400, resultPage('Sign-in failed', 'No authorization code was returned.', false))
    try {
      const c = config()
      const tokens = await exchangeCode(c, provider, { code, redirectUri: redirectUri(provider), verifier: flow.pkce.verifier }, fetchFn)
      if (!tokens.refreshToken) {
        throw new UserFacingError('no_refresh_token', 'The provider returned no refresh token. Remove the app from your account permissions and try again.')
      }
      if (provider === 'google' && !tokens.scopes.includes(GOOGLE_REQUIRED_SCOPE)) {
        throw new UserFacingError('scope_missing', 'Gmail access was not granted. Connect again and tick the Gmail permission on the consent screen.')
      }
      if (provider === 'microsoft' && !tokens.scopes.some((s) => /mail\.readwrite/i.test(s))) {
        throw new UserFacingError('scope_missing', 'Mail access was not granted. Connect again and accept the requested permissions.')
      }
      const http = clientFor({ email: 'new account', provider }, async () => tokens.accessToken, fetchFn)
      const profile = provider === 'google' ? await gmailProfile(http) : await graphProfile(http)
      const account = opts.store.upsert(
        { email: profile.email, provider, displayName: profile.displayName, aliases: profile.aliases, scopes: tokens.scopes },
        tokens.refreshToken,
      )
      opts.tokens.forget(account.email)
      log.info(`Connected a ${provider} account.`)
      return send(res, 200, resultPage('Account connected', `${account.email} is now available to your MCP clients.`, true))
    } catch (err) {
      const text = err instanceof UserFacingError ? err.message : 'Unexpected error. See the terminal for details.'
      if (!(err instanceof UserFacingError)) log.error(`OAuth callback failed: ${(err as Error).stack}`)
      return send(res, 400, resultPage('Could not connect', text, false))
    }
  }

  const listener = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((err) => {
      log.error(`UI request failed: ${(err as Error).stack}`)
      if (!res.headersSent) send(res, 500, resultPage('Error', 'Unexpected error. See the terminal for details.', false))
    })
  }
  const server = createServer(listener)
  const extra = createServer(listener)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, '127.0.0.1', () => resolve())
  })
  // Browsers may resolve localhost to ::1 first. Listen there too when IPv6 is available.
  await new Promise<void>((resolve) => {
    extra.once('error', () => resolve())
    extra.listen(opts.port, '::1', () => resolve())
  })

  return {
    url: base,
    loginUrl: `${base}/?token=${session}`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        extra.close()
        server.close(() => resolve())
        server.closeAllConnections()
        extra.closeAllConnections()
      }),
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim()
  }
  return out
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 64 * 1024) throw new UserFacingError('too_large', 'Form too large.', 413)
    chunks.push(chunk as Buffer)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}
