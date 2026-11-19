import { mapLimit, type AuthedClient } from '../http.js'
import {
  UserFacingError,
  type AccountMeta,
  type Address,
  type AttachmentData,
  type AttachmentInfo,
  type DraftInput,
  type DraftResult,
  type FolderInfo,
  type FolderName,
  type MailProvider,
  type MessageChanges,
  type MessageFull,
  type MessageSummary,
  type ReadOptions,
  type SearchQuery,
  type SearchResult,
} from '../types.js'
import { htmlToText, tidy, truncate } from './text.js'

export const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0/me'
const SELECT =
  'id,conversationId,subject,from,toRecipients,ccRecipients,replyTo,receivedDateTime,bodyPreview,isRead,hasAttachments,webLink,flag,categories,isDraft'

/** Immutable ids stay the same when a message moves between folders (archive, trash). */
export const GRAPH_HEADERS = { Prefer: 'IdType="ImmutableId"' }

const WELL_KNOWN: Record<Exclude<FolderName, 'any'>, string> = {
  inbox: 'inbox',
  sent: 'sentitems',
  drafts: 'drafts',
  archive: 'archive',
  spam: 'junkemail',
  trash: 'deleteditems',
}

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string }
}
export interface GraphMessage {
  id: string
  conversationId?: string
  subject?: string
  from?: GraphRecipient
  toRecipients?: GraphRecipient[]
  ccRecipients?: GraphRecipient[]
  bccRecipients?: GraphRecipient[]
  replyTo?: GraphRecipient[]
  receivedDateTime?: string
  bodyPreview?: string
  isRead?: boolean
  isDraft?: boolean
  hasAttachments?: boolean
  webLink?: string
  flag?: { flagStatus?: string }
  categories?: string[]
  body?: { contentType?: string; content?: string }
}
interface GraphList<T> {
  value?: T[]
  '@odata.nextLink'?: string
}
interface GraphAttachment {
  '@odata.type'?: string
  id: string
  name?: string
  contentType?: string
  size?: number
  isInline?: boolean
}

const enc = encodeURIComponent

