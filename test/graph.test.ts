import { describe, expect, it } from 'vitest'
import { buildGraphSearch, checkUploadUrl, decodePageToken, encodePageToken, GraphProvider, GRAPH_ROOT } from '../src/providers/graph.js'
import type { SearchQuery } from '../src/types.js'
import { account, fakeClient } from './helpers.js'

const q = (partial: Partial<SearchQuery>): SearchQuery => ({ folder: 'any', limit: 10, ...partial })
const ms = account({ email: 'me@outlook.com', provider: 'microsoft' })

describe('buildGraphSearch', () => {
  it('uses $search with KQL when there is text or an address', () => {
    const built = buildGraphSearch(q({ text: 'budget', from: 'boss@x.com', subject: 'Q4 plan', after: '2026-01-01', folder: 'inbox', unread: true }))
    expect(built.path).toBe('/mailFolders/inbox/messages')
    expect(built.params.get('$search')).toBe('"budget from:boss@x.com subject:\\"Q4 plan\\" received>=2026-01-01"')
    expect(built.params.has('$filter')).toBe(false)
    expect(built.clientUnreadFilter).toBe(true)
  })

  it('uses $filter ordered by date otherwise', () => {
    const built = buildGraphSearch(q({ unread: true, hasAttachment: true, before: '2026-02-01', folder: 'spam' }))
    expect(built.path).toBe('/mailFolders/junkemail/messages')
    expect(built.params.get('$filter')).toBe(
      'receivedDateTime ge 1900-01-01T00:00:00Z and receivedDateTime lt 2026-02-01T00:00:00Z and isRead eq false and hasAttachments eq true',
    )
    expect(built.params.get('$orderby')).toBe('receivedDateTime desc')
  })
})

describe('page tokens', () => {
  it('only accept Graph URLs', () => {
    const token = encodePageToken(`${GRAPH_ROOT}/messages?$skip=10`)
    expect(decodePageToken(token)).toBe(`${GRAPH_ROOT}/messages?$skip=10`)
    expect(() => decodePageToken(encodePageToken('https://evil.example/steal'))).toThrow(/not valid/)
    expect(() => decodePageToken(encodePageToken('https://graph.microsoft.com.evil.example/v1.0/me/x'))).toThrow()
  })
})

describe('GraphProvider', () => {
  it('maps search results and applies the unread filter on $search', async () => {
    const http = fakeClient(() => ({
      value: [
        {
          id: 'A1',
          conversationId: 'C1',
          subject: 'Hello',
          from: { emailAddress: { name: 'Bob', address: 'Bob@X.com' } },
          toRecipients: [{ emailAddress: { address: 'me@outlook.com' } }],
          receivedDateTime: '2026-03-01T10:00:00Z',
          bodyPreview: 'Hi there',
          isRead: false,
          hasAttachments: true,
          flag: { flagStatus: 'flagged' },
        },
        { id: 'A2', isRead: true, receivedDateTime: '2026-02-01T10:00:00Z' },
      ],
      '@odata.nextLink': `${GRAPH_ROOT}/messages?$skiptoken=abc`,
    }))
    const result = await new GraphProvider(ms, http).search(q({ text: 'hello', unread: true }))
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toMatchObject({
      account: 'me@outlook.com',
      id: 'A1',
      threadId: 'C1',
      from: { name: 'Bob', email: 'bob@x.com' },
      unread: true,
      starred: true,
      hasAttachments: true,
    })
    expect(decodePageToken(result.nextPageToken ?? '')).toContain('$skiptoken=abc')
  })

  it('asks for the body format through the Prefer header and lists attachments', async () => {
    const http = fakeClient((call) => {
      if (call.url.includes('/attachments')) return { value: [{ id: 'AT1', name: 'a.pdf', contentType: 'application/pdf', size: 9 }] }
      return { id: 'A1', hasAttachments: true, body: { contentType: 'html', content: '<p>Hi <b>there</b></p>' } }
    })
    const message = await new GraphProvider(ms, http).getMessage('A1', { format: 'text', maxChars: 1000 })
    expect(http.calls[0]?.headers.prefer).toBe('IdType="ImmutableId", outlook.body-content-type="text"')
    expect(message.body).toBe('Hi there')
    expect(message.attachments).toEqual([{ id: 'AT1', filename: 'a.pdf', mimeType: 'application/pdf', size: 9 }])
  })

  it('creates new drafts and replies', async () => {
    const http = fakeClient((call) => {
      if (call.url.endsWith('/createReplyAll')) return { id: 'D2', conversationId: 'C1', ccRecipients: [{ emailAddress: { address: 'x@y.com' } }] }
      if (call.method === 'PATCH') return { id: 'D2', conversationId: 'C1', webLink: 'https://outlook/D2' }
      return { id: 'D1', conversationId: 'C9', webLink: 'https://outlook/D1' }
    })
    const provider = new GraphProvider(ms, http)
    const fresh = await provider.createDraft({ to: ['a@x.com'], cc: [], bcc: [], subject: 'S', body: 'B', html: false, replyAll: false })
    expect(fresh).toMatchObject({ draftId: 'D1', threadId: 'C9' })
    expect(http.calls[0]?.body).toMatchObject({ subject: 'S', body: { contentType: 'Text', content: 'B' }, toRecipients: [{ emailAddress: { address: 'a@x.com' } }] })

    const reply = await provider.createDraft({ to: [], cc: ['z@y.com'], bcc: [], body: 'Thanks', html: false, replyToMessageId: 'A1', replyAll: true })
    expect(reply.draftId).toBe('D2')
    expect(http.calls[1]?.body).toEqual({ comment: 'Thanks' })
    expect(http.calls[2]?.body).toEqual({ ccRecipients: [{ emailAddress: { address: 'x@y.com' } }, { emailAddress: { address: 'z@y.com' } }] })
  })

  it('archives by moving and merges categories case insensitively', async () => {
    const http = fakeClient((call) => (call.method === 'GET' ? { categories: ['Red', 'Clients'] } : {}))
    await new GraphProvider(ms, http).updateMessage('A1', { read: true, addLabels: ['clients', 'Blue'], removeLabels: ['red'], moveTo: 'archive' })
    expect(http.calls[1]).toMatchObject({ method: 'PATCH', body: { isRead: true, categories: ['clients', 'Blue'] } })
    expect(http.calls[2]).toMatchObject({ method: 'POST', body: { destinationId: 'archive' } })
    expect(http.calls[2]?.url).toBe(`${GRAPH_ROOT}/messages/A1/move`)
  })

  it('only sends real drafts', async () => {
    const http = fakeClient(() => ({ isDraft: false }))
    await expect(new GraphProvider(ms, http).draftRecipients('A1')).rejects.toThrow(/not a draft/)
  })
})

