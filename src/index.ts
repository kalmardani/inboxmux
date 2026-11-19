#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig, updateConfigFile, type Config } from './config.js'
import { ensureDir } from './fsutil.js'
import { log } from './log.js'
import { GOOGLE_REQUIRED_SCOPE, microsoftAdminConsentUrl, refreshAccessToken, revokeToken } from './oauth.js'
import { clientFor, ProviderRegistry } from './providers/index.js'
import { gmailProfile } from './providers/gmail.js'
import { createMcpServer } from './server.js'
import { AccountStore } from './store.js'
import { TokenManager } from './tokens.js'
import { UserFacingError } from './types.js'
import { startUi } from './ui/server.js'

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

const HELP = `inboxmux ${VERSION}
One MCP server for many mailboxes (Gmail, Microsoft 365, Outlook.com).

Usage
  inboxmux mcp                          Run the MCP server on stdio (what MCP clients start)
  inboxmux ui [--no-open] [--port N]    Open the local account manager in the browser
  inboxmux accounts                     List connected accounts
  inboxmux label <account> <label>      Give an account a short label (use - to clear)
  inboxmux remove <account>             Disconnect an account and revoke its token
  inboxmux doctor                       Check configuration, key storage and every account
  inboxmux setup google --client-file <client_secret.json>
  inboxmux setup google --client-id <id> --client-secret <secret>
  inboxmux setup microsoft --client-id <id> [--tenant common|organizations|consumers|<tenant id>]
  inboxmux import google                Import an existing Google refresh token from stdin
  inboxmux admin-consent [tenant]       Print the approval link for a Microsoft 365 administrator

Configuration lives in ${'$'}INBOXMUX_HOME or ~/.config/inboxmux. See README.md.`

function context(): { config: Config; store: AccountStore; tokens: TokenManager } {
  const config = loadConfig()
  ensureDir(config.dir)
  const store = new AccountStore(config.dir)
  return { config, store, tokens: new TokenManager(store, config) }
}

async function runMcp(): Promise<void> {
  const { config, store, tokens } = context()
  const providers = new ProviderRegistry(tokens)
  const server = createMcpServer({
    accounts: store,
    provider: (account) => providers.get(account),
    config,
    version: VERSION,
    auditFile: join(config.dir, 'audit.log'),
  })
  await server.connect(new StdioServerTransport())
  log.info(`MCP server ready with ${store.list().length} account(s). Sending ${config.capabilities.send ? 'enabled' : 'disabled'}.`)
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  execFile(cmd as string, args as string[], (err) => {
    if (err) log.warn('Could not open a browser. Open the link above by hand.')
  })
}

