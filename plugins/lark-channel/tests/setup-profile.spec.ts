import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import * as lark from '../src/index.ts'

const fixture = `
- id: dsh-enhanced-personal-assistant
  config:
    assistantPolicy:
      databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')
      rules:
        - id: keep-user-rule
          effect: allow
          subject: { kind: agent, id: primary, workspace: "*" }
          actions: [read]
          resource: { kind: memory, id: "*" }
          context: { initiators: [foreground] }
      budgets: []
    personalMemory: { databasePath: /tmp/memory.sqlite }
    personalWiki: { vaultRoot: /tmp/wiki, databasePath: /tmp/wiki.sqlite }
    assistantAutomations: { databasePath: /tmp/automations.sqlite, runsPath: /tmp/runs }
`

describe('Lark Web-profile onboarding patch', () => {
  test('preserves existing policy while adding exact owner, credential, and enabled-channel config', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch
    expect(configure).toBeTypeOf('function')

    const output = (configure as (input: unknown) => string)({
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_owner',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
    })

    expect(output).toContain('keep-user-rule')
    expect(output).toContain('lark-owner-ingress-primary')
    expect(output).toContain('lark-channel-credential-primary')
    expect(output).toContain('lark-owner-reply-primary')
    expect(output).toContain('enabled: true')
    expect(output).not.toMatch(/appSecret|secretValue|ou_other/)

    const rows = parse(output, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
    const credentials = rows.find((row: { id: string }) => row.id === 'dsh-enhanced-credentials-keychain')
    expect(credentials.config.handles).toEqual([expect.objectContaining({
      id: 'lark-app-secret-primary',
      provider: 'macos-keychain',
      service: 'dsh/lark/web/primary',
      account: 'primary',
      consumers: ['dsh-enhanced-lark-channel'],
      purposes: ['connect'],
    })])
    const channel = rows.find((row: { id: string }) => row.id === 'dsh-enhanced-lark-channel')
    expect(channel.config).toMatchObject({
      enabled: true,
      account: 'primary',
      tenant: 'personal',
      appId: 'cli_0123456789abcdef',
      credentialHandle: 'lark-app-secret-primary',
      showProgress: true,
      statusReactions: true,
    })
  })

  test('is idempotent when the wizard is run again for the same account', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const input = {
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_owner',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
    }
    const once = configure(input)
    const twice = configure({ ...input, profilePatch: once })

    expect(twice).toBe(once)
  })

  test('writes the native Linux Secret Service locator selected by onboarding', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const output = configure({
      profilePatch: fixture,
      dshHome: '/home/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_owner',
      credentialProvider: 'linux-secret-service',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
    })

    const rows = parse(output, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
    const credentials = rows.find((row: { id: string }) => row.id === 'dsh-enhanced-credentials-keychain')
    expect(credentials.config.handles).toEqual([expect.objectContaining({
      provider: 'linux-secret-service',
      service: 'dsh/lark/web/primary',
      account: 'primary',
    })])
  })

  test('writes only a DPAPI encrypted-file locator for Windows onboarding', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const credentialPath = 'C:\\Users\\test\\.dsh\\credentials-keychain\\lark-primary.clixml'
    const output = configure({
      profilePatch: fixture,
      dshHome: 'C:\\Users\\test\\.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_owner',
      credentialProvider: 'windows-dpapi',
      credentialPath,
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
    })

    const rows = parse(output, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
    const credentials = rows.find((row: { id: string }) => row.id === 'dsh-enhanced-credentials-keychain')
    expect(credentials.config.handles).toEqual([expect.objectContaining({
      provider: 'windows-dpapi',
      path: credentialPath,
    })])
    expect(output).not.toContain('client_secret')
  })
})
