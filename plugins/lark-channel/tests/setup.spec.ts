import { describe, expect, test } from 'vitest'
import { mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as lark from '../src/index.ts'

const directMessage = {
  messageId: 'om_1',
  chatId: 'oc_1',
  chatType: 'p2p' as const,
  senderId: 'ou_owner',
  content: 'DSH-CONNECT-A1B2C3D4',
  rawContentType: 'text',
  resources: [],
  mentionAll: false,
  mentionedBot: false,
  createTime: Date.now(),
}

describe('Lark onboarding wizard inputs', () => {
  test('recognizes only the exact one-time phrase from a direct message', () => {
    const match = (lark as Record<string, unknown>).matchOwnerHandshake
    expect(match).toBeTypeOf('function')
    const identify = match as (input: unknown) => unknown

    expect(identify({ message: directMessage, phrase: 'DSH-CONNECT-A1B2C3D4', account: 'primary', tenant: 'personal' }))
      .toEqual({ channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_owner' })
    expect(identify({ message: { ...directMessage, chatType: 'group' }, phrase: directMessage.content,
      account: 'primary', tenant: 'personal' })).toBeUndefined()
    expect(identify({ message: directMessage, phrase: 'DSH-CONNECT-WRONG000',
      account: 'primary', tenant: 'personal' })).toBeUndefined()
  })

  test('parses a profile and domain without accepting secret arguments', () => {
    const parseArgs = (lark as Record<string, unknown>).parseLarkSetupArgs
    expect(parseArgs).toBeTypeOf('function')
    const parse = parseArgs as (argv: string[]) => unknown

    expect(parse(['--profile', 'web', '--domain', 'feishu'])).toMatchObject({ profile: 'web', domain: 'feishu' })
    expect(parse([])).toMatchObject({ agentTools: 'preserve' })
    expect(parse(['--allow-agent-tools'])).toMatchObject({ agentTools: 'enable' })
    expect(parse(['--disable-agent-tools'])).toMatchObject({ agentTools: 'disable' })
    expect(() => parse(['--allow-agent-tools', '--disable-agent-tools'])).toThrow(/mutually exclusive/i)
    expect(parse(['--create-app', '--app-name', 'My DSH'])).toMatchObject({
      createApp: true,
      appName: 'My DSH',
      manageService: true,
    })
    expect(parse(['--profile', 'web', '--install-service'])).toMatchObject({
      profile: 'web',
      installServiceOnly: true,
      manageService: true,
    })
    expect(parse(['--no-service'])).toMatchObject({ manageService: false })
    expect(() => parse(['--install-service', '--no-service'])).toThrow(/install-service.*no-service/i)
    expect(() => parse(['--install-service', '--allow-agent-tools'])).toThrow(/install-service.*agent-tools/i)
    expect(parse(['--create-app', '--app-id', 'cli_0123456789abcdef'])).toMatchObject({
      createApp: true,
      appId: 'cli_0123456789abcdef',
    })
    expect(() => parse(['--app-secret', 'do-not-accept'])).toThrow(/secret.*not accepted/i)
  })

  test('offers existing or new applications with a minimal official template', () => {
    const registrationOptions = (lark as Record<string, unknown>).createLarkRegistrationOptions
    expect(registrationOptions).toBeTypeOf('function')

    const options = (registrationOptions as (input: unknown) => Record<string, unknown>)({
      domain: 'feishu',
      appName: 'DSH Personal Assistant',
      signal: new AbortController().signal,
      onQRCodeReady() {},
      onStatusChange() {},
    })
    expect(options).not.toHaveProperty('createOnly')
    expect(options).toMatchObject({
      domain: 'accounts.feishu.cn',
      larkDomain: 'accounts.larksuite.com',
      source: 'dsh-enhanced/lark-channel',
      appPreset: {
        name: 'DSH Personal Assistant',
      },
      addons: {
        preset: false,
        scopes: { tenant: [
          'application:bot.basic_info:read',
          'im:message.group_at_msg:readonly',
          'im:message.p2p_msg:readonly',
          'im:message.reactions:write_only',
          'im:message:send_as_bot',
        ] },
        events: { items: { tenant: ['im.message.receive_v1'] } },
        callbacks: { items: ['card.action.trigger'] },
      },
    })

    const update = (registrationOptions as (input: unknown) => Record<string, unknown>)({
      domain: 'feishu',
      appName: 'DSH Personal Assistant',
      appId: 'cli_0123456789abcdef',
      signal: new AbortController().signal,
      onQRCodeReady() {},
      onStatusChange() {},
    })
    expect(update).toMatchObject({ appId: 'cli_0123456789abcdef' })
    expect(update).not.toHaveProperty('createOnly')
  })

  test('keeps an automatically received secret out of Keychain process arguments', () => {
    const writeRequest = (lark as Record<string, unknown>).createKeychainWriteRequest
    expect(writeRequest).toBeTypeOf('function')
    const secret = 'generated-secret-value'
    const request = (writeRequest as (service: string, account: string, secret: string) => {
      args: string[]
      input: Buffer
    })('dsh/lark/web/primary', 'primary', secret)

    expect(request.args).toEqual(['-i'])
    expect(request.args.join(' ')).not.toContain(secret)
    expect(request.input.toString('utf8')).not.toContain(secret)
    expect(request.input.toString('utf8')).toContain(Buffer.from(secret, 'utf8').toString('hex'))
  })

  test('passes Linux Secret Service and Windows DPAPI values only through stdin', () => {
    const linuxRequest = (lark as Record<string, unknown>).createSecretServiceWriteRequest
    const windowsRequest = (lark as Record<string, unknown>).createWindowsDpapiWriteRequest
    expect(linuxRequest).toBeTypeOf('function')
    expect(windowsRequest).toBeTypeOf('function')
    const secret = 'generated-secret-value'

    const linux = (linuxRequest as (service: string, account: string, secret: string) => {
      executable: string; args: string[]; input: Buffer
    })('dsh/lark/web/primary', 'primary', secret)
    expect(linux.executable).toBe('/usr/bin/secret-tool')
    expect(linux.args).toEqual([
      'store', '--label=DSH Lark web/primary', 'service', 'dsh/lark/web/primary', 'account', 'primary',
    ])
    expect(linux.args.join(' ')).not.toContain(secret)
    expect(linux.input.toString('utf8')).toBe(secret)

    const windows = (windowsRequest as (path: string, secret: string) => {
      executable: string; args: string[]; input: Buffer
    })('C:\\Users\\test\\.dsh\\credentials-keychain\\lark-primary.clixml', secret)
    expect(windows.executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(windows.args.join(' ')).not.toContain(secret)
    expect(windows.input.toString('utf8')).toBe(secret)
  })

  test('recognizes a package-bin symlink as the main CLI entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-setup-entry-'))
    const target = join(root, 'setup.js')
    const executable = join(root, 'dsh-lark-setup')
    await writeFile(target, '#!/usr/bin/env node\n')
    await symlink(target, executable)
    const isMainEntry = (lark as Record<string, unknown>).isMainEntry

    expect(isMainEntry).toBeTypeOf('function')
    expect((isMainEntry as (moduleUrl: string, argvPath: string) => boolean)(pathToFileURL(target).href, executable)).toBe(true)
  })
})