async function runUi(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { 'no-open': { type: 'boolean' }, port: { type: 'string' } } })
  const { config, store, tokens } = context()
  const port = values.port ? Number(values.port) : config.uiPort
  const ui = await startUi({ store, tokens, port })
  process.stdout.write(`inboxmux account manager is running.\nOpen: ${ui.loginUrl}\nPress Ctrl+C to stop.\n`)
  if (!values['no-open']) openBrowser(ui.loginUrl)
  const stop = () => {
    void ui.close().then(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

async function runAccounts(): Promise<void> {
  const { store } = context()
  const accounts = store.list()
  if (!accounts.length) {
    process.stdout.write('No accounts connected. Run `inboxmux ui`.\n')
    return
  }
  for (const a of accounts) {
    const label = a.label ? ` [${a.label}]` : ''
    const aliases = a.aliases.filter((x) => x !== a.email)
    process.stdout.write(
      `${a.email}${label}  ${a.provider}  ${a.status}${aliases.length ? `  aliases: ${aliases.join(', ')}` : ''}\n`,
    )
  }
}

async function runLabel(args: string[]): Promise<void> {
  const [ref, label] = args
  if (!ref || !label) throw new UserFacingError('usage', 'Usage: inboxmux label <account> <label|->')
  const { store } = context()
  const account = store.resolve(ref)
  store.setLabel(account.email, label === '-' ? undefined : label)
  process.stdout.write(`Label ${label === '-' ? 'cleared' : `set to ${label}`} for ${account.email}.\n`)
}

async function runRemove(args: string[]): Promise<void> {
  const [ref] = args
  if (!ref) throw new UserFacingError('usage', 'Usage: inboxmux remove <account>')
  const { store } = context()
  const account = store.resolve(ref)
  let revoked = false
  try {
    revoked = await revokeToken(account.provider, store.refreshToken(account.email))
  } catch (err) {
    log.warn(`Token revocation failed: ${(err as Error).message}`)
  }
  store.remove(account.email)
  process.stdout.write(`Removed ${account.email}${revoked ? ' and revoked its token' : ''}.\n`)
}

async function runSetup(args: string[]): Promise<void> {
  const [provider, ...rest] = args
  const { values } = parseArgs({
    args: rest,
    options: {
      'client-file': { type: 'string' },
      'client-id': { type: 'string' },
      'client-secret': { type: 'string' },
      tenant: { type: 'string' },
    },
  })
  const dir = loadConfig().dir
  if (provider === 'google') {
    let clientId = values['client-id']
    let clientSecret = values['client-secret']
    if (values['client-file']) {
      const json = JSON.parse(readFileSync(values['client-file'], 'utf8')) as Record<string, { client_id?: string; client_secret?: string }>
      const client = json.installed ?? json.web
      if (!client?.client_id || !client.client_secret) throw new UserFacingError('invalid_client', 'The file has no client_id and client_secret.')
      if (!json.installed) log.warn('This is a Web client. Add the redirect URIs from docs/google-setup.md, or create a Desktop client instead.')
      clientId = client.client_id
      clientSecret = client.client_secret
    }
    if (!clientId || !clientSecret) throw new UserFacingError('usage', 'Pass --client-file, or --client-id with --client-secret.')
    updateConfigFile(dir, (c) => {
      c.google = { clientId, clientSecret }
    })
    process.stdout.write('Google client saved. Run `inboxmux ui` to connect accounts.\n')
    return
  }
  if (provider === 'microsoft') {
    const clientId = values['client-id']
    if (!clientId || !/^[0-9a-f-]{36}$/i.test(clientId)) throw new UserFacingError('usage', 'Pass --client-id <application id GUID>.')
    updateConfigFile(dir, (c) => {
      c.microsoft = {
        ...(c.microsoft ?? {}),
        clientId,
        ...(values.tenant ? { tenant: values.tenant } : {}),
        ...(values['client-secret'] ? { clientSecret: values['client-secret'] } : {}),
      }
    })
    process.stdout.write('Microsoft app saved. Run `inboxmux ui` to connect accounts.\n')
    return
  }
  throw new UserFacingError('usage', 'Usage: inboxmux setup google|microsoft ...')
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8').trim()
}

/** Migration path for people who already hold a Google refresh token from their own OAuth client. */
async function runImport(args: string[]): Promise<void> {
  if (args[0] !== 'google') throw new UserFacingError('usage', 'Usage: inboxmux import google  (refresh token on stdin)')
  const { config, store } = context()
  const refreshToken = await readStdin()
  if (!refreshToken) throw new UserFacingError('usage', 'Pipe the refresh token into stdin.')
  const tokens = await refreshAccessToken(config, 'google', refreshToken, [])
  const http = clientFor({ email: 'import', provider: 'google' }, async () => tokens.accessToken)
  const profile = await gmailProfile(http)
  if (!tokens.scopes.includes(GOOGLE_REQUIRED_SCOPE)) {
    log.warn(`This token lacks ${GOOGLE_REQUIRED_SCOPE}. Reading works only if it has gmail.readonly, drafts and labels need a reconnect.`)
  }
  const account = store.upsert(
    { email: profile.email, provider: 'google', displayName: profile.displayName, aliases: profile.aliases, scopes: tokens.scopes },
    refreshToken,
  )
  process.stdout.write(`Imported ${account.email} (scopes: ${tokens.scopes.map((s) => s.replace(/^.*\//, '')).join(', ')}).\n`)
}

async function runAdminConsent(args: string[]): Promise<void> {
  const config = loadConfig()
  const tenant = args[0] ?? 'organizations'
  if (!/^[A-Za-z0-9.-]{1,100}$/.test(tenant)) throw new UserFacingError('usage', 'The tenant is a domain, a GUID or organizations.')
  const redirect = `http://localhost:${config.uiPort}/oauth/microsoft/callback`
  process.stdout.write(`Send this link to the Microsoft 365 administrator of the organisation:\n${microsoftAdminConsentUrl(config, redirect, tenant)}\n`)
}

async function runDoctor(): Promise<void> {
  const { config, store, tokens } = context()
  const out = (line: string) => process.stdout.write(line + '\n')
  out(`inboxmux ${VERSION}, Node ${process.version}`)
  out(`Config folder: ${config.dir}`)
  out(`Google client: ${config.google.clientId ? 'configured' : 'missing'}`)
  out(`Microsoft app: ${config.microsoft.clientId ? `configured (tenant ${config.microsoft.tenant})` : 'missing'}`)
  out(`Capabilities: send ${config.capabilities.send ? 'on' : 'off'}, trash ${config.capabilities.trash ? 'on' : 'off'}`)
  const accounts = store.list()
  if (accounts.length) out(`Key storage: ${store.keySource()}`)
  out(`Accounts: ${accounts.length}`)
  let failures = 0
  for (const account of accounts) {
    try {
      await tokens.get(account, true)
      out(`  ok    ${account.email} (${account.provider})`)
    } catch (err) {
      failures++
      out(`  FAIL  ${account.email}: ${err instanceof UserFacingError ? err.message : (err as Error).message}`)
    }
  }
  if (failures) process.exitCode = 1
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  switch (command) {
    case 'mcp':
    case 'serve':
      return runMcp()
    case 'ui':
      return runUi(args)
    case 'accounts':
      return runAccounts()
    case 'label':
      return runLabel(args)
    case 'remove':
      return runRemove(args)
    case 'setup':
      return runSetup(args)
    case 'import':
      return runImport(args)
    case 'doctor':
      return runDoctor()
    case 'admin-consent':
      return runAdminConsent(args)
    case '--version':
    case '-v':
      process.stdout.write(`${VERSION}\n`)
      return
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP + '\n')
      return
    default:
      throw new UserFacingError('usage', `Unknown command ${command}.\n\n${HELP}`)
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof UserFacingError ? err.message : (err as Error).stack}\n`)
  process.exit(1)
})
