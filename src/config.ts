import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { writeFileAtomic } from './fsutil.js'

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.INBOXMUX_HOME) return env.INBOXMUX_HOME
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'inboxmux')
}

const TENANT = /^[A-Za-z0-9.-]{1,100}$/

const ConfigFileSchema = z
  .object({
    uiPort: z.number().int().min(1024).max(65535).optional(),
    google: z
      .object({ clientId: z.string().min(1).optional(), clientSecret: z.string().min(1).optional() })
      .strict()
      .optional(),
    microsoft: z
      .object({
        clientId: z.string().min(1).optional(),
        clientSecret: z.string().min(1).optional(),
        tenant: z.string().regex(TENANT).optional(),
      })
      .strict()
      .optional(),
    capabilities: z.object({ send: z.boolean().optional(), trash: z.boolean().optional() }).strict().optional(),
    sendAllowlist: z.array(z.string().min(3)).optional(),
    attachmentsDir: z.string().min(1).optional(),
  })
  .strict()

export type ConfigFile = z.infer<typeof ConfigFileSchema>

export interface Config {
  dir: string
  uiPort: number
  google: { clientId?: string; clientSecret?: string }
  microsoft: { clientId?: string; clientSecret?: string; tenant: string }
  capabilities: { send: boolean; trash: boolean }
  /** Exact addresses or `@domain` entries. Empty means no restriction once sending is enabled. */
  sendAllowlist: string[]
  attachmentsDir: string
}

export function configPath(dir: string): string {
  return join(dir, 'config.json')
}

export function readConfigFile(dir: string): ConfigFile {
  const path = configPath(dir)
  if (!existsSync(path)) return {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`${path} is not valid JSON.`)
  }
  const parsed = ConfigFileSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`${path} is invalid at ${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'unknown error'}`)
  }
  return parsed.data
}

export function updateConfigFile(dir: string, mutate: (config: ConfigFile) => void): void {
  const current = readConfigFile(dir)
  mutate(current)
  const checked = ConfigFileSchema.parse(current)
  writeFileAtomic(configPath(dir), JSON.stringify(checked, null, 2) + '\n', 0o600)
}

function flag(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined
  return value === '1' || value.toLowerCase() === 'true'
}

/** Reads config.json and applies INBOXMUX_* environment overrides. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dir = configDir(env)
  const file = readConfigFile(dir)
  const tenant = env.INBOXMUX_MICROSOFT_TENANT || file.microsoft?.tenant || 'common'
  if (!TENANT.test(tenant)) throw new Error('INBOXMUX_MICROSOFT_TENANT has invalid characters.')
  const port = env.INBOXMUX_UI_PORT ? Number(env.INBOXMUX_UI_PORT) : (file.uiPort ?? 8765)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('INBOXMUX_UI_PORT must be 1024-65535.')
  return {
    dir,
    uiPort: port,
    google: {
      clientId: env.INBOXMUX_GOOGLE_CLIENT_ID || file.google?.clientId,
      clientSecret: env.INBOXMUX_GOOGLE_CLIENT_SECRET || file.google?.clientSecret,
    },
    microsoft: {
      clientId: env.INBOXMUX_MICROSOFT_CLIENT_ID || file.microsoft?.clientId,
      clientSecret: env.INBOXMUX_MICROSOFT_CLIENT_SECRET || file.microsoft?.clientSecret,
      tenant,
    },
    capabilities: {
      send: flag(env.INBOXMUX_ALLOW_SEND) ?? file.capabilities?.send ?? false,
      trash: flag(env.INBOXMUX_ALLOW_TRASH) ?? file.capabilities?.trash ?? false,
    },
    sendAllowlist: (file.sendAllowlist ?? []).map((entry) => entry.toLowerCase()),
    attachmentsDir: env.INBOXMUX_ATTACHMENTS_DIR || file.attachmentsDir || join(homedir(), 'Downloads', 'inboxmux'),
  }
}
