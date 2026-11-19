import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { decrypt, encrypt } from '../src/crypto.js'
import { AccountStore } from '../src/store.js'
import { tempDir, useTestKey } from './helpers.js'

describe('crypto', () => {
  const key = Buffer.alloc(32, 7)

  it('round trips and binds ciphertext to the account', () => {
    const blob = encrypt(key, 'refresh-token-value', 'a@example.com')
    expect(blob).not.toContain('refresh-token-value')
    expect(decrypt(key, blob, 'a@example.com')).toBe('refresh-token-value')
    expect(() => decrypt(key, blob, 'b@example.com')).toThrow(/decrypt/)
  })

  it('rejects a tampered blob and a wrong key', () => {
    const blob = encrypt(key, 'secret', 'a')
    const parts = blob.split('.')
    parts[3] = Buffer.from('xxxxxx').toString('base64')
    expect(() => decrypt(key, parts.join('.'), 'a')).toThrow()
    expect(() => decrypt(Buffer.alloc(32, 8), blob, 'a')).toThrow()
  })
})

describe('AccountStore', () => {
  let dir: string
  let store: AccountStore

  beforeEach(() => {
    useTestKey()
    dir = tempDir()
    store = new AccountStore(dir)
  })

  it('stores accounts with encrypted tokens and private file permissions', () => {
    store.upsert({ email: 'Me@Gmail.com', provider: 'google', aliases: ['alias@work.com'], scopes: ['s'] }, 'rt-1')
    const raw = readFileSync(join(dir, 'accounts.json'), 'utf8')
    expect(raw).not.toContain('rt-1')
    if (process.platform !== 'win32') expect(statSync(join(dir, 'accounts.json')).mode & 0o777).toBe(0o600)
    expect(store.refreshToken('me@gmail.com')).toBe('rt-1')
    expect(store.list()[0]).toMatchObject({ email: 'me@gmail.com', aliases: ['me@gmail.com', 'alias@work.com'], status: 'ok' })
  })

  it('resolves by email or label and explains unknown accounts', () => {
    store.upsert({ email: 'a@x.com', provider: 'google', aliases: [], scopes: [] }, 't')
    store.upsert({ email: 'b@y.com', provider: 'microsoft', aliases: [], scopes: [] }, 't')
    store.setLabel('b@y.com', 'work')
    expect(store.resolve('WORK').email).toBe('b@y.com')
    expect(store.resolve('A@X.COM').email).toBe('a@x.com')
    expect(() => store.resolve('nobody')).toThrow(/a@x.com, b@y.com \(work\)/)
  })

  it('validates labels', () => {
    store.upsert({ email: 'a@x.com', provider: 'google', aliases: [], scopes: [] }, 't')
    store.upsert({ email: 'b@x.com', provider: 'google', aliases: [], scopes: [] }, 't')
    expect(() => store.setLabel('a@x.com', 'all')).toThrow(/reserved/)
    expect(() => store.setLabel('a@x.com', 'has space')).toThrow()
    store.setLabel('a@x.com', 'home')
    expect(() => store.setLabel('b@x.com', 'home')).toThrow(/already used/)
  })

  it('reconnect keeps label and addedAt, replaces the token', () => {
    store.upsert({ email: 'a@x.com', provider: 'google', aliases: [], scopes: [] }, 'old')
    store.setLabel('a@x.com', 'home')
    store.setStatus('a@x.com', 'reauth')
    const before = store.list()[0]
    store.upsert({ email: 'a@x.com', provider: 'google', aliases: [], scopes: ['new'] }, 'new')
    const after = store.list()[0]
    expect(after).toMatchObject({ label: 'home', addedAt: before?.addedAt, status: 'ok', scopes: ['new'] })
    expect(store.refreshToken('a@x.com')).toBe('new')
  })

  it('refuses the same address under a second provider', () => {
    store.upsert({ email: 'a@x.com', provider: 'google', aliases: [], scopes: [] }, 't')
    expect(() => store.upsert({ email: 'a@x.com', provider: 'microsoft', aliases: [], scopes: [] }, 't')).toThrow(/already connected/)
  })

  it('removes accounts and rejects a damaged file', () => {
    store.upsert({ email: 'a@x.com', provider: 'google', aliases: [], scopes: [] }, 't')
    expect(store.remove('a@x.com')).toBe(true)
    expect(store.list()).toEqual([])
    writeFileSync(join(dir, 'accounts.json'), '{"version":1,"accounts":[{"email":1}]}')
    expect(() => store.list()).toThrow(/damaged/)
  })
})
