import type { Config } from './config.js'
import type { FetchFn } from './http.js'
import { refreshAccessToken } from './oauth.js'
import type { AccountStore } from './store.js'
import { UserFacingError, type AccountMeta } from './types.js'

/**
 * Hands out access tokens. They live in memory only and are refreshed a minute
 * before expiry. Concurrent callers for the same account share one refresh.
 * Rotated refresh tokens (Microsoft) are written back to the encrypted store.
 */
export class TokenManager {
  private readonly cache = new Map<string, { token: string; expiresAt: number }>()
  private readonly inflight = new Map<string, Promise<string>>()

  constructor(
    private readonly store: AccountStore,
    private readonly config: Config,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async get(account: AccountMeta, force = false): Promise<string> {
    const cached = this.cache.get(account.email)
    if (!force && cached && cached.expiresAt > Date.now() + 60_000) return cached.token
    const running = this.inflight.get(account.email)
    if (running) return running
    const task = this.refresh(account).finally(() => this.inflight.delete(account.email))
    this.inflight.set(account.email, task)
    return task
  }

  forget(email: string): void {
    this.cache.delete(email)
  }

  private async refresh(account: AccountMeta): Promise<string> {
    const refreshToken = this.store.refreshToken(account.email)
    try {
      const result = await refreshAccessToken(this.config, account.provider, refreshToken, account.scopes, this.fetchFn)
      if (result.refreshToken && result.refreshToken !== refreshToken) {
        this.store.updateRefreshToken(account.email, result.refreshToken)
      }
      if (account.status !== 'ok') this.store.setStatus(account.email, 'ok')
      this.cache.set(account.email, { token: result.accessToken, expiresAt: Date.now() + result.expiresIn * 1000 })
      return result.accessToken
    } catch (err) {
      if (err instanceof UserFacingError && err.code === 'reauth_required') {
        this.store.setStatus(account.email, 'reauth')
        this.cache.delete(account.email)
        throw new UserFacingError('reauth_required', `${account.email} needs to be reconnected. Run \`inboxmux ui\`.`, 401)
      }
      throw err
    }
  }
}
