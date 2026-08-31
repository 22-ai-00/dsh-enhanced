import { RECOVERY_CATALOG_DIGEST } from '@dsh-enhanced/assistant-recovery'
import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import {
  assertEffectiveSupervisedGrowthConfig,
  configureSupervisedGrowthProfilePatch,
  supervisedGrowthDatabasePaths,
} from '../src/supervised-growth-profile.ts'

const activationNonce = 'activation-test-nonce'

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
        - id: supervised-growth-heartbeat-execute
          effect: allow
          subject: { kind: background, id: heartbeat:supervised-growth }
          actions: [execute]
          resource: { kind: automation, id: heartbeat:supervised-growth }
          context: { initiators: [background] }
        - id: supervised-growth-evaluation-self-assess-tool
          effect: allow
          subject: { kind: agent, id: standard }
          actions: [execute]
          resource: { kind: tool, id: evaluation_self_assess }
          context: { initiators: [background] }
      budgets:
        - id: keep-user-budget
          metric: reads
          limit: 5
          periodMs: 60000
          scope: subject
        - id: supervised-growth-daily-tokens
          metric: tokens
          limit: 1000
          periodMs: 86400000
          scope: workspace
    personalMemory:
      databasePath: !!js dshHomePath('personal-memory/memory.sqlite')
    personalWiki:
      databasePath: !!js dshHomePath('personal-wiki/state.sqlite')
    assistantAutomations:
      databasePath: /Users/test/.dsh/assistant-automations/state.sqlite
      runsPath: /Users/test/.dsh/assistant-automations/runs
      schedulerEnabled: true
      toolCapableProviders: [deepseek-official]
      unknownRouteToolCalls: deny
- id: dsh-enhanced-assistant-delivery
  config:
    databasePath: /Users/test/.dsh/assistant-delivery/state.sqlite
    spoolPath: /Users/test/.dsh/assistant-delivery/spool
    defaultWorkspace: !!js dshHomePath('assistant-workspace')
    defaultAgentPreset: standard
    agentProvider: deepseek-official
    agentModel: deepseek-v4-flash
    ownerRoutes: []
    toolCapableProviders: [deepseek-official]
    unknownRouteToolCalls: deny
- id: dsh-enhanced-lark-channel
  config: { enabled: true, account: primary, tenant: personal }
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
      - id: supervised-growth
        enabled: true
        scratchPath: /Users/test/.dsh/assistant-heartbeat/supervised-growth.md
        initialScratch: legacy model prompt
        workspace: /Users/test/.dsh/assistant-workspace
        agentPreset: standard
        provider: deepseek-official
        model: deepseek-v4-flash
        timezone: Asia/Shanghai
        activeStartHour: 8
        activeEndHour: 22
        intervalMinutes: 120
        principal: lark/primary/personal/ou_owner
        allowedTools: [evaluation_review, evolution_propose]
        timeoutMs: 120000
        maxOutputTokens: 1024
        maxToolCalls: 8
        budgetId: supervised-growth-daily-runs
        budgetAmount: 1
        deliveryBindingId: binding-owner-dm
    maxScratchBytes: 2048
- id: dsh-enhanced-assistant-evolution
  config: { databasePath: /Users/test/.dsh/assistant-evolution/state.sqlite, autonomousRollback: false }
- id: dsh-enhanced-assistant-evaluation
  config: { databasePath: /Users/test/.dsh/assistant-evaluation/evaluation.sqlite }
- id: dsh-enhanced-assistant-growth-experiments
  config: { databasePath: /Users/test/.dsh/assistant-growth-experiments/growth.sqlite }
- id: dsh-enhanced-preference-learning
  config: { enabled: true, databasePath: /Users/test/.dsh/preference-learning/preferences.sqlite }
- id: dsh-enhanced-assistant-health
  config:
    requiredProviders: [assistantPolicy, personalMemory, personalWiki, assistantAutomations, assistantHeartbeat]
- id: dsh-enhanced-assistant-recovery
  config:
    databasePath: /Users/test/.dsh/assistant-recovery/recovery.sqlite
    jobs: []
    maxStepDurationMs: 10000
