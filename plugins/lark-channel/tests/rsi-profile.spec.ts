import { describe, expect, test } from 'vitest'
import { ownerRouteAuthorityHash } from '@dsh-enhanced/assistant-delivery'
import { Config as PolicyConfig } from '@dsh-enhanced/assistant-policy'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { Context } from '@deepseek-ai/cordis'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { compileRsiProfiles, type RsiSetupManifest } from '../src/rsi-profile.ts'

const rows = (extra: string) => `
- id: dsh-enhanced-personal-assistant
  config:
    assistantPolicy: { databasePath: !!js dshHomePath('policy.sqlite'), budgets: [], rules: [] }
    assistantAutomations: { schedulerEnabled: false, allowUnbudgetedExecution: false }
- id: dsh-enhanced-assistant-delivery
  config:
    defaultWorkspace: /tmp/rsi-workspace
    defaultAgentPreset: primary
    ownerRoutes:
      - id: owner-route
        conversation: { channel: lark, account: account, tenant: tenant, kind: dm, chat: chat }
        principal: { channel: lark, account: account, tenant: tenant, user: owner }
        workspace: /tmp/rsi-workspace
        agentPreset: primary
        policyRef: owner-policy
        minimumGeneration: 1
- id: dsh-enhanced-lark-channel
  config: { enabled: true }
- id: dsh-enhanced-assistant-evaluation
  config: {}
- id: dsh-enhanced-assistant-goals
  config: {}
- id: dsh-enhanced-assistant-skills
  config: {}
- id: dsh-enhanced-assistant-verifier
  config: { databasePath: /tmp/verifier.sqlite }
- id: dsh-enhanced-assistant-growth-driver
  config: {}
- id: dsh-enhanced-plugin-control-plane
  config: {}
${extra}`

const owner = {
  id: 'binding', conversation: { channel: 'lark', account: 'account', tenant: 'tenant', kind: 'dm' as const, chat: 'chat' },
  principal: { channel: 'lark', account: 'account', tenant: 'tenant', user: 'owner' }, workspace: '/tmp/rsi-workspace',
  agentPreset: 'primary', sessionId: 'session', generation: 1, policyRef: 'owner-policy', status: 'active' as const,
  createdAt: 1, updatedAt: 1, version: 1,
  owner: { id: 'principal-record', principal: { channel: 'lark', account: 'account', tenant: 'tenant', user: 'owner' }, role: 'owner' as const, status: 'active' as const, createdAt: 1, updatedAt: 1, version: 1 },
}

const manifest = (): RsiSetupManifest => ({ schemaVersion: 1, targetProfile: 'target', coordinatorProfile: 'coordinator',
  controlPlane: { catalogPath: '/tmp/catalog.json', statePath: '/tmp/state', trustPath: '/tmp/trust.json',
    sourceJobs: { authorityId: 'authority', expiresAt: Date.now() + 60_000, maxSubmissions: 1, repository: '/tmp/repository', ownerRouteId: 'owner-route', principalId: 'lark/account/tenant/owner', workspace: '/tmp/rsi-workspace', preset: 'primary', budgetId: 'source', budgetAmount: 1 } },
  growthDriver: { enabled: true, intervalMs: 0, budgetId: 'review', budgetAmount: 1, scope: { workspace: '/tmp/rsi-workspace', preset: 'primary', principalId: 'lark/account/tenant/owner', ownerRouteId: 'owner-route' }, usageLearning: { enabled: true, databasePath: '/tmp/growth.sqlite', scanBudgetId: 'discovery', scanBudgetAmount: 1 }, pluginSourceProposals: { enabled: true, preparationMode: 'durable', repository: '/tmp/repository', offline: true } },
  sourceReviews: { authorityId: 'review', expiresAt: Date.now() + 60_000, maxReviews: 1, repository: '/tmp/repository', git: { path: '/tmp/git', sha256: 'a'.repeat(64) }, decisionRoot: '/not-a-private-existing-directory', plugins: ['lark-channel'], owner: { authorityId: 'authority', authorityHash: ownerRouteAuthorityHash({ id: 'owner-route', conversation: owner.conversation, principal: owner.principal, workspace: owner.workspace, agentPreset: owner.agentPreset, policyRef: owner.policyRef, minimumGeneration: 1 }), principalId: 'lark/account/tenant/owner', principalRecordId: 'principal-record', principalVersion: 1, workspace: '/tmp/rsi-workspace', agentPreset: 'primary' }, reviewerPrincipal: 'reviewer', policy: 'independent', maxChangedFiles: 1, maxInputBytes: 4096, maxOutputTokens: 1, timeoutMs: 1000 },
  coordinator: { budgetId: 'coordinator', budgetAmount: 1, timeoutMs: 1000 }, limits: { periodMs: 60_000, reviews: 1, discovery: 1, source: 1, observations: 1, coordinator: 1 },
})
const coordinatorBase = `
- insert:
    - id: tool-web
      name: '@deepseek-ai/tool-web'
    - id: agent-loop
      name: '@deepseek-ai/agent-loop'
`