describe('GraphProvider moves', () => {
  it('maps spam to junkemail and other targets to a folder id', async () => {
    const http = fakeClient((call) => {
      if (call.url.includes('/mailFolders?')) return { value: [{ id: 'F-INBOX', displayName: 'Inbox' }, { id: 'F-CL', displayName: 'Clients', childFolderCount: 0 }] }
      return {}
    })
    const provider = new GraphProvider(ms, http)
    await provider.updateMessage('A1', { moveTo: 'spam' })
    expect(http.calls.at(-1)?.body).toEqual({ destinationId: 'junkemail' })
    await provider.updateMessage('A1', { moveTo: 'clients' })
    expect(http.calls.at(-1)?.body).toEqual({ destinationId: 'F-CL' })
    await provider.updateMessage('A1', { moveTo: 'inbox' })
    expect(http.calls.at(-1)?.body).toEqual({ destinationId: 'inbox' })
    await expect(provider.updateMessage('A1', { moveTo: 'Nowhere' })).rejects.toThrow(/No folder "Nowhere"/)
    await expect(provider.updateMessage('A1', { moveTo: 'trash' })).rejects.toThrow(/trash_message/)
  })
})

describe('GraphProvider folders', () => {
  it('creates top level and nested folders', async () => {
    const http = fakeClient((call) => {
      if (call.url.includes('/mailFolders?')) return { value: [{ id: 'F-CL', displayName: 'Clients' }] }
      return { id: 'NEW', displayName: (call.body as { displayName: string }).displayName }
    })
    const provider = new GraphProvider(ms, http)
    expect(await provider.createFolder('Receipts')).toEqual({ id: 'NEW', name: 'Receipts', kind: 'user' })
    expect(http.calls[0]).toMatchObject({ method: 'POST', url: `${GRAPH_ROOT}/mailFolders`, body: { displayName: 'Receipts' } })
    expect(await provider.createFolder('clients/Acme')).toEqual({ id: 'NEW', name: 'clients/Acme', kind: 'user' })
    expect(http.calls.at(-1)).toMatchObject({ url: `${GRAPH_ROOT}/mailFolders/F-CL/childFolders`, body: { displayName: 'Acme' } })
    await expect(provider.createFolder('Nope/Child')).rejects.toThrow(/No folder "Nope"/)
  })
})