`

const binding = {
  id: 'binding-owner-dm',
  conversation: { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'oc_owner' },
  principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_owner' },
  workspace: '/Users/test/.dsh/assistant-workspace',
  agentPreset: 'standard',
  sessionId: 'session-owner',
  generation: 3,
  policyRef: 'owner-dm',
  status: 'active',
  createdAt: 1,
  updatedAt: 2,
  version: 4,
} as const

function configured(input: {
  profilePatch?: string
  effectiveConfig?: string
  activationState?: 'active' | 'preview'
} = {}): string {
  return configureSupervisedGrowthProfilePatch({
    profilePatch: input.profilePatch ?? fixture,
    effectiveConfig: input.effectiveConfig ?? fixture,
    dshHome: '/Users/test/.dsh',
    binding,
    activationState: input.activationState ?? 'preview',
    activationNonce,
    recoveryCatalogDigest: RECOVERY_CATALOG_DIGEST,
  })
}

function rows(output: string): any[] {
  return parse(output, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
}

function config(output: string, id: string): any {
  return rows(output).find(entry => entry.id === id)?.config
}

function assertStage(output: string, activationState: 'active' | 'preview'): void {
  expect(assertEffectiveSupervisedGrowthConfig({
    effectiveConfig: output,
    dshHome: '/Users/test/.dsh',
    binding,
    activationState,
    activationNonce,
    recoveryCatalogDigest: RECOVERY_CATALOG_DIGEST,
  })).toEqual({
    workspace: '/Users/test/.dsh/assistant-workspace',
    agentPreset: 'standard',
    activationState,
    automationId: 'recovery:supervised-growth',
  })
}

describe('supervised-growth Recovery profile patch', () => {
  test('migrates the legacy heartbeat into a scheduler-stopped preview with a paused dedicated analyst', () => {
    const once = configured()
    const twice = configured({ profilePatch: once, effectiveConfig: once })
    expect(twice).toBe(once)

    const personal = config(once, 'dsh-enhanced-personal-assistant')
    const delivery = config(once, 'dsh-enhanced-assistant-delivery')
    const heartbeat = config(once, 'dsh-enhanced-assistant-heartbeat')
    const recovery = config(once, 'dsh-enhanced-assistant-recovery')
    const health = config(once, 'dsh-enhanced-assistant-health')
    const evolution = config(once, 'dsh-enhanced-assistant-evolution')

    expect(personal.assistantAutomations).toMatchObject({ schedulerEnabled: false })
    expect(personal.assistantAutomations.toolCapableProviders).toBeUndefined()
    expect(personal.assistantAutomations.unknownRouteToolCalls).toBeUndefined()
    expect(personal.assistantPolicy.budgets).toContainEqual({
      id: 'supervised-growth-daily-runs', metric: 'automation-runs', limit: 7, periodMs: 86400000, scope: 'workspace',
    })
    expect(personal.assistantPolicy.budgets).toContainEqual({
      id: 'supervised-growth-analyst-daily-runs', metric: 'automation-runs', limit: 1,
      periodMs: 86400000, scope: 'workspace',
    })
    expect(personal.assistantPolicy.budgets).toContainEqual({
      id: 'supervised-growth-workflow-daily-runs', metric: 'automation-runs', limit: 3,
      periodMs: 86400000, scope: 'workspace',
    })
    expect(personal.assistantAutomations.proposalDefaults).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      allowedTools: [],
      timeoutMs: 60000,
      maxOutputTokens: 512,
      maxToolCalls: 0,
      misfireKind: 'latest',
      misfireLimit: 1,
      overlap: 'skip',
      retrySafety: 'never',
      maxRetries: 0,
      budgetId: 'supervised-growth-workflow-daily-runs',
      budgetAmount: 1,
    })
    expect(personal.assistantPolicy.budgets.find((value: { id: string }) => value.id === 'supervised-growth-daily-tokens'))
      .toBeUndefined()
    expect(personal.assistantPolicy.rules).toContainEqual(expect.objectContaining({ id: 'keep-user-rule' }))
    expect(delivery.ownerRoutes).toContainEqual({
      id: 'supervised-growth-owner',
      conversation: binding.conversation,
      principal: binding.principal,
      workspace: binding.workspace,
      agentPreset: binding.agentPreset,
      policyRef: binding.policyRef,
      minimumGeneration: binding.generation,
    })
    expect(heartbeat.heartbeats.find((value: { id: string }) => value.id === 'preserve-existing')).toBeDefined()
    expect(heartbeat.heartbeats.find((value: { id: string }) => value.id === 'supervised-growth')).toMatchObject({
      enabled: false,
      workspace: binding.workspace,
      agentPreset: binding.agentPreset,
      principal: 'lark/primary/personal/ou_owner',
      allowedTools: [],
    })
    expect(heartbeat.heartbeats.find((value: { id: string }) => value.id === 'supervised-growth-analyst'))
      .toEqual({
        id: 'supervised-growth-analyst',
        enabled: false,
        scratchPath: '/Users/test/.dsh/assistant-heartbeat/supervised-growth-analyst.md',
        initialScratch: expect.stringContaining('evolution_adoption_review exactly once'),
        workspace: binding.workspace,
        agentPreset: binding.agentPreset,
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        timezone: 'Asia/Shanghai',
        activeStartHour: 8,
        activeEndHour: 9,
        intervalMinutes: 60,
        principal: 'lark/primary/personal/ou_owner',
        allowedTools: ['evolution_adoption_review', 'evolution_adoption_propose'],
        timeoutMs: 120000,
        maxOutputTokens: 1024,
        maxToolCalls: 2,
        budgetId: 'supervised-growth-analyst-daily-runs',
        budgetAmount: 1,
        approvalBindingId: binding.id,
      })
    expect(recovery.jobs).toEqual([{
      id: 'supervised-growth',
      activationState: 'preview',
      activationNonce,
      catalogDigest: RECOVERY_CATALOG_DIGEST,
      workspace: binding.workspace,
      preset: binding.agentPreset,
      principal: 'lark/primary/personal/ou_owner',
      ownerRouteId: 'supervised-growth-owner',
      cron: '0 8,10,12,14,16,18,20 * * *',
      timezone: 'Asia/Shanghai',
      budgetId: 'supervised-growth-daily-runs',
      budgetAmount: 1,
    }])
    expect(health.requiredProviders).toEqual([
      'assistantPolicy', 'personalMemory', 'personalWiki', 'assistantAutomations', 'assistantHeartbeat',
      'assistantEvaluation', 'preferenceLearning', 'assistantEvolution', 'assistantGrowthExperiments',
      'assistantDelivery', 'assistantRecovery', 'larkChannel',
    ])
    expect(evolution.autonomousRollback).toBe(true)

    const managed = personal.assistantPolicy.rules
      .filter((rule: { id: string }) => rule.id.startsWith('supervised-growth-'))
    expect(managed).toContainEqual({
      id: 'supervised-growth-incident-delivery', effect: 'allow',
      subject: {
        kind: 'background', id: 'assistant-automations-incidents',
        workspace: binding.workspace, principal: 'lark/primary/personal/ou_owner',
      },
      actions: ['send'], resource: { kind: 'message', id: 'route:supervised-growth-owner' },
      context: { initiators: ['background'] },
    })
    expect(managed).toContainEqual({
      id: 'supervised-growth-agent-incident-delivery', effect: 'allow',
      subject: {
        kind: 'background', id: 'assistant-automations-incidents',
        workspace: binding.workspace, principal: 'lark/primary/personal/ou_owner',
      },
      actions: ['send'], resource: { kind: 'message', id: binding.id },
      context: { initiators: ['background'] },
    })
    expect(managed).toContainEqual(expect.objectContaining({
      id: 'supervised-growth-workflow-template-inspect',
      actions: ['inspect'], resource: { kind: 'evolution', id: 'workflow-template:*' },
    }))
    expect(managed).toContainEqual(expect.objectContaining({
      id: 'supervised-growth-workflow-approval-delivery',
      actions: ['approval.send'], resource: { kind: 'message', id: binding.id },
    }))
    expect(managed).toContainEqual(expect.objectContaining({
      id: 'supervised-growth-workflow-execute',
      subject: expect.objectContaining({ id: 'workflow-growth:*' }),
      actions: ['execute'], resource: { kind: 'automation', id: 'workflow-growth:*' },
    }))
    expect(managed).toContainEqual(expect.objectContaining({
      id: 'supervised-growth-workflow-delivery',
      subject: expect.objectContaining({ id: 'workflow-growth:*' }),
      actions: ['send'], resource: { kind: 'message', id: binding.id },
    }))
    expect(managed).toContainEqual(expect.objectContaining({
      id: 'supervised-growth-recovery-preview',
      actions: ['run-dry'],
      resource: { kind: 'automation', id: 'recovery:supervised-growth' },
    }))
    expect(managed).toContainEqual(expect.objectContaining({
      id: 'supervised-growth-legacy-heartbeat-pause',
      actions: ['reconcile'],
      resource: { kind: 'automation', id: 'heartbeat:supervised-growth' },
    }))
    const backgroundModelGrants = managed.filter((rule: any) => rule.context?.initiators?.includes('background')
      && (rule.resource?.kind === 'memory'
        || rule.actions?.includes('history')
        || (rule.resource?.kind === 'tool' && rule.resource.id !== 'assistant-health:global')))
    expect(backgroundModelGrants.map((rule: { id: string }) => rule.id).sort()).toEqual([
      'supervised-growth-analyst-evolution-adoption-propose-tool',
      'supervised-growth-analyst-evolution-adoption-review-tool',
    ])
    expect(managed).toContainEqual(expect.objectContaining({
      id: 'supervised-growth-analyst-execute',
      subject: expect.objectContaining({ id: 'heartbeat:supervised-growth-analyst' }),
      actions: ['execute'],
      resource: { kind: 'automation', id: 'heartbeat:supervised-growth-analyst' },
    }))
    expect(managed).toContainEqual(expect.objectContaining({
      id: 'supervised-growth-analyst-evolution-review',
      actions: ['inspect'], resource: { kind: 'evolution', id: 'analyst-adoption' },
    }))
    expect(managed).toContainEqual(expect.objectContaining({
      id: 'supervised-growth-analyst-evolution-propose',
      actions: ['propose'], resource: { kind: 'evolution', id: 'proposals' },
    }))
    for (const id of [
      'supervised-growth-owner-evolution-review-tool',
      'supervised-growth-owner-evolution-propose-tool',
      'supervised-growth-owner-evolution-rollback-tool',
      'supervised-growth-owner-evolution-undo-tool',
    ]) {
      expect(managed).toContainEqual(expect.objectContaining({
        id, context: { initiators: ['external', 'foreground'] },
      }))
    }
    assertStage(once, 'preview')
  })

  test('promotes the exact same nonce and catalog plan while enabling the scheduler only in active', () => {
    const preview = configured()
    const active = configured({ profilePatch: preview, effectiveConfig: preview, activationState: 'active' })
    expect(config(active, 'dsh-enhanced-personal-assistant').assistantAutomations.schedulerEnabled).toBe(true)
    expect(config(active, 'dsh-enhanced-assistant-recovery').jobs[0]).toMatchObject({
      activationState: 'active', activationNonce, catalogDigest: RECOVERY_CATALOG_DIGEST,
    })
    expect(config(active, 'dsh-enhanced-assistant-heartbeat').heartbeats
      .find((value: { id: string }) => value.id === 'supervised-growth').enabled).toBe(false)
    expect(config(active, 'dsh-enhanced-assistant-heartbeat').heartbeats
      .find((value: { id: string }) => value.id === 'supervised-growth-analyst')).toMatchObject({
        enabled: true,
        approvalBindingId: binding.id,
      })
    assertStage(active, 'active')
  })

  test('fails closed when a supervised install omitted its required analyst Heartbeat provider', () => {
    const freshEffective = rows(fixture).filter(entry => entry.id !== 'dsh-enhanced-assistant-heartbeat')
    const yaml = JSON.stringify(freshEffective)
    expect(() => configured({ profilePatch: '[]\n', effectiveConfig: yaml })).toThrow(/assistant-heartbeat.*missing/i)
  })

  test('keeps Heartbeat health required even when the analyst is the only enabled Heartbeat', () => {
    const onlyLegacy = fixture.replace(`      - id: preserve-existing
        enabled: false
        scratchPath: /Users/test/.dsh/assistant-heartbeat/existing.md
        workspace: /Users/test/.dsh/assistant-workspace
        agentPreset: standard
        provider: deepseek-official
        model: deepseek-v4-flash
        timezone: Asia/Shanghai
        principal: lark/primary/personal/ou_owner