function kqlValue(value: string): string {
  const clean = value.replace(/["\\]/g, ' ').trim()
  return /\s/.test(clean) ? `\\"${clean}\\"` : clean
}

/**
 * Microsoft Graph cannot combine $search with $filter on messages, so a query
 * with free text or address terms becomes a KQL $search, anything else a
 * $filter ordered by date. Unread filtering on the $search path happens
 * client side.
 */
export function buildGraphSearch(q: SearchQuery): { path: string; params: URLSearchParams; clientUnreadFilter: boolean } {
  const path = q.folder === 'any' ? '/messages' : `/mailFolders/${WELL_KNOWN[q.folder]}/messages`
  const params = new URLSearchParams({ $top: String(q.limit), $select: SELECT })
  const useSearch = Boolean(q.text || q.from || q.to || q.subject)
  if (useSearch) {
    const terms: string[] = []
    if (q.text) terms.push(q.text.replace(/"/g, '\\"'))
    if (q.from) terms.push(`from:${kqlValue(q.from)}`)
    if (q.to) terms.push(`to:${kqlValue(q.to)}`)
    if (q.subject) terms.push(`subject:${kqlValue(q.subject)}`)
    if (q.after) terms.push(`received>=${q.after}`)
    if (q.before) terms.push(`received<${q.before}`)
    if (q.hasAttachment !== undefined) terms.push(`hasattachments:${q.hasAttachment}`)
    params.set('$search', `"${terms.join(' ')}"`)
    return { path, params, clientUnreadFilter: q.unread !== undefined }
  }
  // When $orderby is used, the ordered property has to appear first in $filter.
  const filters = [`receivedDateTime ge ${q.after ? `${q.after}T00:00:00Z` : '1900-01-01T00:00:00Z'}`]
  if (q.before) filters.push(`receivedDateTime lt ${q.before}T00:00:00Z`)
  if (q.unread !== undefined) filters.push(`isRead eq ${!q.unread}`)
  if (q.hasAttachment !== undefined) filters.push(`hasAttachments eq ${q.hasAttachment}`)
  params.set('$filter', filters.join(' and '))
  params.set('$orderby', 'receivedDateTime desc')
  return { path, params, clientUnreadFilter: false }
}

/** Next page links are wrapped so a page token can never point the bearer token at another host. */
export function encodePageToken(nextLink: string): string {
  return Buffer.from(nextLink, 'utf8').toString('base64url')
}

export function decodePageToken(token: string): string {
  const url = Buffer.from(token, 'base64url').toString('utf8')
  if (!url.startsWith(`${GRAPH_ROOT}/`)) throw new UserFacingError('invalid_page_token', 'The page token is not valid for this account.')
  return url
}

function address(r: GraphRecipient | undefined): Address | undefined {
  const email = r?.emailAddress?.address?.toLowerCase()
  if (!email) return undefined
  const name = r?.emailAddress?.name
  return name && name.toLowerCase() !== email ? { name, email } : { email }
}

function addresses(list: GraphRecipient[] | undefined): Address[] {
  return (list ?? []).map(address).filter((a): a is Address => Boolean(a))
}

function recipients(emails: string[]): GraphRecipient[] {
  return emails.map((address) => ({ emailAddress: { address } }))
}

export class GraphProvider implements MailProvider {
  constructor(
    private readonly account: AccountMeta,
    private readonly http: AuthedClient,
  ) {}

  async search(q: SearchQuery): Promise<SearchResult> {
    let url: string
    let clientUnreadFilter = false
    if (q.pageToken) {
      url = decodePageToken(q.pageToken)
      clientUnreadFilter = q.unread !== undefined && Boolean(q.text || q.from || q.to || q.subject)
    } else {
      const built = buildGraphSearch(q)
      url = `${GRAPH_ROOT}${built.path}?${built.params}`
      clientUnreadFilter = built.clientUnreadFilter
    }
    const page = await this.http.json<GraphList<GraphMessage>>(url)
    let messages = (page.value ?? []).map((m) => this.summary(m))
    if (clientUnreadFilter) messages = messages.filter((m) => m.unread === q.unread)
    const next = page['@odata.nextLink']
    return { messages, nextPageToken: next ? encodePageToken(next) : undefined }
  }

  async getMessage(id: string, options: ReadOptions): Promise<MessageFull> {
    const message = await this.http.json<GraphMessage>(`${GRAPH_ROOT}/messages/${enc(id)}?$select=${SELECT},body`, {
      headers: { Prefer: this.prefer(options) },
    })
    return this.full(message, options)
  }

  async getThread(threadId: string, options: ReadOptions): Promise<MessageFull[]> {
    const filter = `conversationId eq '${threadId.replace(/'/g, "''")}'`
    const params = new URLSearchParams({ $filter: filter, $select: `${SELECT},body`, $top: '50' })
    const page = await this.http.json<GraphList<GraphMessage>>(`${GRAPH_ROOT}/messages?${params}`, {
      headers: { Prefer: this.prefer(options) },
    })
    const sorted = (page.value ?? []).sort((a, b) => (a.receivedDateTime ?? '').localeCompare(b.receivedDateTime ?? ''))
    return mapLimit(sorted, 4, (m) => this.full(m, options))
  }

  async listFolders(): Promise<FolderInfo[]> {
    const select = '$select=id,displayName,unreadItemCount,totalItemCount,childFolderCount&$top=100'
    const top = await this.http.json<GraphList<{ id: string; displayName: string; unreadItemCount?: number; totalItemCount?: number; childFolderCount?: number }>>(
      `${GRAPH_ROOT}/mailFolders?${select}`,
    )
    const folders: FolderInfo[] = []
    for (const f of top.value ?? []) {
      folders.push({ id: f.id, name: f.displayName, kind: 'user', unread: f.unreadItemCount, total: f.totalItemCount })
      if (f.childFolderCount) {
        const children = await this.http.json<GraphList<{ id: string; displayName: string; unreadItemCount?: number; totalItemCount?: number }>>(
          `${GRAPH_ROOT}/mailFolders/${enc(f.id)}/childFolders?${select}`,
        )
        for (const c of children.value ?? []) {
          folders.push({ id: c.id, name: `${f.displayName}/${c.displayName}`, kind: 'user', unread: c.unreadItemCount, total: c.totalItemCount })
        }
      }
    }
    return folders
  }

  async updateMessage(id: string, changes: MessageChanges): Promise<void> {
    const patch: Record<string, unknown> = {}
    if (changes.read !== undefined) patch.isRead = changes.read
    if (changes.starred !== undefined) patch.flag = { flagStatus: changes.starred ? 'flagged' : 'notFlagged' }
    if (changes.addLabels?.length || changes.removeLabels?.length) {
      const current = await this.http.json<GraphMessage>(`${GRAPH_ROOT}/messages/${enc(id)}?$select=categories`)
      const remove = new Set((changes.removeLabels ?? []).map((l) => l.toLowerCase()))
      const merged = [...(current.categories ?? []), ...(changes.addLabels ?? [])].filter((c) => !remove.has(c.toLowerCase()))
      patch.categories = [...new Map(merged.map((c) => [c.toLowerCase(), c])).values()]
    }
    if (Object.keys(patch).length) {
      await this.http.send(`${GRAPH_ROOT}/messages/${enc(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
    }
    if (changes.archived !== undefined) await this.move(id, changes.archived ? 'archive' : 'inbox')
  }

  async createDraft(input: DraftInput): Promise<DraftResult> {
    const body = { contentType: input.html ? 'HTML' : 'Text', content: input.body }
    let draft: GraphMessage
    if (input.replyToMessageId) {
      const action = input.replyAll ? 'createReplyAll' : 'createReply'
      draft = await this.http.json<GraphMessage>(`${GRAPH_ROOT}/messages/${enc(input.replyToMessageId)}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input.html ? { message: { body } } : { comment: input.body }),
      })
      const patch: Record<string, unknown> = {}
      if (input.to.length) patch.toRecipients = recipients(input.to)
      if (input.cc.length) patch.ccRecipients = [...(draft.ccRecipients ?? []), ...recipients(input.cc)]
      if (input.bcc.length) patch.bccRecipients = recipients(input.bcc)
      if (input.subject) patch.subject = input.subject
      if (input.from) patch.from = { emailAddress: { address: input.from } }
      if (Object.keys(patch).length) {
        draft = await this.http.json<GraphMessage>(`${GRAPH_ROOT}/messages/${enc(draft.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        })
      }
    } else {
      if (!input.to.length) throw new UserFacingError('invalid_draft', 'A draft needs at least one recipient in `to`.')
      draft = await this.http.json<GraphMessage>(`${GRAPH_ROOT}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: input.subject ?? '',
          body,
          toRecipients: recipients(input.to),
          ccRecipients: recipients(input.cc),
          bccRecipients: recipients(input.bcc),
          ...(input.from ? { from: { emailAddress: { address: input.from } } } : {}),
        }),
      })
    }
    return { draftId: draft.id, messageId: draft.id, threadId: draft.conversationId, webLink: draft.webLink }
  }

  async draftRecipients(draftId: string): Promise<string[]> {
    const draft = await this.http.json<GraphMessage>(
      `${GRAPH_ROOT}/messages/${enc(draftId)}?$select=isDraft,toRecipients,ccRecipients,bccRecipients`,
    )
    if (!draft.isDraft) throw new UserFacingError('not_a_draft', `${draftId} is not a draft.`)
    return [...addresses(draft.toRecipients), ...addresses(draft.ccRecipients), ...addresses(draft.bccRecipients)].map((a) => a.email)
  }

  async sendDraft(draftId: string): Promise<void> {
    await this.http.send(`${GRAPH_ROOT}/messages/${enc(draftId)}/send`, { method: 'POST' })
  }

  async trash(id: string): Promise<void> {
    await this.move(id, 'deleteditems')
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<AttachmentData> {
    const base = `${GRAPH_ROOT}/messages/${enc(messageId)}/attachments/${enc(attachmentId)}`
    const meta = await this.http.json<GraphAttachment>(`${base}?$select=id,name,contentType,size`)
    if (meta['@odata.type'] && meta['@odata.type'] !== '#microsoft.graph.fileAttachment') {
      throw new UserFacingError('unsupported_attachment', 'Only file attachments can be downloaded (not attached items or cloud links).')
    }
    const data = await this.http.buffer(`${base}/$value`)
    return { filename: meta.name || 'attachment', mimeType: meta.contentType || 'application/octet-stream', data }
  }

  private prefer(options: ReadOptions): string {
    return `${GRAPH_HEADERS.Prefer}, outlook.body-content-type="${options.format}"`
  }

  private async move(id: string, destinationId: string): Promise<void> {
    await this.http.send(`${GRAPH_ROOT}/messages/${enc(id)}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationId }),
    })
  }

  private summary(m: GraphMessage): MessageSummary {
    return {
      account: this.account.email,
      id: m.id,
      threadId: m.conversationId ?? '',
      date: m.receivedDateTime ?? '',
      from: address(m.from),
      to: addresses(m.toRecipients),
      subject: m.subject ?? '',
      snippet: tidy(m.bodyPreview ?? ''),
      unread: m.isRead === false,
      starred: m.flag?.flagStatus === 'flagged',
      hasAttachments: Boolean(m.hasAttachments),
      labels: m.categories?.length ? m.categories : undefined,
      webLink: m.webLink,
    }
  }

  private async full(m: GraphMessage, options: ReadOptions): Promise<MessageFull> {
    const raw = m.body?.content ?? ''
    const isHtml = (m.body?.contentType ?? '').toLowerCase() === 'html'
    const body = options.format === 'html' ? raw : isHtml ? htmlToText(raw) : tidy(raw)
    const cut = truncate(body, options.maxChars)
    let attachments: AttachmentInfo[] = []
    if (m.hasAttachments) {
      const list = await this.http.json<GraphList<GraphAttachment>>(
        `${GRAPH_ROOT}/messages/${enc(m.id)}/attachments?$select=id,name,contentType,size,isInline`,
      )
      attachments = (list.value ?? []).map((a) => ({
        id: a.id,
        filename: a.name || 'attachment',
        mimeType: a.contentType || 'application/octet-stream',
        size: a.size ?? 0,
      }))
    }
    return {
      ...this.summary(m),
      cc: addresses(m.ccRecipients),
      replyTo: addresses(m.replyTo),
      body: cut.text,
      bodyFormat: options.format === 'html' && isHtml ? 'html' : 'text',
      truncated: cut.truncated,
      attachments,
    }
  }
}

/** Reads the signed-in user right after a Microsoft sign-in. */
export async function graphProfile(http: AuthedClient): Promise<{ email: string; aliases: string[]; displayName?: string }> {
  const me = await http.json<{ mail?: string | null; userPrincipalName?: string; displayName?: string }>(
    `${GRAPH_ROOT}?$select=mail,userPrincipalName,displayName`,
  )
  const email = (me.mail || me.userPrincipalName || '').toLowerCase()
  if (!email.includes('@')) throw new UserFacingError('no_mailbox', 'This Microsoft account has no mailbox address.')
  return { email, aliases: [email], displayName: me.displayName || undefined }
}