describe('GraphProvider forwarding and attachments', () => {
  it('forwards with createForward, keeps the comment and attaches small files inline', async () => {
    const http = fakeClient((call) => (call.url.endsWith('/createForward') ? { id: 'F1', conversationId: 'C1' } : {}))
    const draft = await new GraphProvider(ms, http).createDraft({
      to: ['bob@x.com'],
      cc: [],
      bcc: [],
      body: 'FYI',
      html: false,
      replyAll: false,
      forwardMessageId: 'A1',
      attachments: [{ filename: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('local') }],
    })
    expect(draft).toMatchObject({ draftId: 'F1', threadId: 'C1' })
    expect(http.calls[0]?.url).toBe(`${GRAPH_ROOT}/messages/A1/createForward`)
    expect(http.calls[0]?.body).toEqual({ toRecipients: [{ emailAddress: { address: 'bob@x.com' } }], comment: 'FYI' })
    expect(http.calls[1]).toMatchObject({
      method: 'POST',
      url: `${GRAPH_ROOT}/messages/F1/attachments`,
      body: { '@odata.type': '#microsoft.graph.fileAttachment', name: 'notes.txt', contentType: 'text/plain', contentBytes: Buffer.from('local').toString('base64') },
    })
  })

  it('puts HTML on top of the quoted original and can drop original attachments', async () => {
    const http = fakeClient((call) => {
      if (call.url.endsWith('/createForward')) return { id: 'F2' }
      if (call.url.includes('$select=body')) return { body: { contentType: 'html', content: '<html><body class="x"><p>Original</p></body></html>' } }
      if (call.url.includes('/attachments?')) return { value: [{ id: 'AT1' }, { id: 'AT2' }] }
      return { id: 'F2' }
    })
    await new GraphProvider(ms, http).createDraft({
      to: ['bob@x.com'],
      cc: [],
      bcc: [],
      body: '<p>See below</p>',
      html: true,
      replyAll: false,
      forwardMessageId: 'A1',
      includeOriginalAttachments: false,
    })
    expect(http.calls[0]?.body).toEqual({ toRecipients: [{ emailAddress: { address: 'bob@x.com' } }] })
    expect(http.calls[1]?.headers.prefer).toContain('outlook.body-content-type="html"')
    expect(http.calls[2]).toMatchObject({
      method: 'PATCH',
      body: { body: { contentType: 'HTML', content: '<html><body class="x"><p>See below</p><br><p>Original</p></body></html>' } },
    })
    expect(http.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
      `${GRAPH_ROOT}/messages/F2/attachments/AT1`,
      `${GRAPH_ROOT}/messages/F2/attachments/AT2`,
    ])
  })

  it('uploads large files in chunks without sending the bearer token', async () => {
    const uploadUrl = 'https://outlook.office.com/api/v2.0/Users/x/Messages/D1/AttachmentSessions/s1?authtoken=abc'
    const http = fakeClient((call) => {
      if (call.url.endsWith('/createUploadSession')) return { uploadUrl }
      return { id: 'D1' }
    })
    const size = 320 * 1024 * 12 + 1000
    await new GraphProvider(ms, http).createDraft({
      to: ['a@x.com'],
      cc: [],
      bcc: [],
      subject: 'Big',
      body: 'b',
      html: false,
      replyAll: false,
      attachments: [{ filename: 'big.bin', mimeType: 'application/octet-stream', data: Buffer.alloc(size, 7) }],
    })
    const session = http.calls.find((c) => c.url.endsWith('/createUploadSession'))
    expect(session?.body).toEqual({ AttachmentItem: { attachmentType: 'file', name: 'big.bin', size, contentType: 'application/octet-stream' } })
    const puts = http.calls.filter((c) => c.method === 'PUT')
    expect(puts.every((c) => c.external && c.url === uploadUrl && !c.headers.authorization)).toBe(true)
    expect(puts.map((c) => c.headers['content-range'])).toEqual([`bytes 0-${320 * 1024 * 12 - 1}/${size}`, `bytes ${320 * 1024 * 12}-${size - 1}/${size}`])
  })

  it('accepts only Microsoft upload hosts', () => {
    expect(checkUploadUrl('https://outlook.office.com/api/x')).toBe('https://outlook.office.com/api/x')
    expect(checkUploadUrl('https://outlook.office365.com/api/x')).toBe('https://outlook.office365.com/api/x')
    expect(() => checkUploadUrl('https://evil.example/office.com')).toThrow(/unexpected upload address/)
    expect(() => checkUploadUrl('http://outlook.office.com/api/x')).toThrow(/unexpected upload address/)
    expect(() => checkUploadUrl('https://outlook.office.com.evil.example/x')).toThrow(/unexpected upload address/)
    expect(() => checkUploadUrl(undefined)).toThrow(/no usable upload address/)
  })
})
