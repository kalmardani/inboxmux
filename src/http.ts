import { log } from './log.js'
import { UserFacingError, type ProviderKind } from './types.js'

export type FetchFn = typeof fetch

const RETRYABLE = new Set([429, 500, 502, 503, 504])

/**
 * fetch with a timeout and bounded retries. Only idempotent methods are
 * retried, so a POST that creates a draft can never run twice.
 */
export async function fetchWithRetry(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit = {},
  { retries = 2, timeoutMs = 20_000 } = {},
): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  const idempotent = method === 'GET' || method === 'HEAD'
  for (let attempt = 0; ; attempt++) {
    let response: Response
    try {
      response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      if (idempotent && attempt < retries) {
        await sleep(backoff(attempt))
        continue
      }
      const reason = (err as Error).name === 'TimeoutError' ? 'timed out' : 'failed'
      throw new UserFacingError('network_error', `Request to ${new URL(url).host} ${reason}.`, 503)
    }
    if (idempotent && RETRYABLE.has(response.status) && attempt < retries) {
      const retryAfter = Number(response.headers.get('retry-after'))
      await response.body?.cancel()
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : backoff(attempt))
      continue
    }
    return response
  }
}

function backoff(attempt: number): number {
  return 400 * 2 ** attempt + Math.floor(Math.random() * 200)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Turns a failed provider response into an error that is safe to show. */
export async function providerError(provider: ProviderKind, response: Response, email?: string): Promise<UserFacingError> {
  const text = (await response.text().catch(() => '')).slice(0, 2000)
  let detail = ''
  try {
    const body = JSON.parse(text) as { error?: { message?: string; code?: string } | string; error_description?: string }
    if (typeof body.error === 'object') detail = body.error.message ?? body.error.code ?? ''
    else detail = body.error_description ?? body.error ?? ''
  } catch {
    detail = text.replace(/\s+/g, ' ').slice(0, 200)
  }
  detail = detail.slice(0, 300)
  const name = provider === 'google' ? 'Gmail' : 'Microsoft Graph'
  const who = email ? ` for ${email}` : ''
  const status = response.status
  log.debug(`${name} returned ${status}${who}: ${detail}`)
  if (status === 401) {
    return new UserFacingError('reauth_required', `${name} rejected the credentials${who}. Reconnect the account with \`inboxmux ui\`.`, 401)
  }
  if (status === 403) {
    const scope = /scope|insufficient|permission|accessdenied|denied/i.test(detail)
    return new UserFacingError(
      scope ? 'insufficient_scope' : 'forbidden',
      scope
        ? `The account${who} has not granted the permission this action needs. Reconnect it with \`inboxmux ui\` and accept every requested permission. (${detail})`
        : `${name} refused the request${who}. (${detail})`,
      403,
    )
  }
  if (status === 404) return new UserFacingError('not_found', `Not found${who}. (${detail || 'no detail'})`, 404)
  if (status === 429) return new UserFacingError('rate_limited', `${name} rate limit reached${who}. Try again shortly.`, 429)
  if (status >= 500) return new UserFacingError('provider_unavailable', `${name} is temporarily unavailable (${status}).`, 503)
  return new UserFacingError('bad_request', `${name} rejected the request${who}. (${detail || status})`, 400)
}

export interface AuthedClient {
  json<T>(url: string, init?: RequestInit): Promise<T>
  buffer(url: string, init?: RequestInit): Promise<Buffer>
  send(url: string, init?: RequestInit): Promise<void>
  /**
   * Calls a pre-authenticated URL handed out by the provider (Microsoft
   * attachment upload sessions). The bearer token is never sent there.
   */
  external<T>(url: string, init?: RequestInit): Promise<T>
}

/** Large uploads get more time than ordinary API calls. */
function timeoutFor(init: RequestInit): number {
  const body = init.body
  const size = typeof body === 'string' ? body.length : body instanceof Uint8Array ? body.byteLength : 0
  return size > 1_000_000 ? 180_000 : 20_000
}

/**
 * HTTP client bound to one account. Adds the bearer token, retries once with a
 * forced token refresh on 401, and maps failures to UserFacingError.
 */
export function authedClient(opts: {
  provider: ProviderKind
  email: string
  getToken: (force?: boolean) => Promise<string>
  fetchFn: FetchFn
  extraHeaders?: Record<string, string>
}): AuthedClient {
  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    for (const force of [false, true]) {
      const token = await opts.getToken(force)
      const headers = new Headers(init.headers)
      headers.set('Authorization', `Bearer ${token}`)
      for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) if (!headers.has(k)) headers.set(k, v)
      const response = await fetchWithRetry(opts.fetchFn, url, { ...init, headers }, { timeoutMs: timeoutFor(init) })
      if (response.status === 401 && !force) {
        await response.body?.cancel()
        continue
      }
      if (!response.ok) throw await providerError(opts.provider, response, opts.email)
      return response
    }
    throw new UserFacingError('reauth_required', `Reconnect ${opts.email} with \`inboxmux ui\`.`, 401)
  }
  return {
    async json<T>(url: string, init?: RequestInit) {
      const response = await call(url, init)
      const text = await response.text()
      return (text ? JSON.parse(text) : {}) as T
    },
    async buffer(url: string, init?: RequestInit) {
      return Buffer.from(await (await call(url, init)).arrayBuffer())
    },
    async send(url: string, init?: RequestInit) {
      await (await call(url, init)).body?.cancel()
    },
    async external<T>(url: string, init: RequestInit = {}) {
      const response = await fetchWithRetry(opts.fetchFn, url, init, { timeoutMs: timeoutFor(init) })
      if (!response.ok) throw await providerError(opts.provider, response, opts.email)
      const text = await response.text()
      return (text ? JSON.parse(text) : {}) as T
    },
  }
}

/** Runs `fn` over `items` with at most `limit` calls in flight, keeping order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
