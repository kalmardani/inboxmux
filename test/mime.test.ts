import { describe, expect, it } from 'vitest'
import { buildMime, decodeMimeWords, encodeHeaderValue, parseAddressList } from '../src/providers/mime.js'
import { htmlToText, truncate } from '../src/providers/text.js'

describe('parseAddressList', () => {
  it('handles names, quotes with commas and bare addresses', () => {
    expect(parseAddressList('"Doe, Jane" <Jane@Example.com>, bob@x.org, Ann <ann@y.io>')).toEqual([
      { name: 'Doe, Jane', email: 'jane@example.com' },
      { email: 'bob@x.org' },
      { name: 'Ann', email: 'ann@y.io' },
    ])
  })

  it('decodes encoded display names and ignores junk', () => {
    expect(parseAddressList('=?UTF-8?B?S2FsbcOhciBEw6FuaWVs?= <d@x.hu>, undisclosed-recipients:;')).toEqual([
      { name: 'Kalmár Dániel', email: 'd@x.hu' },
    ])
    expect(parseAddressList(undefined)).toEqual([])
  })
})

describe('encoded words', () => {
  it('decodes B and Q words and joins adjacent ones', () => {
    expect(decodeMimeWords('=?UTF-8?Q?=C3=81rv=C3=ADzt=C5=B1r=C5=91?= =?UTF-8?Q?_t=C3=BCk=C3=B6rf=C3=BAr=C3=B3g=C3=A9p?=')).toBe(
      'Árvíztűrő tükörfúrógép',
    )
    expect(decodeMimeWords('=?ISO-8859-1?Q?caf=E9?=')).toBe('café')
    expect(decodeMimeWords('plain')).toBe('plain')
  })

  it('round trips long non ASCII subjects', () => {
    const subject = 'Árvíztűrő tükörfúrógép '.repeat(6).trim()
    const encoded = encodeHeaderValue(subject)
    for (const word of encoded.split('\r\n ')) expect(word.length).toBeLessThanOrEqual(75)
    expect(decodeMimeWords(encoded.replace(/\r\n /g, ' '))).toBe(subject)
  })
})

describe('buildMime', () => {
  const base = { to: ['a@x.com'], cc: [], bcc: [], subject: 'Hi', body: 'Line 1\nLine 2', html: false }

  it('writes a plain text message with CRLF and base64 body', () => {
    const raw = buildMime({ ...base, from: { name: 'Dani K', email: 'd@x.hu' } })
    expect(raw).toContain('From: "Dani K" <d@x.hu>\r\n')
    expect(raw).toContain('To: a@x.com\r\n')
    expect(raw).toContain('Content-Transfer-Encoding: base64')
    const body = raw.split('\r\n\r\n')[1] ?? ''
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Line 1\r\nLine 2')
  })

  it('refuses header injection', () => {
    expect(() => buildMime({ ...base, subject: 'Hi\r\nBcc: evil@x.com' })).toThrow(/line breaks/)
    expect(() => buildMime({ ...base, from: { name: 'x\nBcc: e@x', email: 'd@x.hu' } })).toThrow(/line breaks/)
  })

  it('builds multipart alternative for html', () => {
    const raw = buildMime({ ...base, body: '<p>Hello <b>you</b></p>', html: true })
    expect(raw).toMatch(/multipart\/alternative; boundary="inboxmux_alt_[0-9a-f]+"/)
    expect(raw.match(/Content-Type: text\/(plain|html)/g)).toEqual(['Content-Type: text/plain', 'Content-Type: text/html'])
  })

  it('adds attachments as multipart/mixed with safe encoded filenames', () => {
    const raw = buildMime({
      ...base,
      body: 'See attached',
      attachments: [
        { filename: 'Számla 2026.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.7') },
        { filename: 'evil"\r\nBcc: x@evil.com.txt', mimeType: 'text/plain; x=\r\n', data: Buffer.from('hi') },
      ],
    })
    expect(raw).toMatch(/Content-Type: multipart\/mixed; boundary="inboxmux_mix_[0-9a-f]+"/)
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"')
    expect(raw).toContain(`filename="=?UTF-8?B?${Buffer.from('Számla 2026.pdf').toString('base64')}?="`)
    expect(raw).toContain(Buffer.from('%PDF-1.7').toString('base64'))
    expect(raw).not.toMatch(/^Bcc:/m)
    expect(raw).toContain('Content-Type: application/octet-stream; name="evil___Bcc: x@evil.com.txt"')
    expect(raw.trimEnd().endsWith('--')).toBe(true)
  })

  it('encodes non ASCII display names', () => {
    const raw = buildMime({ ...base, from: { name: 'Kalmár Dániel', email: 'd@x.hu' } })
    expect(raw).toContain('From: =?UTF-8?B?')
    expect(decodeMimeWords(/From: (.*)\r\n/.exec(raw)?.[1] ?? '')).toBe('Kalmár Dániel <d@x.hu>')
  })
})

describe('htmlToText', () => {
  it('keeps structure and links, drops scripts, styles and invisible characters', () => {
    const html = `<html><head><style>p{}</style><title>t</title></head><body>
      <script>alert(1)</script><p>Hello&nbsp;<b>world</b> &amp; friends</p>
      <ul><li>One</li><li>Two</li></ul><a href="https://ex.com/x">Read</a> <a href="mailto:a@b">a@b</a>
      <span>​hid‌den⁠</span></body></html>`
    const text = htmlToText(html)
    expect(text).toBe('Hello world & friends\n\n- One\n- Two\nRead (https://ex.com/x) a@b\nhidden')
  })

  it('truncates with a marker', () => {
    expect(truncate('abcdef', 3)).toEqual({ text: 'abc\n[truncated, 3 more characters]', truncated: true })
    expect(truncate('abc', 3)).toEqual({ text: 'abc', truncated: false })
  })
})
