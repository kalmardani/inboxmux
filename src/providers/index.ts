import { authedClient, type AuthedClient, type FetchFn } from '../http.js'
import type { TokenManager } from '../tokens.js'
import type { AccountMeta, MailProvider, ProviderKind } from '../types.js'
import { GmailProvider } from './gmail.js'
import { GRAPH_HEADERS, GraphProvider } from './graph.js'

export function clientFor(
  account: Pick<AccountMeta, 'email' | 'provider'>,
  getToken: (force?: boolean) => Promise<string>,
  fetchFn: FetchFn = fetch,
): AuthedClient {
  return authedClient({
    provider: account.provider,
    email: account.email,
    getToken,
    fetchFn,
    extraHeaders: account.provider === 'microsoft' ? GRAPH_HEADERS : undefined,
  })
}

export function createProvider(kind: ProviderKind, account: AccountMeta, http: AuthedClient): MailProvider {
  switch (kind) {
    case 'google':
      return new GmailProvider(account, http)
    case 'microsoft':
      return new GraphProvider(account, http)
  }
}

/** Keeps one provider instance per account for the life of the process. */
export class ProviderRegistry {
  private readonly cache = new Map<string, MailProvider>()

  constructor(
    private readonly tokens: TokenManager,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  get(account: AccountMeta): MailProvider {
    const key = `${account.provider}:${account.email}`
    let provider = this.cache.get(key)
    if (!provider) {
      const http = clientFor(account, (force) => this.tokens.get(account, force), this.fetchFn)
      provider = createProvider(account.provider, account, http)
      this.cache.set(key, provider)
    }
    return provider
  }
}
