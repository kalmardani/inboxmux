import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { decrypt, encrypt, loadMasterKey, type KeySource } from './crypto.js'
import { withFileLock, writeFileAtomic } from './fsutil.js'
import { UserFacingError, type AccountMeta, type ProviderKind } from './types.js'

const LABEL = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

const RecordSchema = z.object({
  email: z.string().min(3),
  provider: z.enum(['google', 'microsoft']),
  label: z.string().regex(LABEL).optional(),
  displayName: z.string().optional(),
  aliases: z.array(z.string()),
  scopes: z.array(z.string()),
  addedAt: z.string(),
  status: z.enum(['ok', 'reauth']),
  token: z.string(),
})
type AccountRecord = z.infer<typeof RecordSchema>

const FileSchema = z.object({ version: z.literal(1), accounts: z.array(RecordSchema) })
type StoreFile = z.infer<typeof FileSchema>

export interface NewAccount {
  email: string
  provider: ProviderKind
  displayName?: string
  aliases: string[]
  scopes: string[]
}

/**
 * The list of connected accounts. Metadata is stored in clear text so the
 * account list can be shown without the master key, refresh tokens are
 * encrypted per account. Every read goes to disk, so an MCP server that is
 * already running sees accounts added later from the UI.
 */
export class AccountStore {
  private readonly file: string
  private readonly lock: string
  private key: { key: Buffer; source: KeySource } | undefined

  constructor(private readonly dir: string) {
    this.file = join(dir, 'accounts.json')
    this.lock = join(dir, 'accounts.lock')
  }

  keySource(): KeySource {
    return this.masterKey().source
  }

  list(): AccountMeta[] {
    return this.read().accounts.map(toMeta)
  }

  /** Finds an account by email address (case insensitive) or by label. */
  resolve(ref: string): AccountMeta {
    const wanted = ref.trim().toLowerCase()
    const accounts = this.list()
    const found = accounts.find((a) => a.email === wanted || a.label?.toLowerCase() === wanted)
    if (found) return found
    const known = accounts.map((a) => (a.label ? `${a.email} (${a.label})` : a.email)).join(', ')
    throw new UserFacingError(
      'unknown_account',
      accounts.length
        ? `No connected account matches "${ref}". Connected accounts: ${known}.`
        : 'No accounts are connected yet. Run `inboxmux ui` to connect one.',
      404,
    )
  }

  refreshToken(email: string): string {
    const record = this.read().accounts.find((a) => a.email === email)
    if (!record) throw new UserFacingError('unknown_account', `Account ${email} is not connected.`, 404)
    return decrypt(this.masterKey().key, record.token, record.email)
  }

  /** Adds an account or replaces the tokens of an existing one (reconnect). */
  upsert(account: NewAccount, refreshToken: string): AccountMeta {
    const email = account.email.toLowerCase()
    return this.mutate((file) => {
      const existing = file.accounts.find((a) => a.email === email)
      const aliases = unique([email, ...account.aliases.map((a) => a.toLowerCase())])
      const record: AccountRecord = {
        email,
        provider: account.provider,
        label: existing?.label,
        displayName: account.displayName,
        aliases,
        scopes: account.scopes,
        addedAt: existing?.addedAt ?? new Date().toISOString(),
        status: 'ok',
        token: encrypt(this.masterKey().key, refreshToken, email),
      }
      if (existing && existing.provider !== account.provider) {
        throw new UserFacingError('conflict', `${email} is already connected through ${existing.provider}.`, 409)
      }
      file.accounts = existing ? file.accounts.map((a) => (a.email === email ? record : a)) : [...file.accounts, record]
      return toMeta(record)
    })
  }

  updateRefreshToken(email: string, refreshToken: string): void {
    this.mutate((file) => {
      const record = file.accounts.find((a) => a.email === email)
      if (!record) return
      record.token = encrypt(this.masterKey().key, refreshToken, email)
      record.status = 'ok'
    })
  }

  setStatus(email: string, status: AccountMeta['status']): void {
    this.mutate((file) => {
      const record = file.accounts.find((a) => a.email === email)
      if (record) record.status = status
    })
  }

  setLabel(email: string, label: string | undefined): void {
    if (label !== undefined) {
      if (!LABEL.test(label)) {
        throw new UserFacingError('invalid_label', 'Labels are 1-32 characters: letters, digits, _ and -.')
      }
      if (label.toLowerCase() === 'all') throw new UserFacingError('invalid_label', '"all" is reserved.')
    }
    this.mutate((file) => {
      const record = file.accounts.find((a) => a.email === email)
      if (!record) throw new UserFacingError('unknown_account', `Account ${email} is not connected.`, 404)
      const clash = file.accounts.find((a) => a.email !== email && a.label?.toLowerCase() === label?.toLowerCase())
      if (label && clash) throw new UserFacingError('invalid_label', `Label ${label} is already used by ${clash.email}.`)
      record.label = label
    })
  }

  remove(email: string): boolean {
    return this.mutate((file) => {
      const before = file.accounts.length
      file.accounts = file.accounts.filter((a) => a.email !== email)
      return file.accounts.length !== before
    })
  }

  private masterKey(): { key: Buffer; source: KeySource } {
    this.key ??= loadMasterKey(this.dir)
    return this.key
  }

  private read(): StoreFile {
    if (!existsSync(this.file)) return { version: 1, accounts: [] }
    const parsed = FileSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')))
    if (!parsed.success) throw new Error(`${this.file} is damaged and could not be read.`)
    return parsed.data
  }

  private mutate<T>(fn: (file: StoreFile) => T): T {
    return withFileLock(this.lock, () => {
      const file = this.read()
      const result = fn(file)
      writeFileAtomic(this.file, JSON.stringify(file, null, 2) + '\n', 0o600)
      return result
    })
  }
}

function toMeta(record: AccountRecord): AccountMeta {
  const { token: _token, ...meta } = record
  return meta
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
