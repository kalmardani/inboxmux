import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { tempDir } from './helpers.js'

describe('loadConfig', () => {
  it('turns sending and trash on by default and attaches from the home folder', () => {
    const config = loadConfig({ INBOXMUX_HOME: tempDir() })
    expect(config.capabilities).toEqual({ send: true, trash: true })
    expect(config.attachmentSources).toEqual([homedir()])
    expect(config.sendAllowlist).toEqual([])
  })

  it('lets the file and the environment switch capabilities off', () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ capabilities: { send: false }, attachmentSources: ['~/Documents', '/Volumes/Data'], sendAllowlist: ['@Corp.com'] }),
    )
    const fromFile = loadConfig({ INBOXMUX_HOME: dir })
    expect(fromFile.capabilities).toEqual({ send: false, trash: true })
    expect(fromFile.attachmentSources).toEqual([join(homedir(), 'Documents'), '/Volumes/Data'])
    expect(fromFile.sendAllowlist).toEqual(['@corp.com'])
    expect(loadConfig({ INBOXMUX_HOME: dir, INBOXMUX_ALLOW_SEND: 'true' }).capabilities.send).toBe(true)
    expect(loadConfig({ INBOXMUX_HOME: dir, INBOXMUX_ALLOW_TRASH: '0' }).capabilities.trash).toBe(false)
    expect(loadConfig({ INBOXMUX_HOME: dir, INBOXMUX_ALLOW_TRASH: 'off' }).capabilities.trash).toBe(false)
  })

  it('rejects unknown keys', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ capabilities: { sendd: true } }))
    expect(() => loadConfig({ INBOXMUX_HOME: dir })).toThrow(/invalid/)
  })
})
