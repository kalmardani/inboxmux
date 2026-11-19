/** Plain text helpers for message bodies. No HTML parser dependency on purpose. */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '\u2026',
  ndash: '\u2013',
  mdash: '\u2014',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  laquo: '\u00ab',
  raquo: '\u00bb',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  euro: '\u20ac',
  bull: '\u2022',
  middot: '\u00b7',
  zwnj: '',
  zwj: '',
  shy: '',
}

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match
  })
}

/** Characters that render invisibly. Newsletters use them as padding, attackers to hide text. */
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\ufeff]/g

export function stripInvisible(input: string): string {
  return input.replace(INVISIBLE, '')
}

const MAX_LINK = 300

export function htmlToText(html: string): string {
  let s = html
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<(script|style|head|title|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, '')
  s = s.replace(
    /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_m, h1?: string, h2?: string, h3?: string, inner = '') => {
      const href = decodeEntities((h1 ?? h2 ?? h3 ?? '').trim())
      const label = decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
      if (!/^https?:\/\//i.test(href) || label === href) return label
      const shown = href.length > MAX_LINK ? `${href.slice(0, MAX_LINK)}...` : href
      return label ? `${label} (${shown})` : shown
    },
  )
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<li\b[^>]*>/gi, '\n- ')
  s = s.replace(/<\/?(p|div|h[1-6]|tr|table|tbody|thead|blockquote|section|article|header|footer|ul|ol|hr|center)\b[^>]*>/gi, '\n')
  s = s.replace(/<\/(td|th)\s*>/gi, ' ')
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  return tidy(s)
}

export function tidy(text: string): string {
  return stripInvisible(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: `${text.slice(0, maxChars)}\n[truncated, ${text.length - maxChars} more characters]`, truncated: true }
}

/** Escapes text for safe inclusion in an HTML body. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
