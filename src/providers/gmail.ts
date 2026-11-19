import { mapLimit, type AuthedClient } from '../http.js'
import {
  UserFacingError,
  type AccountMeta,
  type AttachmentData,
  type AttachmentInfo,
  type DraftInput,
  type DraftResult,
  type FolderInfo,
  type MailProvider,
  type MessageChanges,
  type MessageFull,
  type MessageSummary,
  type ReadOptions,
  type SearchQuery,
  type SearchResult,
} from '../types.js'
import { buildMime, charsetOf, decodeBytes, decodeMimeWords, parseAddressList } from './mime.js'
import { decodeEntities, htmlToText, tidy, truncate } from './text.js'

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
const SUMMARY_HEADERS = ['From', 'To', 'Subject', 'Date']

interface GmailHeader {
  name: string
  value: string
}
export interface GmailPart {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: { size?: number; data?: string; attachmentId?: string }
  parts?: GmailPart[]
}
export interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  payload?: GmailPart
}
interface SendAs {
  sendAsEmail: string
  displayName?: string
  isPrimary?: boolean
  verificationStatus?: string
}

const enc = encodeURIComponent

function quote(value: string): string {
  const clean = value.replace(/"/g, '').trim()
  return /[\s()]/.test(clean) ? `"${clean}"` : clean
}

export function buildGmailQuery(q: SearchQuery): string {
  const parts: string[] = []
  if (q.text) parts.push(q.text)
  if (q.from) parts.push(`from:${quote(q.from)}`)
  if (q.to) parts.push(`to:${quote(q.to)}`)
  if (q.subject) parts.push(`subject:${quote(q.subject)}`)
  if (q.after) parts.push(`after:${q.after.replace(/-/g, '/')}`)
  if (q.before) parts.push(`before:${q.before.replace(/-/g, '/')}`)
  if (q.unread !== undefined) parts.push(q.unread ? 'is:unread' : 'is:read')
  if (q.hasAttachment !== undefined) parts.push(q.hasAttachment ? 'has:attachment' : '-has:attachment')
  switch (q.folder) {
    case 'any':
      break
    case 'archive':
      parts.push('-in:inbox -in:sent -in:drafts')
      break
    default:
      parts.push(`in:${q.folder}`)
  }
  return parts.join(' ')
}

export function header(part: GmailPart | undefined, name: string): string | undefined {
  const wanted = name.toLowerCase()
  return part?.headers?.find((h) => h.name.toLowerCase() === wanted)?.value
}

interface CollectedParts {
  text: GmailPart[]
  html: GmailPart[]
  attachments: AttachmentInfo[]
}

/** Walks the MIME tree and sorts leaves into text bodies, html bodies and attachments. */
export function collectParts(payload: GmailPart | undefined): CollectedParts {
  const out: CollectedParts = { text: [], html: [], attachments: [] }
  const walk = (part: GmailPart) => {
    if (part.parts?.length) {
      part.parts.forEach(walk)
      return
    }
    const type = (part.mimeType ?? '').toLowerCase()
    const disposition = header(part, 'Content-Disposition') ?? ''
    const isAttachment = Boolean(part.filename) || /^\s*attachment/i.test(disposition)
    if (isAttachment || (!type.startsWith('text/') && part.body?.attachmentId)) {
      out.attachments.push({
        id: part.partId ?? '',
        filename: part.filename || 'attachment',
        mimeType: type || 'application/octet-stream',
        size: part.body?.size ?? 0,
      })
    } else if (type === 'text/plain') out.text.push(part)
    else if (type === 'text/html') out.html.push(part)
  }
  if (payload) walk(payload)
  return out
}

export function findPart(payload: GmailPart | undefined, partId: string): GmailPart | undefined {
  if (!payload) return undefined
  if (payload.partId === partId) return payload
  for (const child of payload.parts ?? []) {
    const hit = findPart(child, partId)
    if (hit) return hit
  }
  return undefined
}

export class GmailProvider implements MailProvider {
  private sendAs: SendAs[] | undefined
  private labelsCache: { id: string; name: string; type?: string }[] | undefined

  constructor(
    private readonly account: AccountMeta,
    private readonly http: AuthedClient,
  ) {}

  async search(q: SearchQuery): Promise<SearchResult> {
    const params = new URLSearchParams({ maxResults: String(q.limit) })
    const query = buildGmailQuery(q)
    if (query) params.set('q', query)
    if (q.pageToken) params.set('pageToken', q.pageToken)
    if (q.folder === 'spam' || q.folder === 'trash') params.set('includeSpamTrash', 'true')
    const list = await this.http.json<{ messages?: { id: string }[]; nextPageToken?: string }>(`${BASE}/messages?${params}`)
    const metadata = new URLSearchParams({ format: 'metadata' })
    for (const h of SUMMARY_HEADERS) metadata.append('metadataHeaders', h)
    const messages = await mapLimit(list.messages ?? [], 8, (m) =>
      this.http.json<GmailMessage>(`${BASE}/messages/${enc(m.id)}?${metadata}`),
    )
    return { messages: messages.map((m) => this.summary(m)), nextPageToken: list.nextPageToken }
  }

  async getMessage(id: string, options: ReadOptions): Promise<MessageFull> {
    const message = await this.http.json<GmailMessage>(`${BASE}/messages/${enc(id)}?format=full`)
    return this.full(message, options)
  }

  async getThread(threadId: string, options: ReadOptions): Promise<MessageFull[]> {
    const thread = await this.http.json<{ messages?: GmailMessage[] }>(`${BASE}/threads/${enc(threadId)}?format=full`)
    return Promise.all((thread.messages ?? []).slice(-50).map((m) => this.full(m, options)))
  }

  async listFolders(): Promise<FolderInfo[]> {
    const labels = await this.labels(true)
    return labels
      .filter((l) => !/^CATEGORY_|^CHAT$/.test(l.id))
      .map((l) => ({ id: l.id, name: l.name, kind: l.type === 'system' ? 'system' : 'user' }))
  }

  async updateMessage(id: string, changes: MessageChanges): Promise<void> {
    const add = new Set<string>()
    const remove = new Set<string>()
    if (changes.read !== undefined) (changes.read ? remove : add).add('UNREAD')
    if (changes.starred !== undefined) (changes.starred ? add : remove).add('STARRED')
    if (changes.archived !== undefined) (changes.archived ? remove : add).add('INBOX')
    for (const name of changes.addLabels ?? []) add.add(await this.labelId(name))
    for (const name of changes.removeLabels ?? []) remove.add(await this.labelId(name))
    await this.http.send(`${BASE}/messages/${enc(id)}/modify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addLabelIds: [...add], removeLabelIds: [...remove] }),
    })
  }

  async createDraft(input: DraftInput): Promise<DraftResult> {
    let to = input.to
    let cc = input.cc
    let subject = input.subject
    let inReplyTo: string | undefined
    let references: string | undefined
    let threadId: string | undefined
    if (input.replyToMessageId) {
      const params = new URLSearchParams({ format: 'metadata' })
      for (const h of ['Subject', 'From', 'Reply-To', 'To', 'Cc', 'Message-ID', 'References']) params.append('metadataHeaders', h)
      const original = await this.http.json<GmailMessage>(`${BASE}/messages/${enc(input.replyToMessageId)}?${params}`)
      const mine = new Set(this.account.aliases)
      const replyTarget = parseAddressList(header(original.payload, 'Reply-To') ?? header(original.payload, 'From'))
      if (!to.length) to = replyTarget.map((a) => a.email).filter((e) => !mine.has(e))
      if (!to.length) to = parseAddressList(header(original.payload, 'To')).map((a) => a.email)
      if (input.replyAll) {
        const others = [...parseAddressList(header(original.payload, 'To')), ...parseAddressList(header(original.payload, 'Cc'))]
          .map((a) => a.email)
          .filter((e) => !mine.has(e) && !to.includes(e))
        cc = [...new Set([...cc, ...others])]
      }
      const originalSubject = decodeMimeWords(header(original.payload, 'Subject') ?? '')
      subject ??= /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`
      const messageId = header(original.payload, 'Message-ID')
      inReplyTo = messageId
      references = [header(original.payload, 'References'), messageId].filter(Boolean).join(' ') || undefined
      threadId = original.threadId
    }
    if (!to.length) throw new UserFacingError('invalid_draft', 'A draft needs at least one recipient in `to`.')
    const from = input.from ? await this.alias(input.from) : undefined
    const raw = buildMime({ from, to, cc, bcc: input.bcc, subject: subject ?? '', body: input.body, html: input.html, inReplyTo, references })
    const draft = await this.http.json<{ id: string; message?: { id: string; threadId: string } }>(`${BASE}/drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { raw: Buffer.from(raw).toString('base64url'), ...(threadId ? { threadId } : {}) } }),
    })
    return {
      draftId: draft.id,
      messageId: draft.message?.id,
      threadId: draft.message?.threadId,
      webLink: `https://mail.google.com/mail/?authuser=${enc(this.account.email)}#drafts`,
    }
  }

  async draftRecipients(draftId: string): Promise<string[]> {
    const draft = await this.http.json<{ message?: GmailMessage }>(`${BASE}/drafts/${enc(draftId)}?format=metadata`)
    const payload = draft.message?.payload
    return ['To', 'Cc', 'Bcc'].flatMap((h) => parseAddressList(header(payload, h)).map((a) => a.email))
  }

  async sendDraft(draftId: string): Promise<void> {
    await this.http.send(`${BASE}/drafts/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: draftId }),
    })
  }

  async trash(id: string): Promise<void> {
    await this.http.send(`${BASE}/messages/${enc(id)}/trash`, { method: 'POST' })
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<AttachmentData> {
    // Gmail attachment ids change on every fetch, so inboxmux exposes the stable
    // MIME part id and resolves the current attachment id here.
    const message = await this.http.json<GmailMessage>(`${BASE}/messages/${enc(messageId)}?format=full`)
    const part = findPart(message.payload, attachmentId)
    if (!part) throw new UserFacingError('not_found', `Message ${messageId} has no attachment ${attachmentId}.`, 404)
    let data: Buffer
    if (part.body?.attachmentId) {
      const body = await this.http.json<{ data?: string }>(
        `${BASE}/messages/${enc(messageId)}/attachments/${enc(part.body.attachmentId)}`,
      )
      data = Buffer.from(body.data ?? '', 'base64url')
    } else {
      data = Buffer.from(part.body?.data ?? '', 'base64url')
    }
    return { filename: part.filename || 'attachment', mimeType: part.mimeType || 'application/octet-stream', data }
  }

  private summary(m: GmailMessage): MessageSummary {
    const labels = m.labelIds ?? []
    const dateHeader = header(m.payload, 'Date')
    const date = m.internalDate
      ? new Date(Number(m.internalDate)).toISOString()
      : dateHeader && !Number.isNaN(Date.parse(dateHeader))
        ? new Date(dateHeader).toISOString()
        : ''
    return {
      account: this.account.email,
      id: m.id,
      threadId: m.threadId,
      date,
      from: parseAddressList(header(m.payload, 'From'))[0],
      to: parseAddressList(header(m.payload, 'To')),
      subject: decodeMimeWords(header(m.payload, 'Subject') ?? ''),
      snippet: tidy(decodeEntities(m.snippet ?? '')),
      unread: labels.includes('UNREAD'),
      starred: labels.includes('STARRED'),
      hasAttachments: (m.payload?.mimeType ?? '').toLowerCase() === 'multipart/mixed' || collectParts(m.payload).attachments.length > 0,
      labels,
    }
  }

  private async full(m: GmailMessage, options: ReadOptions): Promise<MessageFull> {
    const parts = collectParts(m.payload)
    const text = await this.decodeParts(m.id, parts.text)
    const html = await this.decodeParts(m.id, parts.html)
    let body = ''
    let bodyFormat: 'text' | 'html' = 'text'
    if (options.format === 'html' && html) {
      body = html
      bodyFormat = 'html'
    } else if (text) body = tidy(text)
    else if (html) body = htmlToText(html)
    const cut = truncate(body, options.maxChars)
    return {
      ...this.summary(m),
      hasAttachments: parts.attachments.length > 0,
      cc: parseAddressList(header(m.payload, 'Cc')),
      replyTo: parseAddressList(header(m.payload, 'Reply-To')),
      body: cut.text,
      bodyFormat,
      truncated: cut.truncated,
      attachments: parts.attachments,
    }
  }

  private async decodeParts(messageId: string, parts: GmailPart[]): Promise<string> {
    const chunks = await Promise.all(
      parts.map(async (part) => {
        let data = part.body?.data
        if (!data && part.body?.attachmentId) {
          const body = await this.http.json<{ data?: string }>(
            `${BASE}/messages/${enc(messageId)}/attachments/${enc(part.body.attachmentId)}`,
          )
          data = body.data
        }
        return data ? decodeBytes(Buffer.from(data, 'base64url'), charsetOf(header(part, 'Content-Type'))) : ''
      }),
    )
    return chunks.filter(Boolean).join('\n\n')
  }

  private async labels(refresh = false): Promise<{ id: string; name: string; type?: string }[]> {
    if (!this.labelsCache || refresh) {
      const result = await this.http.json<{ labels?: { id: string; name: string; type?: string }[] }>(`${BASE}/labels`)
      this.labelsCache = result.labels ?? []
    }
    return this.labelsCache
  }

  private async labelId(nameOrId: string): Promise<string> {
    const wanted = nameOrId.toLowerCase()
    const match = (list: { id: string; name: string }[]) =>
      list.find((l) => l.id.toLowerCase() === wanted || l.name.toLowerCase() === wanted)
    const found = match(await this.labels()) ?? match(await this.labels(true))
    if (!found) throw new UserFacingError('unknown_label', `Gmail label "${nameOrId}" does not exist in ${this.account.email}.`, 404)
    return found.id
  }

  private async alias(address: string): Promise<{ email: string; name?: string }> {
    this.sendAs ??= (await this.http.json<{ sendAs?: SendAs[] }>(`${BASE}/settings/sendAs`)).sendAs ?? []
    const wanted = address.toLowerCase()
    const hit = this.sendAs.find(
      (s) => s.sendAsEmail.toLowerCase() === wanted && (s.isPrimary || s.verificationStatus === 'accepted'),
    )
    if (!hit) {
      const known = this.sendAs.map((s) => s.sendAsEmail).join(', ')
      throw new UserFacingError('invalid_from', `${address} is not a verified send-as address of ${this.account.email}. Available: ${known}.`)
    }
    return hit.displayName ? { email: hit.sendAsEmail, name: hit.displayName } : { email: hit.sendAsEmail }
  }
}

/** Reads the profile and verified aliases right after a Google sign-in. */
export async function gmailProfile(http: AuthedClient): Promise<{ email: string; aliases: string[]; displayName?: string }> {
  const profile = await http.json<{ emailAddress: string }>(`${BASE}/profile`)
  const sendAs = (await http.json<{ sendAs?: SendAs[] }>(`${BASE}/settings/sendAs`)).sendAs ?? []
  const usable = sendAs.filter((s) => s.isPrimary || s.verificationStatus === 'accepted')
  return {
    email: profile.emailAddress.toLowerCase(),
    aliases: usable.map((s) => s.sendAsEmail.toLowerCase()),
    displayName: usable.find((s) => s.isPrimary)?.displayName || undefined,
  }
}
