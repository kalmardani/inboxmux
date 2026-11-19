import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { writeFileAtomic } from './fsutil.js'
import { log } from './log.js'

/**
 * Refresh tokens are stored encrypted with AES-256-GCM. The 32 byte master key
 * lives outside the token file, in this order of preference:
 *   1. INBOXMUX_MASTER_KEY environment variable (base64), for CI and containers
 *   2. the operating system keychain (macOS Keychain, Windows Credential
 *      Manager, Linux Secret Service) through the optional @napi-rs/keyring
 *   3. a `master.key` file with 0600 permissions, when no keychain is available
 */
export type KeySource = 'env' | 'keychain' | 'file'

const KEYCHAIN_SERVICE = 'inboxmux'
const KEYCHAIN_ENTRY = 'master-key'

interface KeyringEntry {
  getPassword(): string | null
  setPassword(password: string): void
}
type KeyringEntryCtor = new (service: string, account: string) => KeyringEntry

function loadKeyring(): KeyringEntryCtor | null {
  if (process.env.INBOXMUX_NO_KEYCHAIN === '1') return null
  try {
    const require = createRequire(import.meta.url)
    return (require('@napi-rs/keyring') as { Entry: KeyringEntryCtor }).Entry
  } catch {
    // Optional dependency missing or no native build for this platform.
    return null
  }
}

function parseKey(value: string, where: string): Buffer {
  const key = Buffer.from(value.trim(), 'base64')
  if (key.length !== 32) {
    throw new Error(`The master key in ${where} must be 32 bytes encoded as base64.`)
  }
  return key
}

export function loadMasterKey(dir: string): { key: Buffer; source: KeySource } {
  const fromEnv = process.env.INBOXMUX_MASTER_KEY
  if (fromEnv) return { key: parseKey(fromEnv, 'INBOXMUX_MASTER_KEY'), source: 'env' }

  const file = join(dir, 'master.key')
  if (existsSync(file)) return { key: parseKey(readFileSync(file, 'utf8'), file), source: 'file' }

  const Entry = loadKeyring()
  if (Entry) {
    try {
      const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ENTRY)
      const existing = entry.getPassword()
      if (existing) return { key: parseKey(existing, 'the keychain'), source: 'keychain' }
      const key = randomBytes(32)
      entry.setPassword(key.toString('base64'))
      if (entry.getPassword() === key.toString('base64')) return { key, source: 'keychain' }
      log.warn('Keychain write could not be verified, falling back to a key file.')
    } catch (err) {
      log.warn(`Keychain unavailable (${(err as Error).message}), falling back to a key file.`)
    }
  }

  const key = randomBytes(32)
  writeFileAtomic(file, key.toString('base64') + '\n', 0o600)
  return { key, source: 'file' }
}

/** Encrypts `plaintext`. `aad` binds the ciphertext to one account so blobs cannot be swapped. */
export function encrypt(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.')
}

export function decrypt(key: Buffer, blob: string, aad: string): string {
  const [version, iv, tag, ciphertext] = blob.split('.')
  if (version !== 'v1' || !iv || !tag || ciphertext === undefined) {
    throw new Error('Stored token has an unknown format.')
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('Could not decrypt a stored token. The master key changed or the account file was modified.')
  }
}
