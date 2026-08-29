import { describe, expect, test } from 'vitest'
import { parse, stringify } from 'yaml'
import {
  assertEffectiveSupervisedGrowthConfig,
  configureSupervisedGrowthProfilePatch,
  supervisedGrowthDatabasePaths,
} from '../src/supervised-growth-profile.ts'

const fixture = `
- id: dsh-enhanced-personal-assistant
  config:
    assistantPolicy:
      databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')
      rules:
        - id: keep-user-rule
          effect: allow
          subject: { kind: agent, id: standard, workspace: /Users/test/.dsh/assistant-workspace }
          actions: [read]
          resource: { kind: memory, id: "*" }
          context: { initiators: [foreground] }
      budgets:
        - id: keep-user-budget
          metric: reads
          limit: 5
          periodMs: 60000
          scope: subject
    personalMemory:
      databasePath: !!js dshHomePath('personal-memory/memory.sqlite')
      approvalMode: delivery-required
      maxContentBytes: 4096
      maxRecordsPerIdentity: 1000
      searchLimit: 20
      snapshotLimit: 20
      snapshotMaxBytes: 8192
      snapshotMaxTokens: 2048
      defaultProposalTtlMs: 900000
      maxImportRecords: 100
      reconcileIntervalMs: 15000
      reconcileLimit: 50
    personalWiki:
      vaultRoot: !!js dshHomePath('personal-wiki/vault')
      databasePath: !!js dshHomePath('personal-wiki/state.sqlite')
      maxPageBytes: 1048576
      searchLimit: 20
      maxSnippetBytes: 2048
      readMaxBytes: 8192
      readMaxParagraphs: 40
      lintLimit: 200
      defaultProposalTtlMs: 900000
      reconcileIntervalMs: 15000
      reconcileLimit: 50
    assistantAutomations:
      databasePath: /Users/test/.dsh/assistant-automations/state.sqlite
      runsPath: /Users/test/.dsh/assistant-automations/runs
      schedulerEnabled: false
      toolCapableProviders: [deepseek-official]
      unknownRouteToolCalls: deny
- id: dsh-enhanced-assistant-delivery
  config:
    defaultWorkspace: !!js dshHomePath('assistant-workspace')
    defaultAgentPreset: standard
    agentProvider: deepseek-official
    agentModel: deepseek-v4-flash
    toolCapableProviders: [deepseek-official]
    unknownRouteToolCalls: deny
- id: dsh-enhanced-lark-channel
  config: { enabled: true, account: primary, tenant: personal }
- id: dsh-enhanced-traex-acp-provider
  config: { enabled: false, cwd: /tmp/old }
- id: dsh-enhanced-assistant-heartbeat
  config:
    heartbeats:
      - id: preserve-existing
        enabled: false
        scratchPath: /Users/test/.dsh/assistant-heartbeat/existing.md
        workspace: /Users/test/.dsh/assistant-workspace
        agentPreset: standard
        provider: deepseek-official
        model: deepseek-v4-flash
        timezone: Asia/Shanghai
        principal: lark/primary/personal/ou_owner
    maxScratchBytes: 2048
- id: dsh-enhanced-assistant-evolution
  config: { databasePath: /Users/test/.dsh/assistant-evolution/state.sqlite }
`

const binding = {
  id: 'binding-owner-dm',
  conversation: { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'oc_owner' },
  principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_owner' },
  workspace: '/Users/test/.dsh/assistant-workspace',
  agentPreset: 'standard',
  sessionId: 'session-owner',
  generation: 1,
  policyRef: 'owner-dm',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  version: 1,
} as const

function configured(profilePatch = fixture, effectiveConfig = fixture): string {
  return configureSupervisedGrowthProfilePatch({
    profilePatch,
    effectiveConfig,
    dshHome: '/Users/test/.dsh',
    binding,
  })
}

