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
- id: dsh-enhanced-assistant-delivery
  config:
    defaultWorkspace: !!js dshHomePath('assistant-workspace')
    defaultAgentPreset: standard
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
      agentTools: 'enable',
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
      imageDownloadTimeoutMs: 30_000,
    })
    const rules = rows.find((row: { id: string }) => row.id === 'dsh-enhanced-personal-assistant')
      .config.assistantPolicy.rules
    expect(rules.find((rule: { id: string }) => rule.id === 'lark-owner-reply-primary')).toMatchObject({
      subject: { kind: 'agent', id: 'standard', workspace: '/Users/test/.dsh/assistant-workspace' },
      actions: ['reply'],
      resource: { kind: 'message', id: '*' },
      context: { initiators: ['external'] },
    })
    const toolRules = rules.filter((rule: { id: string }) => rule.id.startsWith('lark-owner-tool-'))
    expect(toolRules.map((rule: { resource: { id: string } }) => rule.resource.id)).toEqual([
      'bash', 'read', 'glob', 'grep', 'skill', 'memory_search', 'wiki_search', 'wiki_read',
    ])
    expect(toolRules).toEqual(toolRules.map((rule: object) => expect.objectContaining({
      ...rule,
      subject: { kind: 'agent', id: 'standard', workspace: '/Users/test/.dsh/assistant-workspace' },
      actions: ['execute'],
      context: { initiators: ['external'] },
    })))
    expect(toolRules.some((rule: { subject: { id: string }; resource: { id: string } }) =>
      rule.subject.id === '*' || rule.resource.id === '*')).toBe(false)
    const approvalRules = rules.filter((rule: { id: string }) => rule.id.startsWith('lark-owner-approval-'))
    expect(approvalRules).toHaveLength(4)
    expect(approvalRules.map((rule: { subject: { id: string } }) => rule.subject.id).sort()).toEqual([
      'dsh-enhanced-assistant-evolution',
      'dsh-enhanced-assistant-automations',
      'dsh-enhanced-personal-memory',
      'dsh-enhanced-personal-wiki',
    ].sort())
    expect(approvalRules).toEqual(approvalRules.map((rule: object) => expect.objectContaining({
      ...rule,
      subject: expect.objectContaining({
        kind: 'background',
        workspace: '/Users/test/.dsh/assistant-workspace',
        principal: 'lark/primary/personal/ou_owner',
      }),
      actions: ['approval.send'],
      context: { initiators: ['background'] },
    })))
  })

  test('keeps exact primary rules when upgrading an existing binding to a standard default', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const legacyFixture = fixture.replace('      budgets: []', `
        - id: lark-owner-reply-primary
          effect: allow
          subject: { kind: agent, id: primary, workspace: /Users/test/.dsh/assistant-workspace }
          actions: [reply]
          resource: { kind: message, id: "*" }
          context: { initiators: [external] }
      budgets: []`)
    const input = {
      profilePatch: legacyFixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_owner',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
    }
    const preserved = configure(input)
    const output = configure({ ...input, profilePatch: preserved, agentTools: 'enable' })
    const rows = parse(output, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
    const rules = rows.find((row: { id: string }) => row.id === 'dsh-enhanced-personal-assistant')
      .config.assistantPolicy.rules

    expect(rules.find((rule: { id: string }) => rule.id === 'lark-owner-reply-primary'))
      .toMatchObject({ subject: { id: 'standard' } })
    expect(rules.find((rule: { id: string }) => rule.id.startsWith('lark-owner-reply-primary-legacy-primary-')))
      .toMatchObject({ subject: { id: 'primary' }, actions: ['reply'] })
    for (const tool of ['bash', 'read', 'glob', 'grep', 'skill', 'memory_search', 'wiki_search', 'wiki_read']) {
      expect(rules.find((rule: { id: string }) =>
        rule.id.startsWith(`lark-owner-tool-${tool}-primary-legacy-primary-`)))
        .toMatchObject({ subject: { id: 'primary' }, resource: { kind: 'tool', id: tool } })
    }
  })

  test('preserves the complete preset and workspace identity of legacy bindings', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const oldWorkspace = '/Users/test/.dsh/old-assistant-workspace'
    const legacyFixture = fixture.replace('      budgets: []', `
        - id: lark-owner-reply-primary
          effect: allow
          subject: { kind: agent, id: standard, workspace: ${oldWorkspace} }
          actions: [reply]
          resource: { kind: message, id: "*" }
          context: { initiators: [external] }
      budgets: []`)
    const output = configure({
      profilePatch: legacyFixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_owner',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
      agentTools: 'enable',
    })
    const rows = parse(output, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
    const rules = rows.find((row: { id: string }) => row.id === 'dsh-enhanced-personal-assistant')
      .config.assistantPolicy.rules
    const legacyReplies = rules.filter((rule: { id: string }) =>
      rule.id.startsWith('lark-owner-reply-primary-legacy-standard-'))
    const legacyTools = rules.filter((rule: { id: string }) =>
      rule.id.startsWith('lark-owner-tool-') && rule.id.includes('-primary-legacy-standard-'))

    expect(legacyReplies).toHaveLength(1)
    expect(legacyReplies[0]).toMatchObject({
      subject: { kind: 'agent', id: 'standard', workspace: oldWorkspace },
      actions: ['reply'],
    })
    expect(legacyTools).toHaveLength(8)
    expect(legacyTools.every((rule: { subject: { workspace: string } }) =>
      rule.subject.workspace === oldWorkspace)).toBe(true)
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
      agentTools: 'enable',
    }
    const once = configure(input)
    const twice = configure({ ...input, profilePatch: once })

    expect(twice).toBe(once)
  })

  test('uses component-safe principal encoding for owner and approval rules', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const output = configure({
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou/owner',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
    })
    expect(output).toContain('lark/primary/personal/ou%2Fowner')
    expect(output).not.toContain('principal: lark/primary/personal/ou/owner')
  })

  test('preserves managed Agent tool rules by default and removes them only when explicitly disabled', () => {
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
    const untouched = configure(input)
    expect(untouched).not.toContain('lark-owner-tool-')

    const enabled = configure({ ...input, agentTools: 'enable' })
    expect(configure({ ...input, profilePatch: enabled })).toBe(enabled)

    const disabled = configure({ ...input, profilePatch: enabled, agentTools: 'disable' })
    expect(disabled).not.toContain('lark-owner-tool-')
    expect(disabled).toContain('keep-user-rule')
    expect(configure({ ...input, profilePatch: disabled, agentTools: 'disable' })).toBe(disabled)
  })

  test('scopes reply and tool rules to the Delivery-configured workspace', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const output = configure({
      profilePatch: fixture.replace(
        "!!js dshHomePath('assistant-workspace')",
        '/srv/dsh-owner-workspace',
      ),
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_owner',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
      agentTools: 'enable',
    })
    const rows = parse(output, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
    const rules = rows.find((row: { id: string }) => row.id === 'dsh-enhanced-personal-assistant')
      .config.assistantPolicy.rules

    expect(rules.filter((rule: { id: string }) => rule.id.startsWith('lark-owner-'))
      .every((rule: { subject?: { kind?: string; workspace?: string } }) =>
        rule.subject?.kind !== 'agent' || rule.subject.workspace === '/srv/dsh-owner-workspace')).toBe(true)
  })

  test('rejects wildcard workspaces instead of turning them into Policy patterns', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    expect(() => configure({
      profilePatch: fixture.replace(
        "!!js dshHomePath('assistant-workspace')",
        '/srv/*/assistant-workspace',
      ),
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_owner',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
      agentTools: 'enable',
    })).toThrow(/defaultWorkspace is invalid/u)
  })

  test('reserves the legacy rule-id segment so two account names cannot collide', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    expect(() => configure({
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary-legacy-standard',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_owner',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
      agentTools: 'enable',
    })).toThrow(/reserved "-legacy-" segment/u)
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
      agentTools: 'enable',
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
      agentTools: 'enable',
    })

    const rows = parse(output, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
    const credentials = rows.find((row: { id: string }) => row.id === 'dsh-enhanced-credentials-keychain')
    expect(credentials.config.handles).toEqual([expect.objectContaining({
      provider: 'windows-dpapi',
      path: credentialPath,
    })])
    const rules = rows.find((row: { id: string }) => row.id === 'dsh-enhanced-personal-assistant')
      .config.assistantPolicy.rules
    expect(rules.find((rule: { id: string }) => rule.id === 'lark-owner-tool-pwsh-primary'))
      .toMatchObject({ resource: { kind: 'tool', id: 'pwsh' } })
    expect(rules.some((rule: { id: string }) => rule.id === 'lark-owner-tool-bash-primary')).toBe(false)
    expect(output).not.toContain('client_secret')
  })

  test('rebuilds managed tools for the current platform without leaving Bash and Pwsh together', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const common = {
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_owner',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
      agentTools: 'enable',
    }
    const posix = configure(common)
    const windows = configure({
      ...common,
      profilePatch: posix,
      dshHome: 'C:\\Users\\test\\.dsh',
      credentialProvider: 'windows-dpapi',
      credentialPath: 'C:\\Users\\test\\.dsh\\credentials-keychain\\lark-primary.clixml',
    })

    expect(windows).toContain('lark-owner-tool-pwsh-primary')
    expect(windows).not.toContain('lark-owner-tool-bash-primary')
    expect(windows).toContain('lark-owner-tool-skill-primary')
  })

  test('authorizes read-only assistant retrieval but never its mutating counterparts', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const enabled = configure({
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu' as const,
      ownerUserId: 'ou_owner',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
      agentTools: 'enable',
    })
    const toolIds = (parse(enabled) as { id: string; config: { assistantPolicy: { rules: {
      id: string
      resource: { kind: string; id: string }
    }[] } } }[])
      .find(row => row.id === 'dsh-enhanced-personal-assistant')!
      .config.assistantPolicy.rules
      .filter(item => item.id.startsWith('lark-owner-tool-') && item.resource.kind === 'tool')
      .map(item => item.resource.id)

    expect(toolIds).toEqual(expect.arrayContaining(['memory_search', 'wiki_search', 'wiki_read']))
    for (const mutating of ['memory_manage', 'wiki_upsert', 'wiki_lint']) {
      expect(toolIds).not.toContain(mutating)
    }
  })

  test('authorizes the DSH skill tool so external turns can load skills', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const common = {
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu' as const,
      ownerUserId: 'ou_owner',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
    }

    const enabled = configure({ ...common, agentTools: 'enable' })
    const rule = (parse(enabled) as { id: string; config: { assistantPolicy: { rules: {
      id: string
      effect: string
      subject: { kind: string; id: string; workspace: string }
      actions: string[]
      resource: { kind: string; id: string }
      context: { initiators: string[] }
    }[] } } }[])
      .find(row => row.id === 'dsh-enhanced-personal-assistant')!
      .config.assistantPolicy.rules
      .find(item => item.id === 'lark-owner-tool-skill-primary')

    expect(rule).toMatchObject({
      effect: 'allow',
      subject: { kind: 'agent', id: 'standard', workspace: '/Users/test/.dsh/assistant-workspace' },
      actions: ['execute'],
      resource: { kind: 'tool', id: 'skill' },
      context: { initiators: ['external'] },
    })

    const disabled = configure({ ...common, profilePatch: enabled, agentTools: 'disable' })
    expect(disabled).not.toContain('lark-owner-tool-skill-primary')
  })
})
