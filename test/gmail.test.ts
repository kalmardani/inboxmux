import { describe, expect, it } from 'vitest'
import { buildGmailQuery, GmailProvider, type GmailMessage } from '../src/providers/gmail.js'
import { decodeMimeWords } from '../src/providers/mime.js'
import type { SearchQuery } from '../src/types.js'
import { account, b64url, fakeClient } from './helpers.js'

const q = (partial: Partial<SearchQuery>): SearchQuery => ({ folder: 'any', limit: 10, ...partial })

describe('buildGmailQuery', () => {
  it('combines text and structured filters', () => {
    expect(
      buildGmailQuery(
        q({ text: 'invoice', from: 'boss@x.com', subject: 'Q4 report', after: '2026-01-02', unread: true, hasAttachment: true, folder: 'inbox' }),
      ),
    ).toBe('invoice from:boss@x.com subject:"Q4 report" after:2026/01/02 is:unread has:attachment in:inbox')
    expect(buildGmailQuery(q({ folder: 'archive', unread: false }))).toBe('is:read -in:inbox -in:sent -in:drafts')
  })
})

const multipart: GmailMessage = {
  id: 'm1',
  threadId: 't1',
  labelIds: ['INBOX', 'UNREAD'],
  snippet: 'Hello &amp; welcome',
  internalDate: '1767225600000',
  payload: {
    partId: '',
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: 'Alice <alice@x.com>' },
      { name: 'To', value: 'me@example.com' },
      { name: 'Subject', value: '=?UTF-8?B?w4lsxZEgdGVzenQ=?=' },
      { name: 'Message-ID', value: '<orig@x.com>' },
    ],
    parts: [
      {
        partId: '0',
        mimeType: 'multipart/alternative',
        parts: [
          {
            partId: '0.0',
            mimeType: 'text/plain',
            headers: [{ name: 'Content-Type', value: 'text/plain; charset="iso-8859-2"' }],
            body: { data: Buffer.from([0x54, 0xfb, 0x7a]).toString('base64url') },
          },
          { partId: '0.1', mimeType: 'text/html', body: { data: b64url('<p>Tűz</p>') } },
        ],
      },
      { partId: '1', mimeType: 'application/pdf', filename: 'report.pdf', body: { attachmentId: 'ATT-unstable', size: 1234 } },
    ],
  },
}

