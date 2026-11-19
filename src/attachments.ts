import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, sep } from 'node:path'
import { MAX_OUTGOING_ATTACHMENT_BYTES, UserFacingError, type AttachmentData } from './types.js'

const TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.ics': 'text/calendar',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.eml': 'message/rfc822',
}

export function mimeTypeFor(filename: string): string {
  return TYPES[extname(filename).toLowerCase()] ?? 'application/octet-stream'
}

function real(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/**
 * Reads files the model wants to attach. A prompt injected through a message
 * could ask for secrets, so a file is only accepted when its real path (links
 * resolved) lies inside one of the allowed folders, no part of the path below
 * that folder is hidden (.ssh, .aws, .config ...), and it is not inside the
 * inboxmux config folder. The MCP client still shows every path to the user
 * before the call runs.
 */
export function readLocalAttachments(paths: string[], sources: string[], configDir?: string): AttachmentData[] {
  if (!paths.length) return []
  const roots = sources.map(real).filter((r): r is string => Boolean(r))
  const blocked = configDir ? real(configDir) : undefined
  let total = 0
  return paths.map((given) => {
    const expanded = given.startsWith('~/') ? join(homedir(), given.slice(2)) : given
    if (!isAbsolute(expanded)) throw new UserFacingError('invalid_attachment', `Use an absolute path for the attachment ${given}.`)
    const path = real(expanded)
    if (!path) throw new UserFacingError('attachment_not_found', `File not found: ${given}.`, 404)
    const root = roots.find((r) => path.startsWith(r.endsWith(sep) ? r : r + sep))
    if (!root) {
      throw new UserFacingError(
        'attachment_not_allowed',
        `${given} is outside the folders inboxmux attaches from (${sources.join(', ')}). The attachmentSources setting changes them.`,
        403,
      )
    }
    if (path.slice(root.length).split(sep).some((part) => part.startsWith('.'))) {
      throw new UserFacingError('attachment_not_allowed', `${given} is a hidden file or inside a hidden folder, which inboxmux never attaches.`, 403)
    }
    if (blocked && (path === blocked || path.startsWith(blocked + sep))) {
      throw new UserFacingError('attachment_not_allowed', 'Files of the inboxmux config folder are never attached.', 403)
    }
    const stat = statSync(path)
    if (!stat.isFile()) throw new UserFacingError('invalid_attachment', `${given} is not a regular file.`)
    total += stat.size
    if (total > MAX_OUTGOING_ATTACHMENT_BYTES) {
      throw new UserFacingError('too_large', 'The attachments add up to more than 25 MB. Share large files as a link instead.')
    }
    const filename = basename(expanded)
    return { filename, mimeType: mimeTypeFor(filename), data: readFileSync(path) }
  })
}
