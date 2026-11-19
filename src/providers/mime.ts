import { randomBytes } from 'node:crypto'
import { UserFacingError, type Address } from '../types.js'
import { htmlToText } from './text.js'

/** RFC 2047 encoded words (=?charset?B|Q?...?=) as they appear in raw headers. */
export function decodeMimeWords(value: string): string {
  if (!value.includes('=?')) return value
  const joined = value.replace(/(\?=)\s+(=\?)/g, '$1$2')
  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (match, charset: string, enc: string, text: string) => {
    try {
      const bytes =
        enc.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : Buffer.from(
              text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
              'latin1',
            )
      return decodeBytes(bytes, charset.replace(/\*.*$/, ''))
    } catch {
      // Unknown charset: leave the encoded word visible rather than guess.
      return match
    }
  })
}

export function decodeBytes(bytes: Buffer, charset = 'utf-8'): string {
  try {
    return new TextDecoder(charset.trim().toLowerCase() || 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

export function charsetOf(contentType: string | undefined): string {
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? '')
  return match?.[1] ?? 'utf-8'
}

/** Splits an address header on top level commas and parses each entry. */
export function parseAddressList(header: string | undefined): Address[] {
  if (!header) return []
  const items: string[] = []
  let current = ''
  let inQuote = false
  let angle = 0
  for (let i = 0; i < header.length; i++) {
    const ch = header[i] as string
    if (ch === '\\' && inQuote) {
      current += ch + (header[i + 1] ?? '')
      i++
      continue
    }
    if (ch === '"') inQuote = !inQuote
    else if (!inQuote && ch === '<') angle++
    else if (!inQuote && ch === '>') angle = Math.max(0, angle - 1)
    if ((ch === ',' || ch === ';') && !inQuote && angle === 0) {
      items.push(current)
      current = ''
      continue
    }
    current += ch
  }
  items.push(current)
  const result: Address[] = []
  for (let raw of items) {
    raw = raw.replace(/^[^"<@]*:\s*/, '').trim()
    if (!raw) continue
    const angled = /^(.*)<([^>]+)>\s*$/.exec(raw)
    if (angled) {
      const name = decodeMimeWords((angled[1] ?? '').trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1')).trim()
      result.push(name ? { name, email: (angled[2] ?? '').trim().toLowerCase() } : { email: (angled[2] ?? '').trim().toLowerCase() })
    } else if (raw.includes('@')) {
      result.push({ email: raw.replace(/\(.*?\)/g, '').trim().toLowerCase() })
    }
  }
  return result
}

function assertHeaderSafe(name: string, value: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new UserFacingError('invalid_header', `${name} must not contain line breaks.`)
  }
}

/** Encodes a header value as RFC 2047 UTF-8 base64 words when it is not plain ASCII. */
export function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value
  const words: string[] = []
  let chunk = ''
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(chunk)
      chunk = ''
    }
    chunk += ch
  }
  if (chunk) words.push(chunk)
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ')
}

export function formatAddress(address: Address): string {
  assertHeaderSafe('Address', address.email)
  if (!address.name) return address.email
  assertHeaderSafe('Display name', address.name)
  const name = /^[\x20-\x7e]*$/.test(address.name)
    ? `"${address.name.replace(/["\\]/g, '\\$&')}"`
    : encodeHeaderValue(address.name)
  return `${name} <${address.email}>`
}

function base64Lines(text: string): string {
  const normalized = text.replace(/\r?\n/g, '\r\n')
  return (Buffer.from(normalized, 'utf8').toString('base64').match(/.{1,76}/g) ?? ['']).join('\r\n')
}

export interface MimeInput {
  from?: Address
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  html: boolean
  inReplyTo?: string
  references?: string
}

/** Builds an RFC 5322 message. Every header value is checked for line breaks (header injection). */
export function buildMime(input: MimeInput): string {
  const lines: string[] = []
  // `raw` is the caller supplied value that must be free of line breaks. The
  // written value may contain RFC 5322 folding produced by our own encoder.
  const header = (name: string, written: string, raw: string = written) => {
    assertHeaderSafe(name, raw)
    lines.push(`${name}: ${written}`)
  }
  const list = (emails: string[]) => emails.map((e) => formatAddress({ email: e })).join(', ')
  if (input.from) header('From', formatAddress(input.from), input.from.email + (input.from.name ?? ''))
  if (input.to.length) header('To', list(input.to))
  if (input.cc.length) header('Cc', list(input.cc))
  if (input.bcc.length) header('Bcc', list(input.bcc))
  header('Subject', encodeHeaderValue(input.subject), input.subject)
  if (input.inReplyTo) header('In-Reply-To', input.inReplyTo)
  if (input.references) header('References', input.references)
  lines.push('MIME-Version: 1.0')
  if (!input.html) {
    lines.push('Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64')
    return `${lines.join('\r\n')}\r\n\r\n${base64Lines(input.body)}\r\n`
  }
  const boundary = `inboxmux_${randomBytes(12).toString('hex')}`
  lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
  const part = (type: string, content: string) =>
    `--${boundary}\r\nContent-Type: ${type}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(content)}\r\n`
  return (
    `${lines.join('\r\n')}\r\n\r\n` +
    part('text/plain', htmlToText(input.body)) +
    part('text/html', input.body) +
    `--${boundary}--\r\n`
  )
}