function rows(output: string): any[] {
  return parse(output, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
}

describe('supervised-growth profile patch', () => {
  test('creates one deterministic, bounded heartbeat and only exact policy grants', () => {
    const once = configured()
    const twice = configured(once)
    expect(twice).toBe(once)

    const parsed = rows(once)
    const assistant = parsed.find(row => row.id === 'dsh-enhanced-personal-assistant').config
    const delivery = parsed.find(row => row.id === 'dsh-enhanced-assistant-delivery').config
    const traex = parsed.find(row => row.id === 'dsh-enhanced-traex-acp-provider').config
    const heartbeat = parsed.find(row => row.id === 'dsh-enhanced-assistant-heartbeat').config
    const growth = heartbeat.heartbeats.find((entry: { id: string }) => entry.id === 'supervised-growth')

    expect(assistant.assistantAutomations.schedulerEnabled).toBe(true)
    expect(assistant.assistantAutomations.toolCapableProviders).toBeUndefined()
    expect(assistant.assistantAutomations.unknownRouteToolCalls).toBeUndefined()
    expect(assistant.assistantPolicy.rules.find((rule: { id: string }) => rule.id === 'keep-user-rule')).toBeDefined()
    expect(assistant.assistantPolicy.budgets).toContainEqual({
      id: 'supervised-growth-daily-runs', metric: 'automation-runs', limit: 7, periodMs: 86400000, scope: 'workspace',
    })
    expect(delivery).toMatchObject({ agentProvider: 'traex-agent', agentModel: 'default' })
    expect(delivery.toolCapableProviders).toBeUndefined()
    expect(delivery.unknownRouteToolCalls).toBeUndefined()
    expect(traex).toMatchObject({ enabled: true, cwd: '/Users/test/.dsh/assistant-workspace' })
    expect(growth).toMatchObject({
      enabled: true,
      scratchPath: '/Users/test/.dsh/assistant-heartbeat/supervised-growth.md',
      workspace: '/Users/test/.dsh/assistant-workspace',
      agentPreset: 'standard',
      provider: 'traex-agent',
      model: 'default',
      timezone: 'Asia/Shanghai',
      activeStartHour: 8,
      activeEndHour: 22,
      intervalMinutes: 120,
      principal: 'lark/primary/personal/ou_owner',
      allowedTools: ['evolution_review', 'evolution_propose'],
      timeoutMs: 60000,
      maxOutputTokens: 512,
      maxToolCalls: 2,
      budgetId: 'supervised-growth-daily-runs',
      budgetAmount: 1,
      deliveryBindingId: 'binding-owner-dm',
    })
    expect(growth.initialScratch).toMatch(/review before.*propose/i)
    expect(growth.initialScratch).toContain('owner-approved guidance proposal')
    expect(growth.initialScratch).toMatch(/must not modify code, credentials, or Policy/i)

    const rules = assistant.assistantPolicy.rules.filter((rule: { id: string }) => rule.id.startsWith('supervised-growth-'))
    expect(rules.map((rule: { id: string }) => rule.id).sort()).toEqual([
      'supervised-growth-automation-delivery',
      'supervised-growth-evolution-approval-delivery',
      'supervised-growth-evolution-inspect-candidates',
      'supervised-growth-evolution-inspect-rules',
      'supervised-growth-evolution-propose',
      'supervised-growth-evolution-propose-tool',
      'supervised-growth-evolution-review',
      'supervised-growth-guidance-snapshot',
      'supervised-growth-heartbeat-execute',
      'supervised-growth-heartbeat-reconcile',
    ])
    expect(rules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'supervised-growth-heartbeat-reconcile',
        subject: { kind: 'background', id: 'assistant-heartbeat', workspace: '/Users/test/.dsh/assistant-workspace', principal: 'lark/primary/personal/ou_owner' },
        actions: ['reconcile'], resource: { kind: 'automation', id: 'heartbeat:supervised-growth' }, context: { initiators: ['background'] },
      }),
      expect.objectContaining({
        id: 'supervised-growth-heartbeat-execute',
        subject: { kind: 'background', id: 'heartbeat:supervised-growth', workspace: '/Users/test/.dsh/assistant-workspace', principal: 'lark/primary/personal/ou_owner' },
        actions: ['execute'], resource: { kind: 'automation', id: 'heartbeat:supervised-growth' }, context: { initiators: ['background'] },
      }),
      expect.objectContaining({
        id: 'supervised-growth-automation-delivery',
        actions: ['send'], resource: { kind: 'message', id: 'binding-owner-dm' }, context: { initiators: ['background'] },
      }),
      expect.objectContaining({
        id: 'supervised-growth-evolution-approval-delivery',
        subject: {
          kind: 'background', id: 'dsh-enhanced-assistant-evolution',
          workspace: '/Users/test/.dsh/assistant-workspace', principal: 'lark/primary/personal/ou_owner',
        },
        actions: ['approval.send'], resource: { kind: 'message', id: 'binding-owner-dm' }, context: { initiators: ['background'] },
      }),
      expect.objectContaining({
        id: 'supervised-growth-evolution-review',
        actions: ['execute'], resource: { kind: 'tool', id: 'evolution_review' }, context: { initiators: ['background'] },
      }),
      expect.objectContaining({
        id: 'supervised-growth-evolution-propose-tool',
        actions: ['execute'], resource: { kind: 'tool', id: 'evolution_propose' }, context: { initiators: ['background'] },
      }),
      expect.objectContaining({
        id: 'supervised-growth-evolution-inspect-candidates',
        actions: ['inspect'], resource: { kind: 'evolution', id: 'candidates' }, context: { initiators: ['background'] },
      }),
      expect.objectContaining({
        id: 'supervised-growth-evolution-inspect-rules',
        actions: ['inspect'], resource: { kind: 'evolution', id: 'rules' }, context: { initiators: ['background'] },
      }),
      expect.objectContaining({
        id: 'supervised-growth-evolution-propose',
        actions: ['propose'], resource: { kind: 'evolution', id: 'proposals' }, context: { initiators: ['background'] },
      }),
      expect.objectContaining({
        id: 'supervised-growth-guidance-snapshot',
        actions: ['snapshot'], resource: { kind: 'evolution', id: 'guidance' }, context: { initiators: ['background'] },
      }),
    ]))
    expect(JSON.stringify(rules)).not.toMatch(/bash|pwsh|glob|grep|credential|filesystem|network/)
  })

  test('builds a complete explicit overlay from the effective DSH tree when the raw user patch is fresh', () => {
    const output = configured('[]\n', fixture)
    const parsed = rows(output)
    for (const id of [
      'dsh-enhanced-personal-assistant',
      'dsh-enhanced-assistant-delivery',
      'dsh-enhanced-lark-channel',
      'dsh-enhanced-traex-acp-provider',
      'dsh-enhanced-assistant-heartbeat',
    ]) {
      const entry = parsed.find(row => row.id === id)
      expect(entry?.config).toBeDefined()
    }
    const personal = parsed.find(row => row.id === 'dsh-enhanced-personal-assistant').config
    expect(personal.assistantPolicy.databasePath).toContain("dshHomePath('assistant-policy/policy.sqlite')")
    expect(personal.personalMemory.databasePath).toContain("dshHomePath('personal-memory/memory.sqlite')")
  })

  test('fails closed when any required effective bundle row is disabled', () => {
    const disabledEffective = fixture.replace(
      '- id: dsh-enhanced-assistant-evolution\n  config:',
      '- id: dsh-enhanced-assistant-evolution\n  disabled: true\n  config:',
    )
    expect(() => configured('[]\n', disabledEffective)).toThrow(/disabled/i)
  })

  test('reads custom local databases from the effective tree rather than assuming DSH defaults', () => {
    const custom = fixture
      .replace('/Users/test/.dsh/assistant-automations/state.sqlite', '/private/custom/automations.sqlite')
      .replace("defaultWorkspace: !!js dshHomePath('assistant-workspace')", "databasePath: /private/custom/delivery.sqlite\n    defaultWorkspace: !!js dshHomePath('assistant-workspace')")
    expect(supervisedGrowthDatabasePaths(custom, '/Users/test/.dsh')).toEqual({
      deliveryDatabasePath: '/private/custom/delivery.sqlite',
      automationsDatabasePath: '/private/custom/automations.sqlite',
    })
  })

  test('rejects an effective tree where a higher-priority layer undoes any required supervised grant', () => {
    // The raw user overlay intentionally contains no Evolution row; DSH's
    // post-compose dump contributes it from its independently installed bundle.
    const overlayRows = rows(configured('[]\n'))
    const evolutionRow = rows(fixture).find(row => row.id === 'dsh-enhanced-assistant-evolution')
    const configuredEffective = stringify([...overlayRows, evolutionRow])
    const schedulerUndone = configuredEffective.replace('schedulerEnabled: true', 'schedulerEnabled: false')
    expect(() => assertEffectiveSupervisedGrowthConfig({
      effectiveConfig: schedulerUndone,
      dshHome: '/Users/test/.dsh',
      binding,
    })).toThrow(/schedulerEnabled/i)

    const disabledTraex = configuredEffective.replace(
      '- id: dsh-enhanced-traex-acp-provider\n  config:',
      '- id: dsh-enhanced-traex-acp-provider\n  disabled: true\n  config:',
    )
    expect(() => assertEffectiveSupervisedGrowthConfig({
      effectiveConfig: disabledTraex,
      dshHome: '/Users/test/.dsh',
      binding,
    })).toThrow(/disabled/i)
  })

  test('fails closed for a binding that does not exactly match the configured Lark account, workspace, and preset', () => {
    expect(() => configureSupervisedGrowthProfilePatch({ profilePatch: fixture, effectiveConfig: fixture, dshHome: '/Users/test/.dsh', binding: {
      ...binding,
      workspace: '/Users/test/.dsh/other-workspace',
    } })).toThrow(/workspace/i)
    expect(() => configureSupervisedGrowthProfilePatch({ profilePatch: fixture, effectiveConfig: fixture, dshHome: '/Users/test/.dsh', binding: {
      ...binding,
      principal: { ...binding.principal, tenant: 'other' },
    } })).toThrow(/Lark/i)
  })
})
