/**
 * Logging goes to stderr only. In MCP stdio mode stdout carries the protocol,
 * so a single stray console.log would corrupt the session.
 * Never pass tokens, message bodies or full addresses to these functions.
 */
const debugEnabled = process.env.INBOXMUX_LOG === 'debug'

function write(level: string, message: string): void {
  process.stderr.write(`[inboxmux] ${level} ${message}\n`)
}

export const log = {
  info: (message: string) => write('info', message),
  warn: (message: string) => write('warn', message),
  error: (message: string) => write('error', message),
  debug: (message: string) => {
    if (debugEnabled) write('debug', message)
  },
}
