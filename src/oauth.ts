import { createHash, randomBytes } from 'node:crypto'
import type { Config } from './config.js'
import { fetchWithRetry, providerError, type FetchFn } from './http.js'
import { UserFacingError, type ProviderKind } from './types.js'

/**
 * OAuth 2.0 authorization code flow with PKCE (RFC 7636) against a loopback
 * redirect, for Google and the Microsoft identity platform.
 */

export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/gmail.modify']
export const GOOGLE_REQUIRED_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'

export function microsoftScopes(allowSend: boolean): string[] {
  return ['offline_access', 'User.Read', 'Mail.ReadWrite', ...(allowSend ? ['Mail.Send'] : [])]
}

/**
 * Link a Microsoft 365 administrator opens to approve inboxmux for the whole
 * organisation. Needed when the tenant blocks user consent for unverified apps.
 */
export function microsoftAdminConsentUrl(config: Config, redirectUri: string, tenant = 'organizations'): string {
  requireClient(config, 'microsoft')
  const graphScopes = microsoftScopes(config.capabilities.send)
    .filter((s) => s !== 'offline_access')
    .map((s) => `https://graph.microsoft.com/${s}`)
  return (
    `https://login.microsoftonline.com/${tenant}/v2.0/adminconsent?` +
    new URLSearchParams({
      client_id: config.microsoft.clientId as string,
      scope: graphScopes.join(' '),
      redirect_uri: redirectUri,
    }).toString()
  )
}

export interface Pkce {
  verifier: string
  challenge: string
}

export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export function randomState(): string {
  return randomBytes(24).toString('base64url')
}

export interface TokenResponse {
  accessToken: string
  expiresIn: number
  refreshToken?: string
  scopes: string[]
}

function microsoftBase(config: Config): string {
  return `https://login.microsoftonline.com/${config.microsoft.tenant}/oauth2/v2.0`
}

export function requireClient(config: Config, provider: ProviderKind): void {
  if (provider === 'google' && (!config.google.clientId || !config.google.clientSecret)) {
    throw new UserFacingError(
      'not_configured',
      'Google is not set up. Run `inboxmux setup google --client-file <client_secret.json>` (see docs/google-setup.md).',
    )
  }
  if (provider === 'microsoft' && !config.microsoft.clientId) {
    throw new UserFacingError(
      'not_configured',
      'Microsoft is not set up. Run `inboxmux setup microsoft --client-id <id>` (see docs/microsoft-setup.md).',
    )
  }
}

export function authorizationUrl(
  config: Config,
  provider: ProviderKind,
  opts: { redirectUri: string; state: string; pkce: Pkce },
): string {
  requireClient(config, provider)
  if (provider === 'google') {
    return (
      'https://accounts.google.com/o/oauth2/v2/auth?' +
      new URLSearchParams({
        client_id: config.google.clientId as string,
        redirect_uri: opts.redirectUri,
        response_type: 'code',
        scope: GOOGLE_SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent select_account',
        state: opts.state,
        code_challenge: opts.pkce.challenge,
        code_challenge_method: 'S256',
      }).toString()
    )
  }
  return (
    `${microsoftBase(config)}/authorize?` +
    new URLSearchParams({
      client_id: config.microsoft.clientId as string,
      redirect_uri: opts.redirectUri,
      response_type: 'code',
      response_mode: 'query',
      scope: microsoftScopes(config.capabilities.send).join(' '),
      prompt: 'select_account',
      state: opts.state,
      code_challenge: opts.pkce.challenge,
      code_challenge_method: 'S256',
    }).toString()
  )
}

async function tokenRequest(
  fetchFn: FetchFn,
  provider: ProviderKind,
  url: string,
  params: Record<string, string | undefined>,
): Promise<TokenResponse> {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, v)
  const response = await fetchWithRetry(fetchFn, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!response.ok) {
    const error = await providerError(provider, response.clone())
    const text = await response.text().catch(() => '')
    if (/invalid_grant|interaction_required|AADSTS700082|AADSTS50173/.test(text)) {
      throw new UserFacingError('reauth_required', 'The stored sign-in expired or was revoked. Reconnect the account with `inboxmux ui`.', 401)
    }
    throw error
  }
  const json = (await response.json()) as {
    access_token?: string
    expires_in?: number
    refresh_token?: string
    scope?: string
  }
  if (!json.access_token) throw new UserFacingError('bad_token', 'The token endpoint returned no access token.', 502)
  return {
    accessToken: json.access_token,
    expiresIn: Number(json.expires_in ?? 3600),
    refreshToken: json.refresh_token,
    scopes: (json.scope ?? '').split(' ').filter(Boolean),
  }
}

export function exchangeCode(
  config: Config,
  provider: ProviderKind,
  opts: { code: string; redirectUri: string; verifier: string },
  fetchFn: FetchFn = fetch,
): Promise<TokenResponse> {
  requireClient(config, provider)
  if (provider === 'google') {
    return tokenRequest(fetchFn, provider, 'https://oauth2.googleapis.com/token', {
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      code_verifier: opts.verifier,
    })
  }
  return tokenRequest(fetchFn, provider, `${microsoftBase(config)}/token`, {
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: config.microsoft.clientId,
    client_secret: config.microsoft.clientSecret,
    code_verifier: opts.verifier,
    scope: microsoftScopes(config.capabilities.send).join(' '),
  })
}

export function refreshAccessToken(
  config: Config,
  provider: ProviderKind,
  refreshToken: string,
  scopes: string[],
  fetchFn: FetchFn = fetch,
): Promise<TokenResponse> {
  requireClient(config, provider)
  if (provider === 'google') {
    return tokenRequest(fetchFn, provider, 'https://oauth2.googleapis.com/token', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
    })
  }
  // Microsoft rotates refresh tokens. Ask for the scopes the account consented to.
  const consented = scopes.filter((s) => !/^https?:/i.test(s) || /graph\.microsoft\.com/i.test(s))
  return tokenRequest(fetchFn, provider, `${microsoftBase(config)}/token`, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.microsoft.clientId,
    client_secret: config.microsoft.clientSecret,
    scope: unionScopes(consented, ['offline_access']).join(' '),
  })
}

export async function revokeToken(provider: ProviderKind, refreshToken: string, fetchFn: FetchFn = fetch): Promise<boolean> {
  // Microsoft has no per token revocation endpoint for public clients.
  if (provider !== 'google') return false
  const response = await fetchWithRetry(fetchFn, 'https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshToken }),
  })
  await response.body?.cancel()
  return response.ok
}

function unionScopes(a: string[], b: string[]): string[] {
  const seen = new Set(a.map((s) => s.toLowerCase()))
  return [...a, ...b.filter((s) => !seen.has(s.toLowerCase()))]
}
