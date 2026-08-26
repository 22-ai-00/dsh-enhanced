import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import * as lark from '../src/index.ts'

interface PolicyRuleShape {
  id: string
  effect: 'allow' | 'deny'
  subject: { kind: string; id: string; workspace: string }
  actions: string[]
  resource: { kind: string; id: string }
  context: { initiators: string[] }
}

// Mirrors `deniedExternalTools` in src/setup-profile.ts, which is intentionally
// empty: the grant denies nothing at the Policy layer. Kept as an explicit
// literal so re-introducing a denial has to be a deliberate test change.
const EXPECTED_DENIED_TOOLS: readonly string[] = []

// Ids emitted by earlier releases, as either allow or deny. Upgrading must drop
// all of them: a stale deny would keep overriding the wildcard.
const RETIRED_TOOL_IDS = [
  'bash', 'pwsh', 'read', 'glob', 'grep', 'skill',
  'memory_search', 'wiki_search', 'wiki_read',
  'memory_manage', 'wiki_upsert', 'wiki_lint',
  'automation_create', 'automation_manage', 'automation_run',
  'evolution_propose', 'knowledge_pin', 'knowledge_promote',
  'heartbeat_scratch_update',
] as const

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
    expect(toolRules.filter((rule: { effect: string }) => rule.effect === 'allow'))
      .toEqual([expect.objectContaining({
        id: 'lark-owner-tool-*-primary',
        effect: 'allow',
        resource: { kind: 'tool', id: '*' },
      })])
    expect(toolRules.filter((rule: { effect: string }) => rule.effect === 'deny')
      .map((rule: { resource: { id: string } }) => rule.resource.id))
      .toEqual(EXPECTED_DENIED_TOOLS)
    expect(toolRules).toEqual(toolRules.map((rule: object) => expect.objectContaining({
      ...rule,
      subject: { kind: 'agent', id: 'standard', workspace: '/Users/test/.dsh/assistant-workspace' },
      actions: ['execute'],
      context: { initiators: ['external'] },
    })))
    // The subject stays exact; only the tool id may be a pattern.
    expect(toolRules.some((rule: { subject: { id: string; workspace: string } }) =>
      rule.subject.id === '*' || rule.subject.workspace.includes('*'))).toBe(false)
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
    for (const tool of ['*', ...EXPECTED_DENIED_TOOLS]) {
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
    expect(legacyTools).toHaveLength(1 + EXPECTED_DENIED_TOOLS.length)
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
    // The grant is one platform-agnostic wildcard, so no per-shell rule exists.
    expect(rules.find((rule: { id: string }) => rule.id === 'lark-owner-tool-*-primary'))
      .toMatchObject({ effect: 'allow', resource: { kind: 'tool', id: '*' } })
    for (const shell of ['bash', 'pwsh']) {
      expect(rules.some((rule: { id: string }) => rule.id === `lark-owner-tool-${shell}-primary`)).toBe(false)
    }
    expect(output).not.toContain('client_secret')
  })

  test('rebuilds managed tool rules across a platform change without leaving stale per-tool rules', () => {
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

    // Replatforming rebuilds the grant; the wildcard carries every tool, so no
    // per-shell or per-tool allow rule may survive the rewrite.
    expect(windows).toContain('lark-owner-tool-*-primary')
    for (const stale of ['bash', 'pwsh', 'skill', 'read', 'glob', 'grep', 'memory_search']) {
      expect(windows).not.toContain(`lark-owner-tool-${stale}-primary`)
    }
    const rules = (parse(windows) as { id: string; config: { assistantPolicy: { rules: {
      id: string
      effect: string
    }[] } } }[])
      .find(row => row.id === 'dsh-enhanced-personal-assistant')!
      .config.assistantPolicy.rules
      .filter(rule => rule.id.startsWith('lark-owner-tool-'))
    // The DSH home changes with the platform, so the previous absolute workspace
    // becomes a legacy identity and keeps its own wildcard plus denials.
    const allow = rules.filter(rule => rule.effect === 'allow')
    expect(allow).toHaveLength(2)
    expect(allow.filter(rule => rule.id === 'lark-owner-tool-*-primary')).toHaveLength(1)
    expect(allow.filter(rule => rule.id.startsWith('lark-owner-tool-*-primary-legacy-'))).toHaveLength(1)
    expect(rules.filter(rule => rule.effect === 'deny'))
      .toHaveLength(EXPECTED_DENIED_TOOLS.length * 2)
  })

  test('retires per-tool allow and deny rules left by earlier releases on upgrade', () => {
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
    // Stand in for a profile written by an earlier release: rename the wildcard
    // rule into the per-tool ids those versions emitted, then upgrade. Half are
    // given effect deny to reproduce the denylist release, whose leftovers would
    // otherwise keep overriding the wildcard.
    const enabled = configure({ ...common, agentTools: 'enable' })
    const wildcardLine = enabled.split('\n')
      .find(line => line.includes('- id: lark-owner-tool-*-primary') && !line.includes('legacy'))
    expect(wildcardLine).toBeDefined()
    const block = enabled.slice(enabled.indexOf(wildcardLine!))
    const wildcardRule = block.slice(0, block.indexOf('\n        - id: ', wildcardLine!.length))
    const legacyPatch = enabled.replace(
      wildcardRule,
      RETIRED_TOOL_IDS.map((tool, index) => {
        const renamed = wildcardRule
          .replace('lark-owner-tool-*-primary', `lark-owner-tool-${tool}-primary`)
          .replace(/(\n\s+kind: tool\n\s+id: )'?\*'?/, `$1${tool}`)
        return index % 2 === 0 ? renamed : renamed.replace('effect: allow', 'effect: deny')
      }).join('\n'),
    )
    expect(legacyPatch).toContain('lark-owner-tool-bash-primary')
    expect(legacyPatch).toContain('lark-owner-tool-memory_manage-primary')
    expect(legacyPatch).toContain('effect: deny')

    const upgraded = configure({ ...common, profilePatch: legacyPatch, agentTools: 'enable' })
    for (const retired of RETIRED_TOOL_IDS) {
      expect(upgraded).not.toContain(`lark-owner-tool-${retired}-primary`)
    }
    // Only the wildcard survives, and it carries no residual denial.
    const survivingTools = (parse(upgraded) as { id: string; config: { assistantPolicy: { rules: PolicyRuleShape[] } } }[])
      .find(row => row.id === 'dsh-enhanced-personal-assistant')!
      .config.assistantPolicy.rules
      .filter(rule => rule.id.startsWith('lark-owner-tool-'))
    expect(survivingTools.map(rule => rule.resource.id)).toEqual(['*'])
    expect(survivingTools.every(rule => rule.effect === 'allow')).toBe(true)

    // The upgrade must stay fully revocable.
    const disabled = configure({ ...common, profilePatch: upgraded, agentTools: 'disable' })
    expect(disabled).not.toContain('lark-owner-tool-')
  })

  test('resolves every preset tool through the wildcard while denying durable mutators', () => {
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
    const rules = (parse(enabled) as { id: string; config: { assistantPolicy: { rules: PolicyRuleShape[] } } }[])
      .find(row => row.id === 'dsh-enhanced-personal-assistant')!
      .config.assistantPolicy.rules

    const wildcard = rules.find(item => item.id === 'lark-owner-tool-*-primary')
    expect(wildcard).toMatchObject({
      effect: 'allow',
      subject: { kind: 'agent', id: 'standard', workspace: '/Users/test/.dsh/assistant-workspace' },
      actions: ['execute'],
      resource: { kind: 'tool', id: '*' },
      context: { initiators: ['external'] },
    })

    // Resolve a tool the way AssistantPolicy does, so this proves reachability
    // rather than restating the emitter's own shape. Deny wins over allow at any
    // specificity, and only the tool id is ever a pattern. Kept local because the
    // real evaluator is internal to assistant-policy and must not be imported
    // across package boundaries.
    const toolRules = rules.filter(item => item.resource.kind === 'tool')
    const decide = (tool: string): 'allow' | 'deny' => {
      const matched = toolRules.filter(item =>
        item.subject.id === 'standard'
        && item.subject.workspace === '/Users/test/.dsh/assistant-workspace'
        && item.actions.includes('execute')
        && item.context.initiators.includes('external')
        && (item.resource.id === '*' || item.resource.id === tool))
      if (matched.some(item => item.effect === 'deny')) return 'deny'
      return matched.some(item => item.effect === 'allow') ? 'allow' : 'deny'
    }

    // Host tools, the skill loader, assistant retrieval, and a tool no release
    // of this package has ever heard of all resolve without a setup change.
    for (const tool of [
      'bash', 'pwsh', 'read', 'glob', 'grep', 'skill',
      'memory_search', 'wiki_search', 'wiki_read',
      'lark_doc_read', 'some_future_plugin_tool',
    ]) {
      expect(decide(tool)).toBe('allow')
    }
    // Nothing is denied at this layer, including the durable-state mutators.
    for (const tool of [
      'memory_manage', 'wiki_upsert', 'automation_run', 'evolution_propose',
      'knowledge_pin', 'heartbeat_scratch_update',
    ]) {
      expect(decide(tool)).toBe('allow')
    }
    expect(toolRules.filter(item => item.effect === 'deny')).toEqual([])

    const disabled = configure({ ...common, profilePatch: enabled, agentTools: 'disable' })
    expect(disabled).not.toContain('lark-owner-tool-')
  })
})
