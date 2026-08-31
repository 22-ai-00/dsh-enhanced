import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import * as lark from '../src/index.ts'

interface PolicyRuleShape {
  id: string
  effect: 'allow' | 'deny'
  subject: { kind: string; id: string; workspace: string; principal?: string }
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
  test('refreshes the foreground capability grant without requiring a configured Lark channel', () => {
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
    const enabled = refresh({
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      agentTools: 'enable',
    })
    const rows = parse(enabled, {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
    })
    const rules = rows.find((row: { id: string }) => row.id === 'dsh-enhanced-personal-assistant')
      .config.assistantPolicy.rules
    expect(rules.find((rule: { id: string }) => rule.id === 'dsh-enhanced-foreground-capability-*'))
      .toMatchObject({
        effect: 'allow',
        subject: { kind: 'agent', id: '*', workspace: '*' },
        actions: ['*'],
        resource: { kind: '*', id: '*' },
        context: { initiators: ['foreground'] },
      })
    expect(enabled).not.toContain('lark-owner-capability-')
    expect(refresh({ profilePatch: enabled, dshHome: '/Users/test/.dsh', agentTools: 'enable' }))
      .toBe(enabled)

    const disabled = refresh({
      profilePatch: enabled,
      dshHome: '/Users/test/.dsh',
      agentTools: 'disable',
    })
    expect(disabled).not.toContain('dsh-enhanced-foreground-capability-')
    expect(disabled).toContain('keep-user-rule')
  })

