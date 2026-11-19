export type ProviderKind = 'google' | 'microsoft'

export interface AccountMeta {
  email: string
  provider: ProviderKind
  label?: string
  displayName?: string
  /** Addresses this account may send as (Gmail send-as aliases). Always includes `email`. */
  aliases: string[]
  scopes: string[]
  addedAt: string
  status: 'ok' | 'reauth'
}

export interface Address {
  name?: string
  email: string
}

export interface MessageSummary {
  account: string
  id: string
  threadId: string
  date: string
  from?: Address
  to: Address[]
  subject: string
  snippet: string
  unread: boolean
  starred: boolean
  hasAttachments: boolean
  labels?: string[]
  webLink?: string
}

export interface AttachmentInfo {
  id: string
  filename: string
  mimeType: string
  size: number
}

export interface MessageFull extends MessageSummary {
  cc: Address[]
  replyTo: Address[]
  body: string
  bodyFormat: 'text' | 'html'
  truncated: boolean
  attachments: AttachmentInfo[]
}

export const FOLDERS = ['any', 'inbox', 'sent', 'drafts', 'archive', 'spam', 'trash'] as const
export type FolderName = (typeof FOLDERS)[number]

export interface SearchQuery {
  text?: string
  from?: string
  to?: string
  subject?: string
  /** YYYY-MM-DD, inclusive */
  after?: string
  /** YYYY-MM-DD, exclusive */
  before?: string
  unread?: boolean
  hasAttachment?: boolean
  folder: FolderName
  limit: number
  pageToken?: string
}

export interface SearchResult {
  messages: MessageSummary[]
  nextPageToken?: string
}

export interface ReadOptions {
  format: 'text' | 'html'
  maxChars: number
}

export interface FolderInfo {
  id: string
  name: string
  kind: 'system' | 'user'
  unread?: number
  total?: number
}

export interface MessageChanges {
  read?: boolean
  starred?: boolean
  /**
   * `inbox`, `archive`, `spam`, or a folder (Outlook) or label (Gmail) name or id.
   * Moving to the inbox also restores a message from trash or spam.
   */
  moveTo?: string
  addLabels?: string[]
  removeLabels?: string[]
}

/** Total size cap for files attached to one outgoing message (Gmail and Exchange both accept this). */
export const MAX_OUTGOING_ATTACHMENT_BYTES = 25 * 1024 * 1024

export interface DraftInput {
  to: string[]
  cc: string[]
  bcc: string[]
  subject?: string
  body: string
  html: boolean
  from?: string
  replyToMessageId?: string
  replyAll: boolean
  /** Forward this message. Mutually exclusive with replyToMessageId. */
  forwardMessageId?: string
  /** Forwarding keeps the original attachments unless this is false. */
  includeOriginalAttachments?: boolean
  /** Files to attach, already read and checked by the server layer. */
  attachments?: AttachmentData[]
}

export interface DraftResult {
  draftId: string
  messageId?: string
  threadId?: string
  webLink?: string
}

export interface AttachmentData {
  filename: string
  mimeType: string
  data: Buffer
}

/** One mailbox provider. Gmail and Microsoft Graph implement the same surface. */
export interface MailProvider {
  search(query: SearchQuery): Promise<SearchResult>
  getMessage(id: string, options: ReadOptions): Promise<MessageFull>
  getThread(threadId: string, options: ReadOptions): Promise<MessageFull[]>
  listFolders(): Promise<FolderInfo[]>
  /** Creates a Gmail label or an Outlook folder. `Parent/Child` nests it under an existing parent. */
  createFolder(name: string): Promise<FolderInfo>
  updateMessage(id: string, changes: MessageChanges): Promise<void>
  createDraft(input: DraftInput): Promise<DraftResult>
  draftRecipients(draftId: string): Promise<string[]>
  sendDraft(draftId: string): Promise<void>
  trash(id: string): Promise<void>
  getAttachment(messageId: string, attachmentId: string): Promise<AttachmentData>
}

/** Errors whose message is safe to show to the model and the user. */
export class UserFacingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message)
    this.name = 'UserFacingError'
  }
}