describe('GmailProvider', () => {
  it('searches with metadata fetches and maps summaries', async () => {
    const http = fakeClient((call) => {
      if (call.url.includes('/messages?')) return { messages: [{ id: 'm1' }], nextPageToken: 'next' }
      return multipart
    })
    const gmail = new GmailProvider(account(), http)
    const result = await gmail.search(q({ from: 'alice@x.com', limit: 5 }))
    expect(http.calls[0]?.url).toContain('maxResults=5')
    expect(http.calls[0]?.url).toContain('q=from%3Aalice%40x.com')
    expect(http.calls[1]?.url).toContain('format=metadata')
    expect(result.nextPageToken).toBe('next')
    expect(result.messages[0]).toMatchObject({
      id: 'm1',
      threadId: 't1',
      subject: 'Élő teszt',
      snippet: 'Hello & welcome',
      unread: true,
      hasAttachments: true,
      from: { name: 'Alice', email: 'alice@x.com' },
      date: '2026-01-01T00:00:00.000Z',
    })
  })

  it('reads the text body in its charset and lists attachments by stable part id', async () => {
    const gmail = new GmailProvider(account(), fakeClient(() => multipart))
    const message = await gmail.getMessage('m1', { format: 'text', maxChars: 1000 })
    expect(message.body).toBe('Tűz')
    expect(message.attachments).toEqual([{ id: '1', filename: 'report.pdf', mimeType: 'application/pdf', size: 1234 }])
    const html = await gmail.getMessage('m1', { format: 'html', maxChars: 1000 })
    expect(html).toMatchObject({ body: '<p>Tűz</p>', bodyFormat: 'html' })
  })

  it('downloads an attachment through the fresh attachment id', async () => {
    const http = fakeClient((call) => {
      if (call.url.includes('/attachments/')) return { data: Buffer.from('%PDF').toString('base64url') }
      return multipart
    })
    const file = await new GmailProvider(account(), http).getAttachment('m1', '1')
    expect(http.calls[1]?.url).toContain('/attachments/ATT-unstable')
    expect(file).toMatchObject({ filename: 'report.pdf', mimeType: 'application/pdf' })
    expect(file.data.toString()).toBe('%PDF')
  })

  it('builds a threaded reply with alias and reply all', async () => {
    const original: GmailMessage = {
      id: 'm1',
      threadId: 't1',
      payload: {
        headers: [
          { name: 'Subject', value: 'Plan' },
          { name: 'From', value: 'Alice <alice@x.com>' },
          { name: 'To', value: 'me@example.com, bob@x.com' },
          { name: 'Cc', value: 'carol@x.com' },
          { name: 'Message-ID', value: '<orig@x.com>' },
          { name: 'References', value: '<older@x.com>' },
        ],
      },
    }
    const http = fakeClient((call) => {
      if (call.url.endsWith('/settings/sendAs')) {
        return { sendAs: [{ sendAsEmail: 'work@corp.com', displayName: 'Me Work', verificationStatus: 'accepted' }] }
      }
      if (call.url.endsWith('/drafts')) return { id: 'd1', message: { id: 'm9', threadId: 't1' } }
      return original
    })
    const gmail = new GmailProvider(account(), http)
    const draft = await gmail.createDraft({
      to: [],
      cc: [],
      bcc: [],
      body: 'Sounds good',
      html: false,
      from: 'work@corp.com',
      replyToMessageId: 'm1',
      replyAll: true,
    })
    expect(draft).toMatchObject({ draftId: 'd1', threadId: 't1' })
    const post = http.calls.find((c) => c.url.endsWith('/drafts'))?.body as { message: { raw: string; threadId: string } }
    expect(post.message.threadId).toBe('t1')
    const raw = Buffer.from(post.message.raw, 'base64url').toString('utf8')
    expect(raw).toContain('From: "Me Work" <work@corp.com>')
    expect(raw).toContain('To: alice@x.com')
    expect(raw).toContain('Cc: bob@x.com, carol@x.com')
    expect(raw).toContain('Subject: Re: Plan')
    expect(raw).toContain('In-Reply-To: <orig@x.com>')
    expect(raw).toContain('References: <older@x.com> <orig@x.com>')
  })

  it('refuses an unverified from address', async () => {
    const http = fakeClient(() => ({ sendAs: [{ sendAsEmail: 'me@example.com', isPrimary: true }] }))
    await expect(
      new GmailProvider(account(), http).createDraft({ to: ['a@x.com'], cc: [], bcc: [], subject: 's', body: 'b', html: false, from: 'ceo@corp.com', replyAll: false }),
    ).rejects.toThrow(/not a verified send-as address/)
  })

  it('maps message changes to label ids', async () => {
    const http = fakeClient((call) => {
      if (call.url.endsWith('/labels')) return { labels: [{ id: 'Label_7', name: 'Clients' }] }
      return {}
    })
    await new GmailProvider(account(), http).updateMessage('m1', { read: true, archived: true, starred: true, addLabels: ['clients'] })
    const modify = http.calls.find((c) => c.url.endsWith('/modify'))
    expect(modify?.body).toEqual({ addLabelIds: ['STARRED', 'Label_7'], removeLabelIds: ['UNREAD', 'INBOX'] })
    await expect(new GmailProvider(account(), http).updateMessage('m1', { addLabels: ['nope'] })).rejects.toThrow(/does not exist/)
  })

  it('encodes ids in URL paths', async () => {
    const http = fakeClient(() => multipart)
    await new GmailProvider(account(), http).getMessage('../../settings', { format: 'text', maxChars: 100 })
    expect(http.calls[0]?.url).toContain('/messages/..%2F..%2Fsettings?')
  })

  it('decodes subjects that arrive encoded', () => {
    expect(decodeMimeWords('=?UTF-8?B?w4lsxZEgdGVzenQ=?=')).toBe('Élő teszt')
  })
})