  test('refreshes only managed Agent capability rules from the existing channel binding', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
    expect(refresh).toBeTypeOf('function')
    const configured = configure({
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_owner',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
    })
    const before = parse(configured, {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
    })

    const enabled = refresh({
      profilePatch: configured,
      dshHome: '/Users/test/.dsh',
      agentTools: 'enable',
    })
    const after = parse(enabled, {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
    })
    const beforeChannel = before.find((row: { id: string }) => row.id === 'dsh-enhanced-lark-channel')
    const afterChannel = after.find((row: { id: string }) => row.id === 'dsh-enhanced-lark-channel')
    const beforeCredentials = before.find((row: { id: string }) => row.id === 'dsh-enhanced-credentials-keychain')
    const afterCredentials = after.find((row: { id: string }) => row.id === 'dsh-enhanced-credentials-keychain')
    expect(afterChannel).toEqual(beforeChannel)
    expect(afterCredentials).toEqual(beforeCredentials)

    const rules = after.find((row: { id: string }) => row.id === 'dsh-enhanced-personal-assistant')
      .config.assistantPolicy.rules
    expect(rules.find((rule: { id: string }) => rule.id === 'dsh-enhanced-foreground-capability-*'))
      .toBeDefined()
    expect(rules.find((rule: { id: string }) => rule.id === 'lark-owner-capability-*-secondary'))
      .toMatchObject({ subject: { id: 'standard', workspace: '/Users/test/.dsh/assistant-workspace' } })
    expect(rules.find((rule: { id: string }) => rule.id === 'lark-owner-tool-*-secondary'))
      .toBeDefined()
    expect(refresh({ profilePatch: enabled, dshHome: '/Users/test/.dsh', agentTools: 'enable' }))
      .toBe(enabled)

    expect(() => refresh({
      profilePatch: configured,
      dshHome: '/Users/test/.dsh',
      account: 'primary',
      agentTools: 'enable',
    })).toThrow(/configured account.*secondary/i)

    const disabled = refresh({
      profilePatch: enabled,
      dshHome: '/Users/test/.dsh',
      agentTools: 'disable',
    })
    expect(disabled).not.toContain('dsh-enhanced-foreground-capability-')
    expect(disabled).not.toContain('lark-foreground-capability-')
    expect(disabled).not.toContain('lark-owner-capability-')
    expect(disabled).not.toContain('lark-owner-tool-')
    expect(disabled).toContain('lark-owner-reply-secondary')
    expect(disabled).toContain('lark-owner-preference-signal-secondary')
    expect(disabled).toContain('lark-owner-preference-snapshot-secondary')

    const channelDisabled = enabled.replace(
      /(id: dsh-enhanced-lark-channel[\s\S]*?\n\s+enabled:) true/u,
      '$1 false',
    )
    expect(channelDisabled).not.toBe(enabled)
    const disabledChannelRefresh = refresh({
      profilePatch: channelDisabled,
      dshHome: '/Users/test/.dsh',
      agentTools: 'disable',
    })
    expect(disabledChannelRefresh).not.toContain('lark-owner-capability-')
    expect(disabledChannelRefresh).not.toContain('lark-owner-tool-')
    expect(disabledChannelRefresh).not.toContain('lark-owner-reply-')
    expect(disabledChannelRefresh).not.toContain('lark-owner-preference-signal-')
    expect(disabledChannelRefresh).not.toContain('lark-owner-preference-snapshot-')
  })

  test('always grants only the two bounded preference-learning capabilities to the authenticated owner', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
    const input = {
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_owner',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
    }
    const configured = configure(input)
    const rows = parse(configured, {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
    })
    const rules = rows.find((row: { id: string }) => row.id === 'dsh-enhanced-personal-assistant')
      .config.assistantPolicy.rules as PolicyRuleShape[]

    expect(rules.find(rule => rule.id === 'lark-owner-preference-signal-secondary')).toEqual({
      id: 'lark-owner-preference-signal-secondary',
      effect: 'allow',
      subject: {
        kind: 'external',
        id: 'lark/secondary/personal/ou_owner',
        workspace: '/Users/test/.dsh/assistant-workspace',
      },
      actions: ['signal'],
      resource: { kind: 'preference', id: 'standard/*' },
      context: { initiators: ['external'] },
    })
    expect(rules.find(rule => rule.id === 'lark-owner-preference-snapshot-secondary')).toEqual({
      id: 'lark-owner-preference-snapshot-secondary',
      effect: 'allow',
      subject: {
        kind: 'agent',
        id: 'standard',
        workspace: '/Users/test/.dsh/assistant-workspace',
        principal: 'lark/secondary/personal/ou_owner',
      },
      actions: ['snapshot'],
      resource: { kind: 'preference', id: 'active' },
      context: { initiators: ['external'] },
    })
    expect(configured).not.toContain('lark-owner-capability-')
    expect(configured).not.toContain('lark-owner-tool-')

    // The narrow adaptation grants survive an explicit broad-tool disable and
    // every refresh remains byte-stable.
    const disabled = refresh({
      profilePatch: configured,
      dshHome: input.dshHome,
      agentTools: 'disable',
    })
    expect(disabled).toContain('lark-owner-preference-signal-secondary')
    expect(disabled).toContain('lark-owner-preference-snapshot-secondary')
    expect(disabled).not.toContain('lark-owner-capability-')
    expect(disabled).not.toContain('lark-owner-tool-')
    expect(refresh({
      profilePatch: disabled,
      dshHome: input.dshHome,
      agentTools: 'disable',
    })).toBe(disabled)
  })

  test('refresh sweeps setup-managed external rules for every retired account id', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
    const configured = configure({
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_owner',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
    })
    const polluted = configured.replace('      budgets: []', `
        - id: lark-owner-reply-retired
          effect: allow
          subject: { kind: agent, id: standard, workspace: /Users/test/.dsh/assistant-workspace }
          actions: [reply]
          resource: { kind: message, id: "*" }
          context: { initiators: [external] }
        - id: lark-owner-capability-*-retired
          effect: allow
          subject: { kind: agent, id: standard, workspace: /Users/test/.dsh/assistant-workspace }
          actions: ["*"]
          resource: { kind: "*", id: "*" }
          context: { initiators: [external] }
        - id: lark-owner-tool-*-retired
          effect: allow
          subject: { kind: agent, id: standard, workspace: /Users/test/.dsh/assistant-workspace }
          actions: [execute]
          resource: { kind: tool, id: "*" }
          context: { initiators: [external] }
        - id: lark-owner-preference-signal-retired
          effect: allow
          subject:
            kind: external
            id: lark/retired/personal/ou_retired
            workspace: /Users/test/.dsh/assistant-workspace
          actions: [signal]
          resource: { kind: preference, id: "standard/*" }
          context: { initiators: [external] }
        - id: lark-owner-preference-snapshot-retired
          effect: allow
          subject:
            kind: agent
            id: standard
            workspace: /Users/test/.dsh/assistant-workspace
            principal: lark/retired/personal/ou_retired
          actions: [snapshot]
          resource: { kind: preference, id: active }
          context: { initiators: [external] }
      budgets: []`)
    expect(polluted).toContain('lark-owner-tool-*-retired')

    const enabled = refresh({
      profilePatch: polluted,
      dshHome: '/Users/test/.dsh',
      agentTools: 'enable',
    })
    expect(enabled).not.toContain('lark-owner-reply-retired')
    expect(enabled).not.toContain('lark-owner-capability-*-retired')
    expect(enabled).not.toContain('lark-owner-tool-*-retired')
    expect(enabled).not.toContain('lark-owner-preference-signal-retired')
    expect(enabled).not.toContain('lark-owner-preference-snapshot-retired')
    expect(enabled).toContain('lark-owner-reply-secondary')
    expect(enabled).toContain('lark-owner-tool-*-secondary')

    const disabled = refresh({
      profilePatch: polluted,
      dshHome: '/Users/test/.dsh',
      agentTools: 'disable',
    })
    expect(disabled).not.toContain('lark-owner-reply-retired')
    expect(disabled).not.toContain('lark-owner-capability-*-retired')
    expect(disabled).not.toContain('lark-owner-tool-*-retired')
    expect(disabled).toContain('lark-owner-reply-secondary')
    expect(disabled).not.toContain('lark-owner-tool-*-secondary')

    const channelDisabled = polluted.replace(
      /(id: dsh-enhanced-lark-channel[\s\S]*?\n\s+enabled:) true/u,
      '$1 false',
    )
    const disabledChannel = refresh({
      profilePatch: channelDisabled,
      dshHome: '/Users/test/.dsh',
      agentTools: 'disable',
    })
    expect(disabledChannel).not.toContain('lark-owner-reply-')
    expect(disabledChannel).not.toContain('lark-owner-capability-')
    expect(disabledChannel).not.toContain('lark-owner-tool-')
  })

  test('removes stale managed account grants when Lark is reconfigured to another account', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const primary = configure({
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_primary',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
      agentTools: 'enable',
    })
    const secondary = configure({
      profilePatch: primary,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_fedcba9876543210',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_secondary',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
    })
    expect(secondary).not.toContain('lark-owner-capability-*-primary')
    expect(secondary).not.toContain('lark-owner-tool-*-primary')
    expect(secondary).not.toContain('lark-owner-ingress-primary')
    expect(secondary).not.toContain('lark-owner-reply-primary')
    expect(secondary).not.toContain('lark-owner-preference-signal-primary')
    expect(secondary).not.toContain('lark-owner-preference-snapshot-primary')
    expect(secondary).not.toContain('lark-owner-approval-dsh-enhanced-personal-memory-primary')
    expect(secondary).not.toContain('lark-channel-credential-primary')
    expect(secondary).not.toContain('id: lark-app-secret-primary')
    expect(secondary).toContain('lark-owner-capability-*-secondary')
    expect(secondary).toContain('lark-owner-tool-*-secondary')
    expect(secondary).toContain('lark-owner-preference-signal-secondary')
    expect(secondary).toContain('lark-owner-preference-snapshot-secondary')

    const disabled = configure({
      profilePatch: secondary,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_fedcba9876543210',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_secondary',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
      agentTools: 'disable',
    })
    expect(disabled).not.toContain('dsh-enhanced-foreground-capability-*')
    expect(disabled).not.toContain('lark-owner-capability-')
    expect(disabled).not.toContain('lark-owner-tool-')
  })

  test('sweeps every structurally managed retired fixed grant and credential handle', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
    const secondaryInput = {
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_secondary',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
    }
    const secondary = configure({ profilePatch: fixture, ...secondaryInput })
    const polluted = secondary
      .replace('      budgets: []', `
        - id: lark-channel-credential-primary
          effect: allow
          subject: { kind: background, id: dsh-enhanced-lark-channel }
          actions: [credential.use]
          resource: { kind: credential, id: lark-app-secret-primary }
          context: { initiators: [background] }
        - id: lark-owner-ingress-primary
          effect: allow
          subject: { kind: external, id: lark/primary/personal/ou_primary }
          actions: [approval.decide, ingest]
          resource: { kind: message, id: "*" }
          context: { initiators: [external] }
        - id: lark-owner-approval-dsh-enhanced-personal-memory-primary
          effect: allow
          subject:
            kind: background
            id: dsh-enhanced-personal-memory
            workspace: /Users/test/.dsh/assistant-workspace
            principal: lark/primary/personal/ou_primary
          actions: [approval.send]
          resource: { kind: message, id: "*" }
          context: { initiators: [background] }
        - id: custom-lark-channel-credential-user-defined
          effect: allow
          subject: { kind: background, id: local-user-plugin }
          actions: [read]
          resource: { kind: memory, id: private }
          context: { initiators: [foreground] }
        - id: custom-lark-owner-ingress-user-defined
          effect: deny
          subject: { kind: external, id: local:user-defined }
          actions: [send]
          resource: { kind: message, id: private }
          context: { initiators: [foreground] }
        - id: custom-lark-owner-approval-dsh-enhanced-personal-memory-user-defined
          effect: deny
          subject: { kind: background, id: local-user-plugin }
          actions: [read]
          resource: { kind: memory, id: private }
          context: { initiators: [foreground] }
      budgets: []`)
      .replace('    handles:\n', `    handles:
      - id: lark-app-secret-primary
        consumers: [dsh-enhanced-lark-channel]
        purposes: [connect]
        maxLeaseMs: 86400000
        provider: macos-keychain
        service: dsh/lark/web/primary
        account: primary
      - id: custom-lark-app-secret-user-defined
        consumers: [local-user-plugin]
        purposes: [read]
        maxLeaseMs: 1000
        provider: macos-keychain
        service: local/user/plugin
        account: user-defined
`)
    expect(polluted).toContain('lark-owner-ingress-primary')
    expect(polluted).toContain('id: lark-app-secret-primary')

    const assertRetiredSweep = (profilePatch: string, currentAccount: string): void => {
      expect(profilePatch).not.toContain('lark-channel-credential-primary')
      expect(profilePatch).not.toContain('lark-owner-ingress-primary')
      expect(profilePatch).not.toContain('lark-owner-approval-dsh-enhanced-personal-memory-primary')
      expect(profilePatch).not.toContain('id: lark-app-secret-primary')
      expect(profilePatch).toContain(`lark-channel-credential-${currentAccount}`)
      expect(profilePatch).toContain(`lark-owner-ingress-${currentAccount}`)
      expect(profilePatch).toContain(`id: lark-app-secret-${currentAccount}`)
      expect(profilePatch).toContain('custom-lark-channel-credential-user-defined')
      expect(profilePatch).toContain('custom-lark-owner-ingress-user-defined')
      expect(profilePatch).toContain('custom-lark-owner-approval-dsh-enhanced-personal-memory-user-defined')
      expect(profilePatch).toContain('id: custom-lark-app-secret-user-defined')
    }

    // Same-account setup and policy refresh used to leave every retired fixed
    // rule and handle untouched because there was no account transition.
    assertRetiredSweep(configure({ profilePatch: polluted, ...secondaryInput }), 'secondary')
    assertRetiredSweep(refresh({
      profilePatch: polluted,
      dshHome: secondaryInput.dshHome,
      agentTools: 'enable',
    }), 'secondary')

    // A later secondary -> tertiary migration must also remove primary debris;
    // cleaning only the immediately previous account is insufficient.
    const tertiary = configure({
      profilePatch: polluted,
      ...secondaryInput,
      appId: 'cli_fedcba9876543210',
      account: 'tertiary',
      ownerUserId: 'ou_tertiary',
      keychainService: 'dsh/lark/web/tertiary',
      keychainAccount: 'tertiary',
      agentTools: 'disable',
    })
    assertRetiredSweep(tertiary, 'tertiary')
    expect(tertiary).not.toContain('lark-channel-credential-secondary')
    expect(tertiary).not.toContain('lark-owner-ingress-secondary')
    expect(tertiary).not.toContain('id: lark-app-secret-secondary')
  })

  test('fails closed on dangerous ambiguous retired fixed grants and handles', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
    const common = {
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_secondary',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
    }
    const configured = configure({ profilePatch: fixture, ...common })
    const malformedRule = configured.replace('      budgets: []', `
        - id: lark-owner-ingress-primary
          effect: allow
          subject: { kind: external, id: lark/primary/personal/ou_primary }
          actions: [approval.decide, ingest]
          resource: { kind: message, id: "*" }
          context: { initiators: [external, foreground] }
      budgets: []`)
    const changedPlaneRule = configured.replace('      budgets: []', `
        - id: lark-owner-ingress-primary
          effect: allow
          subject: { kind: external, id: "*" }
          actions: [execute]
          resource: { kind: tool, id: "*" }
          context: { initiators: [external] }
      budgets: []`)
    const malformedHandle = configured.replace('    handles:\n', `    handles:
      - id: lark-app-secret-primary
        consumers: [dsh-enhanced-lark-channel, local-user-plugin]
        purposes: [connect]
        maxLeaseMs: 86400000
        provider: macos-keychain
        service: dsh/lark/web/primary
        account: primary
`)

    for (const profilePatch of [malformedRule, changedPlaneRule, malformedHandle]) {
      expect(() => configure({ profilePatch, ...common, agentTools: 'disable' }))
        .toThrow(/retired (?:fixed rule|credential handle).*ambiguous/iu)
      expect(() => refresh({
        profilePatch,
        dshHome: common.dshHome,
        agentTools: 'disable',
      })).toThrow(/retired (?:fixed rule|credential handle).*ambiguous/iu)
    }
  })

  test('fails closed when a current setup credential handle is shared or duplicated', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
    const common = {
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_secondary',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
    }
    const configured = configure({ profilePatch: fixture, ...common })
    const handlePattern = /(id: lark-app-secret-secondary\n\s+consumers:\n\s+- dsh-enhanced-lark-channel)/u
    const shared = configured.replace(handlePattern, '$1\n          - local-user-plugin')
    const duplicated = configured.replace(
      /(\s+- id: lark-app-secret-secondary[\s\S]*?\n\s+account: secondary)/u,
      '$1$1',
    )
    expect(shared).not.toBe(configured)
    expect(duplicated).not.toBe(configured)

    for (const [name, profilePatch] of Object.entries({ shared, duplicated })) {
      expect(() => configure({ profilePatch, ...common, agentTools: 'disable' }), name)
        .toThrow(/current credential handle lark-app-secret-secondary.*(?:ambiguous|duplicate)/iu)
      expect(() => refresh({
        profilePatch,
        dshHome: common.dshHome,
        agentTools: 'disable',
      }), name).toThrow(/current credential handle lark-app-secret-secondary.*(?:ambiguous|duplicate)/iu)
    }
  })

  test('fails closed on duplicate current setup-managed fixed rule ids', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
    const common = {
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_secondary',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
    }
    const configured = configure({ profilePatch: fixture, ...common })
    const duplicateRules = {
      ingress: `
        - id: lark-owner-ingress-secondary
          effect: allow
          subject: { kind: external, id: lark/secondary/personal/ou_attacker }
          actions: [approval.decide, ingest]
          resource: { kind: message, id: "*" }
          context: { initiators: [external] }`,
      credential: `
        - id: lark-channel-credential-secondary
          effect: allow
          subject: { kind: background, id: dsh-enhanced-lark-channel }
          actions: [credential.use]
          resource: { kind: credential, id: lark-app-secret-secondary }
          context: { initiators: [background] }`,
      approval: `
        - id: lark-owner-approval-dsh-enhanced-personal-memory-secondary
          effect: allow
          subject:
            kind: background
            id: dsh-enhanced-personal-memory
            workspace: /Users/test/.dsh/assistant-workspace
            principal: lark/secondary/personal/ou_attacker
          actions: [approval.send]
          resource: { kind: message, id: "*" }
          context: { initiators: [background] }`,
    }

    for (const [name, duplicate] of Object.entries(duplicateRules)) {
      const profilePatch = configured.replace('      budgets: []', `${duplicate}\n      budgets: []`)
      expect(profilePatch).not.toBe(configured)
      expect(() => configure({ profilePatch, ...common }), name)
        .toThrow(/duplicate managed fixed rule/iu)
      expect(() => refresh({
        profilePatch,
        dshHome: common.dshHome,
        agentTools: 'disable',
      }), name).toThrow(/duplicate managed fixed rule/iu)
    }
  })

  test('rejects shadowed or disabled managed Lark and credential profile rows', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
    const common = {
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_secondary',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
    }
    const configured = configure({ profilePatch: fixture, ...common })
    const annotate = (profilePatch: string, id: string, fields: string): string => profilePatch.replace(
      `- id: ${id}\n`,
      `- id: ${id}\n${fields}`,
    )
    const explicitlyActive = annotate(
      annotate(
        configured,
        'dsh-enhanced-lark-channel',
        "  name: '@dsh-enhanced/lark-channel'\n  disabled: false\n",
      ),
      'dsh-enhanced-credentials-keychain',
      "  name: '@dsh-enhanced/credentials-keychain'\n  disabled: false\n",
    )
    expect(() => configure({ profilePatch: explicitlyActive, ...common })).not.toThrow()

    const invalidRows = {
      larkName: annotate(
        configured,
        'dsh-enhanced-lark-channel',
        "  name: '@user/wrong-lark-package'\n",
      ),
      larkDisabled: annotate(configured, 'dsh-enhanced-lark-channel', '  disabled: true\n'),
      larkExpression: annotate(
        configured,
        'dsh-enhanced-lark-channel',
        "  disabled: !!js process.env.DISABLE_LARK\n",
      ),
      credentialName: annotate(
        configured,
        'dsh-enhanced-credentials-keychain',
        "  name: '@user/wrong-credential-package'\n",
      ),
      credentialDisabled: annotate(
        configured,
        'dsh-enhanced-credentials-keychain',
        '  disabled: true\n',
      ),
    }
    expect(Object.values(invalidRows).every(profilePatch => profilePatch !== configured)).toBe(true)

    for (const [name, profilePatch] of Object.entries(invalidRows)) {
      expect(() => configure({ profilePatch, ...common }), name)
        .toThrow(/managed profile row.*(?:shadowed|disabled|invalid)/iu)
      expect(() => refresh({
        profilePatch,
        dshHome: common.dshHome,
        agentTools: 'disable',
      }), name).toThrow(/managed profile row.*(?:shadowed|disabled|invalid)/iu)
    }
  })

  test('fails closed instead of rebuilding Agent grants from a wildcard or noncanonical ingress principal', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
    const common = {
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_secondary',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
    }
    const configured = configure({ profilePatch: fixture, ...common })
    const ingressPattern = /(id: lark-owner-ingress-secondary[\s\S]*?\n\s+id:) lark\/secondary\/personal\/ou_secondary/u
    const malformedIngresses = [
      'lark/secondary/*/*',
      'lark/secondary/%ZZ/ou_secondary',
      'lark/secondary/personal/ou%2fsecondary',
      'lark/secondary/personal/ou%252Fsecondary',
    ].map(principal => configured.replace(ingressPattern, `$1 ${principal}`))
    expect(malformedIngresses.every(profilePatch => profilePatch !== configured)).toBe(true)

    for (const profilePatch of malformedIngresses) {
      expect(() => configure({ profilePatch, ...common, agentTools: 'enable' }))
        .toThrow(/fixed rule lark-owner-ingress-secondary.*ambiguous/iu)
      expect(() => refresh({
        profilePatch,
        dshHome: common.dshHome,
        agentTools: 'enable',
      })).toThrow(/fixed rule lark-owner-ingress-secondary.*ambiguous/iu)
    }
  })

  test('refuses to implicitly migrate deny-only retired rules to another account', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const primary = configure({
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_primary',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
      agentTools: 'enable',
    })
    const denyOnly = primary
      .replace(/(id: lark-owner-capability-\*-primary\n\s+effect:) allow/u, '$1 deny')
      .replace(/(id: lark-owner-tool-\*-primary\n\s+effect:) allow/u, '$1 deny')
    expect(denyOnly).toContain('effect: deny')

    const migrate = (agentTools?: 'disable'): string => configure({
      profilePatch: denyOnly,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_fedcba9876543210',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_secondary',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
      ...(agentTools === undefined ? {} : { agentTools }),
    })
    expect(() => migrate()).toThrow(/cannot preserve.*enable or disable/iu)

    const secondary = migrate('disable')
    expect(secondary).not.toContain('lark-owner-capability-*-secondary')
    expect(secondary).not.toContain('lark-owner-tool-*-secondary')
    // Disable revokes allows but retains denies: deleting these could expose a
    // similarly scoped non-reserved/global allow.
    expect(secondary).toMatch(/id: lark-owner-capability-\*-primary\n\s+effect: deny/u)
    expect(secondary).toMatch(/id: lark-owner-tool-\*-primary\n\s+effect: deny/u)
  })

  test('fails closed when preserving a historical wildcard grant with managed mutator denies', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const primary = configure({
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_primary',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
      agentTools: 'enable',
    })
    const historicalDeniedTools = [
      'memory_manage',
      'wiki_upsert',
      'wiki_lint',
      'automation_create',
      'automation_manage',
      'automation_run',
      'evolution_propose',
      'knowledge_pin',
      'knowledge_promote',
      'heartbeat_scratch_update',
    ] as const
    const historical = primary.replace('      budgets: []', `${historicalDeniedTools.map(tool => `
        - id: lark-owner-tool-${tool}-primary
          effect: deny
          subject: { kind: agent, id: standard, workspace: /Users/test/.dsh/assistant-workspace }
          actions: [execute]
          resource: { kind: tool, id: ${tool} }
          context: { initiators: [external] }`).join('')}
      budgets: []`)
    expect(historical).toContain('lark-owner-tool-memory_manage-primary')

    const migrationInput = {
      profilePatch: historical,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_fedcba9876543210',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_secondary',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
    }
    expect(() => configure(migrationInput)).toThrow(/cannot preserve.*enable or disable/iu)

    const secondary = configure({ ...migrationInput, agentTools: 'disable' })
    expect(secondary).not.toContain('lark-owner-capability-*-secondary')
    expect(secondary).not.toContain('lark-owner-tool-*-secondary')
    expect(secondary).toMatch(/id: lark-owner-tool-memory_manage-primary\n\s+effect: deny/u)
  })

  test('preserve keeps a same-account managed deny that overrides a global allow', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
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
    }
    const enabled = configure({ ...common, agentTools: 'enable' })
    const restricted = enabled
      .replace(/(id: lark-owner-tool-\*-primary\n\s+effect:) allow/u, '$1 deny')
      .replace('      budgets: []', `
        - id: user-global-external-tool-allow
          effect: allow
          subject: { kind: agent, id: standard, workspace: /Users/test/.dsh/assistant-workspace }
          actions: [execute]
          resource: { kind: tool, id: "*" }
          context: { initiators: [external] }
      budgets: []`)
    expect(restricted).toContain('user-global-external-tool-allow')
    expect(restricted).toMatch(/id: lark-owner-tool-\*-primary\n\s+effect: deny/u)

    const preserved = configure({ ...common, profilePatch: restricted })
    const rows = parse(preserved) as {
      id: string
      config: { assistantPolicy: { rules: PolicyRuleShape[] } }
    }[]
    const rules = rows.find(row => row.id === 'dsh-enhanced-personal-assistant')!
      .config.assistantPolicy.rules
    const matching = rules.filter(rule =>
      rule.subject.kind === 'agent'
      && rule.subject.id === 'standard'
      && rule.subject.workspace === '/Users/test/.dsh/assistant-workspace'
      && rule.actions.includes('execute')
      && rule.context.initiators.includes('external')
      && rule.resource.kind === 'tool'
      && rule.resource.id === '*')
    expect(matching.some(rule => rule.id === 'user-global-external-tool-allow'
      && rule.effect === 'allow')).toBe(true)
    expect(matching.some(rule => rule.id === 'lark-owner-tool-*-primary'
      && rule.effect === 'deny')).toBe(true)
    expect(matching.some(rule => rule.effect === 'deny') ? 'deny' : 'allow').toBe('deny')

    for (const disabled of [
      configure({ ...common, profilePatch: restricted, agentTools: 'disable' }),
      refresh({ profilePatch: restricted, dshHome: common.dshHome, agentTools: 'disable' }),
    ]) {
      const disabledRows = parse(disabled) as {
        id: string
        config: { assistantPolicy: { rules: PolicyRuleShape[] } }
      }[]
      const disabledRules = disabledRows.find(row => row.id === 'dsh-enhanced-personal-assistant')!
        .config.assistantPolicy.rules
      expect(disabledRules).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'user-global-external-tool-allow', effect: 'allow' }),
        expect.objectContaining({ id: 'lark-owner-tool-*-primary', effect: 'deny' }),
      ]))
    }
  })

  test('fails closed when same-account managed allows target a different owner principal', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const common = {
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_owner',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
    }
    const enabled = configure({ ...common, agentTools: 'enable' })
    const foreignOwner = enabled
      .replace(
        /(id: lark-owner-capability-\*-secondary[\s\S]*?\n\s+principal:) lark\/secondary\/personal\/ou_owner/u,
        '$1 lark/secondary/personal/ou_attacker',
      )
      .replace(
        /(id: lark-owner-tool-\*-secondary[\s\S]*?\n\s+principal:) lark\/secondary\/personal\/ou_owner/u,
        '$1 lark/secondary/personal/ou_attacker',
      )
    expect(foreignOwner).not.toBe(enabled)

    expect(() => configure({ ...common, profilePatch: foreignOwner }))
      .toThrow(/managed Agent rule.*different owner principal/iu)
  })

  test('fails closed on duplicate setup-managed external Agent rule ids', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const common = {
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_owner',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
      agentTools: 'enable' as const,
    }
    const configured = configure({ profilePatch: fixture, ...common })
    const rows = parse(configured, {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
    }) as {
      id: string
      config: { assistantPolicy?: { rules: PolicyRuleShape[] } }
    }[]
    const rules = rows.find(row => row.id === 'dsh-enhanced-personal-assistant')!
      .config.assistantPolicy!.rules
    const wildcard = rules.find(rule => rule.id === 'lark-owner-tool-*-primary')
    expect(wildcard).toBeDefined()
    rules.push(structuredClone(wildcard!))

    expect(() => configure({ ...common, profilePatch: JSON.stringify(rows) }))
      .toThrow(/duplicate managed Agent rule lark-owner-tool-\*-primary/iu)
  })

  test('fails closed on duplicate restrictive setup-managed foreground rule ids', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const common = {
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_owner',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
    }
    const configured = configure({ profilePatch: fixture, ...common, agentTools: 'enable' })
    const rows = parse(configured, {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
    }) as {
      id: string
      config: { assistantPolicy?: { rules: PolicyRuleShape[] } }
    }[]
    const rules = rows.find(row => row.id === 'dsh-enhanced-personal-assistant')!
      .config.assistantPolicy!.rules
    const foreground = rules.find(rule => rule.id === 'dsh-enhanced-foreground-capability-*')
    expect(foreground).toBeDefined()
    foreground!.effect = 'deny'
    rules.push(structuredClone(foreground!))

    expect(() => configure({ profilePatch: JSON.stringify(rows), ...common }))
      .toThrow(/duplicate managed foreground rule dsh-enhanced-foreground-capability-\*/iu)
  })

  test('does not preserve principal-less Agent allows when the configured owner ingress is missing', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const common = {
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_new',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
    }
    const configured = configure({ profilePatch: fixture, ...common, agentTools: 'enable' })
    const rows = parse(configured, {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
    }) as {
      id: string
      config: { assistantPolicy?: { rules: PolicyRuleShape[] } }
    }[]
    const rules = rows.find(row => row.id === 'dsh-enhanced-personal-assistant')!
      .config.assistantPolicy!.rules
    const ingressIndex = rules.findIndex(rule => rule.id === 'lark-owner-ingress-primary')
    expect(ingressIndex).toBeGreaterThanOrEqual(0)
    rules.splice(ingressIndex, 1)
    for (const rule of rules) {
      if (rule.id === 'lark-owner-capability-*-primary' || rule.id === 'lark-owner-tool-*-primary') {
        delete rule.subject.principal
      }
    }

    expect(() => configure({ profilePatch: JSON.stringify(rows), ...common }))
      .toThrow(/canonical owner ingress/iu)
  })

  test('explicit enable fails closed when the configured owner ingress is missing', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
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
      agentTools: 'enable' as const,
    }
    const configured = configure(common)
    const rows = parse(configured, {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
    }) as {
      id: string
      config: { assistantPolicy?: { rules: PolicyRuleShape[] } }
    }[]
    const rules = rows.find(row => row.id === 'dsh-enhanced-personal-assistant')!
      .config.assistantPolicy!.rules
    const ingressIndex = rules.findIndex(rule => rule.id === 'lark-owner-ingress-primary')
    expect(ingressIndex).toBeGreaterThanOrEqual(0)
    rules.splice(ingressIndex, 1)

    expect(() => refresh({
      profilePatch: JSON.stringify(rows),
      dshHome: common.dshHome,
      agentTools: 'enable',
    })).toThrow(/canonical owner ingress/iu)
  })

  test('does not preserve a stale owner grant when the Lark row was previously removed', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const stale = fixture.replace('      budgets: []', `
        - id: lark-owner-ingress-primary
          effect: allow
          subject: { kind: external, id: lark/primary/personal/ou_retired }
          actions: [approval.decide, ingest]
          resource: { kind: message, id: "*" }
          context: { initiators: [external] }
        - id: lark-owner-tool-bash-primary
          effect: allow
          subject:
            kind: agent
            id: standard
            workspace: /Users/test/.dsh/assistant-workspace
            principal: lark/primary/personal/ou_retired
          actions: [execute]
          resource: { kind: tool, id: bash }
          context: { initiators: [external] }
      budgets: []`)

    expect(() => configure({
      profilePatch: stale,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_owner',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
    })).toThrow(/changing the Lark owner binding/iu)
  })

  test('principal-scopes a legacy per-tool allow during same-owner preserve', () => {
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
    }
    const configured = configure(common)
    const legacy = configured.replace('      budgets: []', `
        - id: lark-owner-tool-bash-primary
          effect: allow
          subject: { kind: agent, id: standard, workspace: /Users/test/.dsh/assistant-workspace }
          actions: [execute]
          resource: { kind: tool, id: bash }
          context: { initiators: [external] }
      budgets: []`)
    expect(legacy).toContain('lark-owner-tool-bash-primary')

    const preserved = configure({ ...common, profilePatch: legacy })
    const rows = parse(preserved) as {
      id: string
      config: { assistantPolicy: { rules: PolicyRuleShape[] } }
    }[]
    const legacyRule = rows.find(row => row.id === 'dsh-enhanced-personal-assistant')!
      .config.assistantPolicy.rules
      .find(rule => rule.id === 'lark-owner-tool-bash-primary')
    expect(legacyRule).toMatchObject({
      effect: 'allow',
      subject: {
        kind: 'agent',
        id: 'standard',
        workspace: '/Users/test/.dsh/assistant-workspace',
        principal: 'lark/primary/personal/ou_owner',
      },
      actions: ['execute'],
      resource: { kind: 'tool', id: 'bash' },
      context: { initiators: ['external'] },
    })
  })

  test('account migration refuses to drop a managed deny beside a global allow', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const primary = configure({
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_primary',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
      agentTools: 'enable',
    })
    const restricted = primary
      .replace(/(id: lark-owner-tool-\*-primary\n\s+effect:) allow/u, '$1 deny')
      .replace('      budgets: []', `
        - id: user-global-external-tool-allow
          effect: allow
          subject: { kind: agent, id: standard, workspace: /Users/test/.dsh/assistant-workspace }
          actions: [execute]
          resource: { kind: tool, id: "*" }
          context: { initiators: [external] }
      budgets: []`)

    expect(() => configure({
      profilePatch: restricted,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_fedcba9876543210',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_secondary',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
    })).toThrow(/cannot preserve.*enable or disable/iu)
  })

  test('does not preserve foreign-principal or one-sided wildcard grants', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const primary = configure({
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_primary',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
      agentTools: 'enable',
    })
    const migrate = (profilePatch: string): string => configure({
      profilePatch,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_fedcba9876543210',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_secondary',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
    })
    const foreign = primary
      .replace(
        /(id: lark-owner-capability-\*-primary[\s\S]*?\n\s+principal:) lark\/primary\/personal\/ou_primary/u,
        '$1 slack/primary/personal/ou_primary',
      )
      .replace(
        /(id: lark-owner-tool-\*-primary[\s\S]*?\n\s+principal:) lark\/primary\/personal\/ou_primary/u,
        '$1 slack/primary/personal/ou_primary',
      )
    expect(foreign).toContain('principal: slack/primary/personal/ou_primary')
    expect(() => migrate(foreign)).toThrow(/managed Agent rule.*malformed/iu)

    const capabilityStart = primary.indexOf('        - id: lark-owner-capability-*-primary')
    const capabilityEnd = primary.indexOf('\n        - id: ', capabilityStart + 1)
    expect(capabilityStart).toBeGreaterThanOrEqual(0)
    expect(capabilityEnd).toBeGreaterThan(capabilityStart)
    const toolOnly = primary.slice(0, capabilityStart) + primary.slice(capabilityEnd + 1)
    expect(toolOnly).not.toContain('lark-owner-capability-*-primary')
    expect(toolOnly).toContain('lark-owner-tool-*-primary')
    expect(() => migrate(toolOnly)).toThrow(/cannot preserve.*enable or disable/iu)
  })

  test('global stale cleanup preserves similarly named user rules outside reserved ids', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
    const configured = configure({
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_owner',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
    })
    const withUserRules = configured.replace('      budgets: []', `
        - id: user-lark-owner-tool-*-user-defined
          effect: allow
          subject: { kind: agent, id: standard, workspace: /Users/test/.dsh/assistant-workspace }
          actions: [read]
          resource: { kind: memory, id: private }
          context: { initiators: [foreground] }
        - id: user-lark-owner-reply-user-defined
          effect: deny
          subject: { kind: external, id: local:user-defined }
          actions: [send]
          resource: { kind: message, id: private }
          context: { initiators: [foreground] }
      budgets: []`)

    const refreshed = refresh({
      profilePatch: withUserRules,
      dshHome: '/Users/test/.dsh',
      agentTools: 'enable',
    })
    expect(refreshed).toContain('user-lark-owner-tool-*-user-defined')
    expect(refreshed).toContain('user-lark-owner-reply-user-defined')
  })

  test('reserved Lark setup namespaces fail closed even when their suffix cannot be parsed', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
    const common = {
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_owner',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
    }
    for (const id of [
      'lark-owner-tool-*-*',
      'lark-owner-tool-evil-primary',
      'lark-owner-ingress-*',
      'lark-owner-approval-unknown-primary',
      'lark-channel-credential-*',
      'dsh-enhanced-foreground-capability-unknown',
      'lark-foreground-tool-unknown',
    ]) {
      const polluted = fixture.replace('      budgets: []', `
        - id: ${id}
          effect: allow
          subject: { kind: agent, id: "*", workspace: "*", principal: "*" }
          actions: ["*"]
          resource: { kind: "*", id: "*" }
          context: { initiators: [external] }
      budgets: []`)
      expect(() => refresh({
        profilePatch: polluted,
        dshHome: common.dshHome,
        agentTools: 'disable',
      })).toThrow(/(?:reserved|managed|fixed).*(?:malformed|ambiguous)/iu)
      expect(() => configure({ ...common, profilePatch: polluted, agentTools: 'disable' }))
        .toThrow(/(?:reserved|managed|fixed).*(?:malformed|ambiguous)/iu)
    }
  })

  test('explicit Agent policy changes fail closed on malformed effective managed grants', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
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
    }
    const enabled = configure({ ...common, agentTools: 'enable' })
    const malformed = enabled.replace(
      /(id: lark-owner-tool-\*-primary[\s\S]*?context:\n\s+)initiators:\n\s+- external/u,
      '$1initiators: [external, foreground]',
    )
    expect(malformed).not.toBe(enabled)

    for (const agentTools of ['enable', 'disable'] as const) {
      expect(() => configure({ ...common, profilePatch: malformed, agentTools }))
        .toThrow(/managed Agent rule.*malformed/iu)
      expect(() => refresh({
        profilePatch: malformed,
        dshHome: '/Users/test/.dsh',
        agentTools,
      })).toThrow(/managed Agent rule.*malformed/iu)
    }
  })

  test('explicit Agent policy changes also reject malformed grants from a retired exact principal', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
    const configured = configure({
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_secondary',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
      agentTools: 'enable',
    })
    const polluted = configured.replace('      budgets: []', `
        - id: lark-owner-tool-*-retired
          effect: allow
          subject:
            kind: agent
            id: standard
            workspace: /Users/test/.dsh/assistant-workspace
            principal: lark/retired/personal/ou_retired
          actions: [execute]
          resource: { kind: tool, id: "*" }
          context: { initiators: [external, foreground] }
      budgets: []`)

    for (const agentTools of ['enable', 'disable'] as const) {
      expect(() => refresh({
        profilePatch: polluted,
        dshHome: '/Users/test/.dsh',
        agentTools,
      })).toThrow(/lark-owner-tool-\*-retired.*malformed/iu)
    }
  })

  test('canonical managed principals stay attributable after current subject identity is widened', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
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
    }
    const enabled = configure({ ...common, agentTools: 'enable' })
    const malformedProfiles = [
      enabled.replace(
        /(id: lark-owner-tool-\*-primary[\s\S]*?subject:\n[\s\S]*?\n\s+id:) standard/u,
        '$1 "*"',
      ),
      enabled.replace(
        /(id: lark-owner-tool-\*-primary[\s\S]*?subject:\n[\s\S]*?\n\s+workspace:) \/Users\/test\/\.dsh\/assistant-workspace/u,
        '$1 "*"',
      ),
    ]
    expect(malformedProfiles.every(profile => profile !== enabled)).toBe(true)

    for (const profilePatch of malformedProfiles) {
      expect(() => refresh({
        profilePatch,
        dshHome: '/Users/test/.dsh',
        agentTools: 'disable',
      })).toThrow(/lark-owner-tool-\*-primary.*malformed/iu)
      expect(() => configure({ ...common, profilePatch, agentTools: 'enable' }))
        .toThrow(/lark-owner-tool-\*-primary.*malformed/iu)
    }
  })

  test('legacy current managed grants stay attributable after subject identity is widened', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
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
    }
    const enabled = configure({ ...common, agentTools: 'enable' })
    const legacy = enabled.replace(
      /(id: lark-owner-tool-\*-primary[\s\S]*?\n\s+principal:) lark\/primary\/personal\/ou_owner/u,
      '$1-placeholder removed',
    ).replace(/\n\s+principal:-placeholder removed/u, '')
    expect(legacy).not.toContain('principal:-placeholder removed')
    const malformedProfiles = [
      legacy.replace(
        /(id: lark-owner-tool-\*-primary[\s\S]*?subject:\n[\s\S]*?\n\s+id:) standard/u,
        '$1 "*"',
      ),
      legacy.replace(
        /(id: lark-owner-tool-\*-primary[\s\S]*?subject:\n[\s\S]*?\n\s+workspace:) \/Users\/test\/\.dsh\/assistant-workspace/u,
        '$1 "*"',
      ),
    ]
    expect(malformedProfiles.every(profile => profile !== legacy)).toBe(true)
    for (const profilePatch of malformedProfiles) {
      expect(() => refresh({ profilePatch, dshHome: '/Users/test/.dsh', agentTools: 'disable' }))
        .toThrow(/lark-owner-tool-\*-primary.*malformed/iu)
    }
  })

  test('canonical retired principals stay attributable after id or workspace is widened', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
    const configured = configure({
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_secondary',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
      agentTools: 'enable',
    })
    const retiredRule = (subjectId: string, workspace: string): string => configured.replace('      budgets: []', `
        - id: lark-owner-tool-*-retired
          effect: allow
          subject:
            kind: agent
            id: "${subjectId}"
            workspace: "${workspace}"
            principal: lark/retired/personal/ou_retired
          actions: [execute]
          resource: { kind: tool, id: "*" }
          context: { initiators: [external] }
      budgets: []`)

    for (const profilePatch of [
      retiredRule('*', '/Users/test/.dsh/assistant-workspace'),
      retiredRule('standard', '*'),
    ]) {
      expect(() => refresh({
        profilePatch,
        dshHome: '/Users/test/.dsh',
        agentTools: 'disable',
      })).toThrow(/lark-owner-tool-\*-retired.*malformed/iu)
    }
  })

  test('retired legacy managed grants remain attributable when their context is widened', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
    const configured = configure({
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_secondary',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
      agentTools: 'enable',
    })
    const polluted = configured.replace('      budgets: []', `
        - id: lark-owner-tool-*-retired
          effect: allow
          subject: { kind: agent, id: standard, workspace: /Users/test/.dsh/assistant-workspace }
          actions: [execute]
          resource: { kind: tool, id: "*" }
          context: { initiators: [external, foreground] }
      budgets: []`)
    expect(() => refresh({
      profilePatch: polluted,
      dshHome: '/Users/test/.dsh',
      agentTools: 'disable',
    })).toThrow(/lark-owner-tool-\*-retired.*malformed/iu)
  })

  test('legacy managed grants remain attributable when action and resource planes are widened', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
    const configured = configure({
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
    const broadenedRule = (account: string): string => `
        - id: lark-owner-tool-*-${account}
          effect: allow
          subject: { kind: agent, id: standard, workspace: /Users/test/.dsh/assistant-workspace }
          actions: ["*"]
          resource: { kind: "*", id: "*" }
          context: { initiators: [external] }`
    for (const profilePatch of [
      configured.replace('      budgets: []', `${broadenedRule('primary')}
      budgets: []`),
      configured.replace('      budgets: []', `${broadenedRule('retired')}
      budgets: []`),
    ]) {
      expect(() => refresh({
        profilePatch,
        dshHome: '/Users/test/.dsh',
        agentTools: 'disable',
      })).toThrow(/lark-owner-tool-\*-(primary|retired).*malformed/iu)
    }
  })

  test('reserved capability ids cannot be repurposed into wildcard tool grants', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
    const configured = configure({
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_secondary',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
    })
    const polluted = configured.replace('      budgets: []', `
        - id: lark-owner-capability-*-retired
          effect: allow
          subject:
            kind: agent
            id: standard
            workspace: /Users/test/.dsh/assistant-workspace
            principal: "*"
          actions: [execute]
          resource: { kind: tool, id: "*" }
          context: { initiators: [external] }
      budgets: []`)
    expect(() => refresh({
      profilePatch: polluted,
      dshHome: '/Users/test/.dsh',
      agentTools: 'disable',
    })).toThrow(/lark-owner-capability-\*-retired.*malformed/iu)
  })

  test('retired legacy matcher widenings cannot survive explicit disable', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
    const configured = configure({
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_secondary',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
    })
    const exactSubject = `subject:
            kind: agent
            id: standard
            workspace: /Users/test/.dsh/assistant-workspace`
    const variants = [
      `${exactSubject}
          actions: [exec*]
          resource: { kind: to*, id: "*" }`,
      `subject: { kind: "*", id: standard, workspace: /Users/test/.dsh/assistant-workspace }
          actions: [execute]
          resource: { kind: tool, id: "*" }`,
      `actions: [execute]
          resource: { kind: tool, id: "*" }`,
      `${exactSubject}
            principal: "*"
          actions: [execute]
          resource: { kind: tool, id: "*" }`,
      `${exactSubject}
          resource: { kind: tool, id: "*" }`,
      `${exactSubject}
          actions: [execute]`,
    ]
    for (const variant of variants) {
      const polluted = configured.replace('      budgets: []', `
        - id: lark-owner-tool-*-retired
          effect: allow
          ${variant}
          context: { initiators: [external] }
      budgets: []`)
      expect(() => refresh({
        profilePatch: polluted,
        dshHome: '/Users/test/.dsh',
        agentTools: 'disable',
      })).toThrow(/lark-owner-tool-\*-retired.*malformed/iu)
    }
  })

  test('reserved legacy ids fail closed across initiator mutations', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
    const configured = configure({
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'secondary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_secondary',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
    })
    const rule = (context: string): string => configured.replace('      budgets: []', `
        - id: lark-owner-tool-*-retired
          effect: allow
          subject: { kind: agent, id: standard, workspace: /Users/test/.dsh/assistant-workspace }
          actions: [execute]
          resource: { kind: tool, id: "*" }${context}
      budgets: []`)
    for (const profilePatch of [
      rule(''),
      rule('\n          context: { initiators: [] }'),
      rule('\n          context: { initiators: [external, foreground] }'),
    ]) {
      expect(() => refresh({ profilePatch, dshHome: '/Users/test/.dsh', agentTools: 'disable' }))
        .toThrow(/lark-owner-tool-\*-retired.*malformed/iu)
    }

    expect(() => refresh({
      profilePatch: rule('\n          context: { initiators: [foreground] }'),
      dshHome: '/Users/test/.dsh',
      agentTools: 'disable',
    })).toThrow(/lark-owner-tool-\*-retired.*malformed/iu)
  })

  test('account migration fails closed on a malformed stale managed reply grant', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const primary = configure({
      profilePatch: fixture,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_primary',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
      agentTools: 'enable',
    })
    const malformed = primary.replace(
      /(id: lark-owner-reply-primary[\s\S]*?context:\n\s+)initiators:\n\s+- external/u,
      '$1initiators: [external, foreground]',
    )
    expect(malformed).not.toBe(primary)
    const migrate = (agentTools?: 'disable'): string => configure({
      profilePatch: malformed,
      dshHome: '/Users/test/.dsh',
      appId: 'cli_fedcba9876543210',
      account: 'secondary',
      tenant: 'next-tenant',
      domain: 'feishu',
      ownerUserId: 'ou_secondary',
      keychainService: 'dsh/lark/web/secondary',
      keychainAccount: 'secondary',
      ...(agentTools === undefined ? {} : { agentTools }),
    })
    expect(() => migrate()).toThrow(/lark-owner-reply-primary.*malformed/iu)
    expect(() => migrate('disable')).toThrow(/lark-owner-reply-primary.*malformed/iu)
  })

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
      progressDetails: 'direct',
      statusReactions: true,
      imageDownloadTimeoutMs: 30_000,
    })
    const rules = rows.find((row: { id: string }) => row.id === 'dsh-enhanced-personal-assistant')
      .config.assistantPolicy.rules
    expect(rules.find((rule: { id: string }) => rule.id === 'lark-owner-reply-primary')).toMatchObject({
      subject: {
        kind: 'agent',
        id: 'standard',
        workspace: '/Users/test/.dsh/assistant-workspace',
        principal: 'lark/primary/personal/ou_owner',
      },
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
      subject: {
        kind: 'agent',
        id: 'standard',
        workspace: '/Users/test/.dsh/assistant-workspace',
        principal: 'lark/primary/personal/ou_owner',
      },
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

  test('does not widen denied or narrowed foreground rules in preserve mode', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
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
    }
    const enabled = configure({ ...common, agentTools: 'enable' })
    const denied = enabled.replace(
      /(id: dsh-enhanced-foreground-capability-\*\n\s+effect:) allow/u,
      '$1 deny',
    )
    const narrowed = enabled.replace(
      /(id: dsh-enhanced-foreground-capability-\*[\s\S]*?\n\s+actions:\n\s+-) "\*"/u,
      '$1 execute',
    )
    expect(denied).not.toBe(enabled)
    expect(narrowed).not.toBe(enabled)

    const foregroundRule = (profilePatch: string): PolicyRuleShape => {
      const rows = parse(configure({ ...common, profilePatch })) as {
        id: string
        config: { assistantPolicy: { rules: PolicyRuleShape[] } }
      }[]
      return rows.find(row => row.id === 'dsh-enhanced-personal-assistant')!
        .config.assistantPolicy.rules
        .find(rule => rule.id === 'dsh-enhanced-foreground-capability-*')!
    }
    expect(foregroundRule(denied)).toMatchObject({ effect: 'deny', actions: ['*'] })
    expect(foregroundRule(narrowed)).toMatchObject({ effect: 'allow', actions: ['execute'] })

    const disabledRule = (profilePatch: string): PolicyRuleShape | undefined => {
      const rows = parse(configure({ ...common, profilePatch, agentTools: 'disable' })) as {
        id: string
        config: { assistantPolicy: { rules: PolicyRuleShape[] } }
      }[]
      return rows.find(row => row.id === 'dsh-enhanced-personal-assistant')!
        .config.assistantPolicy.rules
        .find(rule => rule.id === 'dsh-enhanced-foreground-capability-*')!
    }
    expect(disabledRule(denied)).toMatchObject({ effect: 'deny', actions: ['*'] })
    expect(disabledRule(narrowed)).toBeUndefined()

    const refreshedRule = (profilePatch: string): PolicyRuleShape | undefined => {
      const rows = parse(refresh({ profilePatch, dshHome: common.dshHome, agentTools: 'disable' })) as {
        id: string
        config: { assistantPolicy: { rules: PolicyRuleShape[] } }
      }[]
      return rows.find(row => row.id === 'dsh-enhanced-personal-assistant')!
        .config.assistantPolicy.rules
        .find(rule => rule.id === 'dsh-enhanced-foreground-capability-*')
    }
    expect(refreshedRule(denied)).toMatchObject({ effect: 'deny', actions: ['*'] })
    expect(refreshedRule(narrowed)).toBeUndefined()
  })

  test('fails closed when a reserved foreground allow can escape its local initiator', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
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
    }
    const enabled = configure({ ...common, agentTools: 'enable' })
    const initiatorPattern = /(id: dsh-enhanced-foreground-capability-\*[\s\S]*?context:\n\s+)initiators:\n\s+- foreground/u
    const variants = {
      external: enabled.replace(initiatorPattern, '$1initiators: [external]'),
      mixed: enabled.replace(initiatorPattern, '$1initiators: [external, foreground]'),
      principal: enabled.replace(
        /(id: dsh-enhanced-foreground-capability-\*[\s\S]*?\n\s+workspace: "\*")/u,
        '$1\n            principal: "*"',
      ),
    }
    expect(Object.values(variants).every(profilePatch => profilePatch !== enabled)).toBe(true)

    for (const [name, profilePatch] of Object.entries(variants)) {
      expect(() => configure({ ...common, profilePatch }), name)
        .toThrow(/managed foreground rule.*(?:unsafe|malformed)/iu)
      expect(() => refresh({ profilePatch, dshHome: common.dshHome, agentTools: 'disable' }), name)
        .toThrow(/managed foreground rule.*(?:unsafe|malformed)/iu)
    }
  })

  test('explicit enable retires a legacy foreground deny before installing full control', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
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
    }
    const configured = configure(common)
    const legacyDeny = configured.replace('      budgets: []', `
        - id: lark-foreground-tool-primary
          effect: deny
          subject: { kind: agent, id: "*", workspace: "*" }
          actions: [execute]
          resource: { kind: tool, id: "*" }
          context: { initiators: [foreground] }
      budgets: []`)
    expect(legacyDeny).toContain('lark-foreground-tool-primary')

    for (const enabled of [
      configure({ ...common, profilePatch: legacyDeny, agentTools: 'enable' }),
      refresh({ profilePatch: legacyDeny, dshHome: common.dshHome, agentTools: 'enable' }),
    ]) {
      expect(enabled).not.toContain('lark-foreground-tool-primary')
      expect(enabled).toMatch(/id: dsh-enhanced-foreground-capability-\*\n\s+effect: allow/u)
    }
  })

  test('explicit enable will not remove a reserved deny that also protects external requests', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const refresh = (lark as Record<string, unknown>).refreshLarkAgentPolicyPatch as (input: unknown) => string
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
    }
    const enabled = configure({ ...common, agentTools: 'enable' })
    const crossPlaneDeny = enabled
      .replace(
        /(id: dsh-enhanced-foreground-capability-\*\n\s+effect:) allow/u,
        '$1 deny',
      )
      .replace(
        /(id: dsh-enhanced-foreground-capability-\*[\s\S]*?context:\n\s+initiators:\n\s+-) foreground/u,
        '$1 external',
      )
    expect(crossPlaneDeny).not.toBe(enabled)

    expect(() => configure({ ...common, profilePatch: crossPlaneDeny, agentTools: 'enable' }))
      .toThrow(/foreground deny.*external.*refusing/iu)
    expect(() => refresh({
      profilePatch: crossPlaneDeny,
      dshHome: common.dshHome,
      agentTools: 'enable',
    })).toThrow(/foreground deny.*external.*refusing/iu)
    expect(configure({ ...common, profilePatch: crossPlaneDeny, agentTools: 'disable' }))
      .toContain('dsh-enhanced-foreground-capability-*')
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

  test('writes only a versioned Linux protected-file locator for headless onboarding', () => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    const credentialPath = '/home/test/.dsh/credentials-keychain/lark-web-primary-11111111111111111111111111111111.secret'
    const output = configure({
      profilePatch: fixture,
      dshHome: '/home/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_owner',
      credentialProvider: 'linux-protected-file',
      credentialPath,
      keychainService: 'dsh/lark/web/primary/versions/linux-protected-file',
      keychainAccount: 'primary',
      agentTools: 'enable',
    })

    const rows = parse(output, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
    const credentials = rows.find((row: { id: string }) => row.id === 'dsh-enhanced-credentials-keychain')
    expect(credentials.config.handles).toEqual([expect.objectContaining({
      provider: 'linux-protected-file',
      path: credentialPath,
    })])
    expect(credentials.config.handles[0]).not.toHaveProperty('service')
    expect(credentials.config.handles[0]).not.toHaveProperty('account')
    expect(output).not.toMatch(/client_secret|candidate-secret/u)
  })

  test.each([
    'C:\\Users\\test\\lark.secret',
    '/home/test/.dsh/credentials-keychain/../lark.secret',
  ])('rejects a non-normalized POSIX protected-file path: %s', credentialPath => {
    const configure = (lark as Record<string, unknown>).configureLarkProfilePatch as (input: unknown) => string
    expect(() => configure({
      profilePatch: fixture,
      dshHome: '/home/test/.dsh',
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_owner',
      credentialProvider: 'linux-protected-file',
      credentialPath,
      keychainService: 'dsh/lark/web/primary/versions/linux-protected-file',
      keychainAccount: 'primary',
      agentTools: 'enable',
    })).toThrow(/invalid credentialPath/u)
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
      subject: {
        kind: 'agent',
        id: 'standard',
        workspace: '/Users/test/.dsh/assistant-workspace',
        principal: 'lark/primary/personal/ou_owner',
      },
      actions: ['execute'],
      resource: { kind: 'tool', id: '*' },
      context: { initiators: ['external'] },
    })

    const foreground = rules.find(item => item.id === 'dsh-enhanced-foreground-capability-*')
    expect(foreground).toMatchObject({
      effect: 'allow',
      subject: { kind: 'agent', id: '*', workspace: '*' },
      actions: ['*'],
      resource: { kind: '*', id: '*' },
      context: { initiators: ['foreground'] },
    })
    const externalCapabilities = rules.find(item => item.id === 'lark-owner-capability-*-primary')
    expect(externalCapabilities).toMatchObject({
      effect: 'allow',
      subject: {
        kind: 'agent',
        id: 'standard',
        workspace: '/Users/test/.dsh/assistant-workspace',
        principal: 'lark/primary/personal/ou_owner',
      },
      actions: ['*'],
      resource: { kind: '*', id: '*' },
      context: { initiators: ['external'] },
    })
    const capabilityRules = rules.filter(item => item.resource.id === '*')
    const capabilityDecision = (input: {
      preset: string
      workspace: string
      principal?: string
      initiator: 'background' | 'external' | 'foreground'
      action: string
      resourceKind: string
    }): 'allow' | 'deny' => {
      const matched = capabilityRules.filter(item =>
        (item.subject.id === '*' || item.subject.id === input.preset)
        && (item.subject.workspace === '*' || item.subject.workspace === input.workspace)
        && (item.subject.principal === undefined || item.subject.principal === input.principal)
        && (item.actions.includes('*') || item.actions.includes(input.action))
        && item.context.initiators.includes(input.initiator)
        && (item.resource.kind === '*' || item.resource.kind === input.resourceKind))
      if (matched.some(item => item.effect === 'deny')) return 'deny'
      return matched.some(item => item.effect === 'allow') ? 'allow' : 'deny'
    }
    expect(capabilityDecision({
      preset: 'cordis', workspace: '/Users/test/project', initiator: 'foreground',
      action: 'search', resourceKind: 'memory',
    })).toBe('allow')
    expect(capabilityDecision({
      preset: 'standard', workspace: '/Users/test/.dsh/assistant-workspace', initiator: 'external',
      principal: 'lark/primary/personal/ou_owner', action: 'search', resourceKind: 'memory',
    })).toBe('allow')
    expect(capabilityDecision({
      preset: 'standard', workspace: '/Users/test/.dsh/assistant-workspace', initiator: 'external',
      principal: 'lark/secondary/personal/ou_owner', action: 'search', resourceKind: 'memory',
    })).toBe('deny')
    expect(capabilityDecision({
      preset: 'standard', workspace: '/Users/test/.dsh/assistant-workspace', initiator: 'external',
      principal: 'slack/primary/personal/ou_owner', action: 'search', resourceKind: 'memory',
    })).toBe('deny')
    expect(capabilityDecision({
      preset: 'standard', workspace: '/Users/test/.dsh/assistant-workspace', initiator: 'background',
      action: 'search', resourceKind: 'memory',
    })).toBe('deny')

    // Resolve a tool the way AssistantPolicy does, so this proves reachability
    // rather than restating the emitter's own shape. Deny wins over allow at any
    // specificity, and only the tool id is ever a pattern. Kept local because the
    // real evaluator is internal to assistant-policy and must not be imported
    // across package boundaries.
    const toolRules = rules.filter(item => item.resource.kind === 'tool')
    const decide = (tool: string, principal = 'lark/primary/personal/ou_owner'): 'allow' | 'deny' => {
      const matched = toolRules.filter(item =>
        item.subject.id === 'standard'
        && item.subject.workspace === '/Users/test/.dsh/assistant-workspace'
        && item.subject.principal === principal
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
    expect(decide('bash', 'lark/secondary/personal/ou_owner')).toBe('deny')
    expect(decide('bash', 'slack/primary/personal/ou_owner')).toBe('deny')
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
    expect(disabled).not.toContain('dsh-enhanced-foreground-capability-')
    expect(disabled).not.toContain('lark-foreground-capability-')
    expect(disabled).not.toContain('lark-owner-capability-')
  })
})