describe('RSI profile compiler', () => {
  test('uses the real source-review validator before it can compose an invalid deployment', async () => {
    await expect(compileRsiProfiles({ manifest: manifest(), dshHome: '/tmp', targetPatch: '[]', targetEffective: rows(''), coordinatorPatch: '[]',
      coordinatorEffective: '- id: dsh-enhanced-assistant-policy\n  name: "@dsh-enhanced/assistant-policy"\n  config: { budgets: [], rules: [] }\n- id: dsh-enhanced-assistant-automations\n  name: "@dsh-enhanced/assistant-automations"\n  config: { schedulerEnabled: false, allowUnbudgetedExecution: false }\n- id: dsh-enhanced-plugin-control-plane\n  name: "@dsh-enhanced/plugin-control-plane"\n  config: {}\n', coordinatorBase, owner })).rejects.toThrow('ENOENT')
  })

  test('compiles a complete two Host deployment deterministically and retains tagged effective values', async () => {
    // macOS 上 os.tmpdir() 经 /var → /private/var 符号链接；privateRoot 有
    // canonical 校验，夹具须先 realpath。
    const root = await mkdtemp(join(await realpath(tmpdir()), 'rsi-profile-'))
    try {
      const home = join(root, 'home'), profilePath = join(home, 'profiles', 'target'), privateRoot = join(root, 'private')
      await mkdir(profilePath, { recursive: true }); await mkdir(privateRoot, { recursive: true }); await chmod(privateRoot, 0o700)
      const key = join(privateRoot, 'observer.key'); await writeFile(key, Buffer.alloc(32, 1), { mode: 0o600 }); await chmod(key, 0o600)
      const decision = join(root, 'decisions'); await mkdir(decision); await chmod(decision, 0o700)
      const adapter = { executable: { path: join(root, 'adapter'), sha256: 'b'.repeat(64) }, configPath: join(root, 'adapter.json'), timeoutMs: 1000 }
      const value = manifest(); const scope = { ownerRouteId: 'owner-route', principalId: 'lark/account/tenant/owner', workspace: '/tmp/rsi-workspace', preset: 'primary' }
      value.controlPlane = { catalogPath: join(root, 'catalog.json'), statePath: join(root, 'state'), trustPath: join(root, 'trust.json'),
        sourceBuild: { dockerPath: '/usr/bin/docker', image: `fixture@sha256:${'a'.repeat(64)}`, timeoutMs: 60_000, memoryMiB: 128, cpus: 1, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4096, versioning: 'patch' },
        sourceJobs: { ...value.controlPlane.sourceJobs!, repository: root }, sourceApprovals: adapter, sourceReleases: adapter,
        sourceReleaseExecution: { reviewDecisionRoot: decision, timeoutMs: 1000, independentReview: true }, sourceAdoptions: { profile: 'target', planTtlMs: 60_000, timeoutMs: 1000, authority: adapter, handoff: { schemaVersion: 1, coordinatorId: 'coordinator', maximumWindowMs: 1000, commit: 'target-host' } },
        runtimeObserver: { socketPath: join(privateRoot, 'observer.sock'), keyPath: key, profilePath, targets: [{ entryId: 'control', module: '@dsh-enhanced/plugin-control-plane', configDigest: 'c'.repeat(64), services: [] }] }, foregroundDeployments: { attestorJournalPath: join(root, 'attestor.json') },
        taskObservations: { policy: { id: 'observation', expiresAt: Date.now() + 60_000, maximumObservations: 1, minimumChecks: 1, maximumChecks: 1, lookbackMs: 1000 }, scope, profilePath, timeoutMs: 1000, budgetId: 'observations', budgetAmount: 1, authority: adapter },
      }
      value.sourceReviews = { ...value.sourceReviews, repository: join(root, 'review-remote'), git: { path: join(root, 'git'), sha256: 'a'.repeat(64) }, decisionRoot: decision }
      value.growthDriver = { ...value.growthDriver, pluginSourceProposals: { ...value.growthDriver.pluginSourceProposals!, repository: root } }
      const targetEffective = rows('').replace('/tmp/rsi-workspace', join(root, 'workspace')).replaceAll('/tmp/rsi-workspace', join(root, 'workspace'))
      const adjustedOwner = { ...owner, workspace: join(root, 'workspace'), conversation: owner.conversation, principal: owner.principal }
      ;(value.controlPlane.sourceJobs as any).workspace = adjustedOwner.workspace
      ;(value.growthDriver.scope as any).workspace = adjustedOwner.workspace
      ;(value.sourceReviews.owner as any).workspace = adjustedOwner.workspace
      ;(value.controlPlane.taskObservations as any).scope.workspace = adjustedOwner.workspace
      const hash = ownerRouteAuthorityHash({ id: 'owner-route', conversation: adjustedOwner.conversation, principal: adjustedOwner.principal, workspace: adjustedOwner.workspace, agentPreset: 'primary', policyRef: 'owner-policy', minimumGeneration: 1 })
      ;(value.sourceReviews.owner as any).authorityHash = hash
      const coordinatorEffective = '- id: dsh-enhanced-assistant-policy\n  name: "@dsh-enhanced/assistant-policy"\n  config: { databasePath: !!js dshHomePath(\'old.sqlite\'), budgets: [], rules: [] }\n- id: dsh-enhanced-assistant-automations\n  name: "@dsh-enhanced/assistant-automations"\n  config: { databasePath: !!js dshHomePath(\'old-auto.sqlite\'), runsPath: !!js dshHomePath(\'old-runs\'), schedulerEnabled: false, allowUnbudgetedExecution: false }\n- id: dsh-enhanced-plugin-control-plane\n  name: "@dsh-enhanced/plugin-control-plane"\n  config: {}\n- id: tool-web\n  name: "@deepseek-ai/tool-web"\n  config: {}\n'
      const input = { manifest: value, dshHome: home, targetPatch: '[]\n', targetEffective, coordinatorPatch: '[]\n', coordinatorEffective, coordinatorBase, owner: adjustedOwner }
      const first = await compileRsiProfiles(input)
      const second = await compileRsiProfiles({ ...input, targetPatch: first.targetPatch, coordinatorPatch: first.coordinatorPatch })
      expect(second).toEqual(first)
      expect(first.targetPatch).toContain('!!js dshHomePath')
      const target = parse(first.targetPatch) as Array<{ id: string; config: any }>
      expect(target.find(row => row.id === 'dsh-enhanced-plugin-control-plane')!.config.sourceBuild.versioning).toBe('patch')
      expect(first.coordinatorPatch).toContain(join(home, 'rsi-coordinators', 'coordinator', 'runs'))
      // The generated rules are accepted by the real Policy schema, rather
      // than merely looking structurally plausible in YAML.
      expect(() => PolicyConfig(target.find(row => row.id === 'dsh-enhanced-personal-assistant')!.config.assistantPolicy)).not.toThrow()
      const policyConfig = { ...target.find(row => row.id === 'dsh-enhanced-personal-assistant')!.config.assistantPolicy, databasePath: join(root, 'policy.sqlite') }
      const policy = new AssistantPolicyService(new Context(), policyConfig)
      expect(policy.evaluate({ subject: { kind: 'background', id: 'source-job-123', workspace: adjustedOwner.workspace, principal: 'lark/account/tenant/owner' }, action: 'execute', resource: { kind: 'automation', id: 'source-job-123' }, context: { initiator: 'background' } }).effect).toBe('allow')

      await expect(compileRsiProfiles({ ...input, owner: { ...adjustedOwner, generation: 0 } })).rejects.toThrow('minimumGeneration')
      const wrongScope = structuredClone(value); wrongScope.controlPlane.sourceJobs!.principalId = 'another-owner'
      await expect(compileRsiProfiles({ ...input, manifest: wrongScope })).rejects.toThrow('sourceJobs')
      await expect(compileRsiProfiles({ ...input, coordinatorEffective: `${coordinatorEffective}- id: dsh-enhanced-web-owner\n  name: "@dsh-enhanced/web-owner"\n  config: {}\n` })).rejects.toThrow('forbidden row')
      await expect(compileRsiProfiles({ ...input, coordinatorEffective: coordinatorEffective.replace('@deepseek-ai/tool-web', '@evil/tool-web') })).rejects.toThrow('forbidden row')
      await expect(compileRsiProfiles({ ...input, coordinatorEffective: `${coordinatorEffective}- id: custom-ingress\n  name: "@owner/custom-ingress"\n  config: {}\n` })).rejects.toThrow('forbidden row')
      await expect(compileRsiProfiles({ ...input, coordinatorEffective: `${coordinatorEffective}- id: agent-loop\n  name: "@deepseek-ai/agent-loop"\n  config: { agents: [{ id: unexpected }] }\n` })).rejects.toThrow('agent-loop.agents')
      const repeatedBudget = structuredClone(value); repeatedBudget.coordinator.budgetId = 'review'
      await expect(compileRsiProfiles({ ...input, manifest: repeatedBudget })).rejects.toThrow('budget ids')
      await expect(compileRsiProfiles({ ...input, targetEffective: targetEffective.replace('budgets: []', 'budgets: [{ id: conflicting-global, metric: automation-runs, limit: 2, periodMs: 60000, scope: global }]') })).rejects.toThrow('global automation-runs budget conflicts')
      const fixed = structuredClone(value); fixed.growthDriver.provider = 'super-relay'; fixed.growthDriver.model = 'day1'; fixed.growthDriver.reasoningEffort = 'high'
      const fixedOutput = await compileRsiProfiles({ ...input, manifest: fixed })
      const fixedRows = parse(fixedOutput.targetPatch) as Array<{ id: string; config: any }>
      expect(fixedRows.find(row => row.id === 'dsh-enhanced-assistant-growth-driver')!.config).toMatchObject({ provider: 'super-relay', model: 'day1', reasoningEffort: 'high' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