`, '')
    const output = configured({ profilePatch: '[]\n', effectiveConfig: onlyLegacy })
    expect(config(output, 'dsh-enhanced-assistant-health').requiredProviders).toContain('assistantHeartbeat')
    expect(config(configured(), 'dsh-enhanced-assistant-health').requiredProviders).toContain('assistantHeartbeat')
  })

  test('reads all three guarded local databases from the effective tree', () => {
    expect(supervisedGrowthDatabasePaths(fixture, '/Users/test/.dsh')).toEqual({
      deliveryDatabasePath: '/Users/test/.dsh/assistant-delivery/state.sqlite',
      automationsDatabasePath: '/Users/test/.dsh/assistant-automations/state.sqlite',
      recoveryDatabasePath: '/Users/test/.dsh/assistant-recovery/recovery.sqlite',
    })
  })

  test.each([
    'assistant-evolution', 'assistant-evaluation', 'assistant-growth-experiments', 'preference-learning',
    'assistant-health', 'assistant-recovery',
  ])('fails closed when required effective %s is disabled', plugin => {
    const id = `dsh-enhanced-${plugin}`
    const disabled = fixture.replace(`- id: ${id}\n  config:`, `- id: ${id}\n  disabled: true\n  config:`)
    expect(() => configured({ profilePatch: '[]\n', effectiveConfig: disabled })).toThrow(/disabled/i)
  })

  test('fails closed if an upgrade has a durable legacy profile but its Heartbeat bundle is disabled', () => {
    const disabled = fixture.replace(
      '- id: dsh-enhanced-assistant-heartbeat\n  config:',
      '- id: dsh-enhanced-assistant-heartbeat\n  disabled: true\n  config:',
    )
    expect(() => configured({ profilePatch: '[]\n', effectiveConfig: disabled })).toThrow(/heartbeat.*disabled/i)
  })

  test('rejects higher-priority drift in scheduler, job, owner route, health, or incident delivery', () => {
    const active = configured({ activationState: 'active' })
    const assertion = (effectiveConfig: string) => assertEffectiveSupervisedGrowthConfig({
      effectiveConfig,
      dshHome: '/Users/test/.dsh',
      binding,
      activationState: 'active',
      activationNonce,
      recoveryCatalogDigest: RECOVERY_CATALOG_DIGEST,
    })
    expect(() => assertion(active.replace('schedulerEnabled: true', 'schedulerEnabled: false'))).toThrow(/schedulerEnabled/i)
    expect(() => assertion(active.replace('activationState: active', 'activationState: preview'))).toThrow(/Recovery job/i)
    expect(() => assertion(active.replace('minimumGeneration: 3', 'minimumGeneration: 2'))).toThrow(/owner route/i)
    expect(() => assertion(active.replace('  - assistantRecovery\n', ''))).toThrow(/requiredProviders/i)
    expect(() => assertion(active.replace('route:supervised-growth-owner', 'route:wrong-owner'))).toThrow(/incident-delivery/i)
    expect(() => assertion(active.replace(
      /(id: supervised-growth\n\s+)enabled: false/u,
      '$1enabled: true',
    ))).toThrow(/heartbeat/i)
  })

  test('rejects stale catalog input and a mismatched binding scope', () => {
    expect(() => configureSupervisedGrowthProfilePatch({
      profilePatch: '[]\n', effectiveConfig: fixture, dshHome: '/Users/test/.dsh', binding,
      activationState: 'preview', activationNonce, recoveryCatalogDigest: 'bad',
    })).toThrow(/catalog digest/i)
    expect(() => configureSupervisedGrowthProfilePatch({
      profilePatch: '[]\n', effectiveConfig: fixture, dshHome: '/Users/test/.dsh',
      binding: { ...binding, workspace: '/Users/test/.dsh/other' },
      activationState: 'preview', activationNonce, recoveryCatalogDigest: RECOVERY_CATALOG_DIGEST,
    })).toThrow(/workspace/i)
  })
})
