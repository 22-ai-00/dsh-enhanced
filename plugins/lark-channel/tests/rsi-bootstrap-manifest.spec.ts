import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { parse, stringify } from 'yaml'
import { normalizeControlPlaneConfig, runtimeConfigDigest } from '@dsh-enhanced/plugin-control-plane'
import { normalizeConfig } from '@dsh-enhanced/assistant-growth-driver'
import { validateSourceReviewConfig } from '@dsh-enhanced/assistant-verifier'

import { prepareRsiAuthorityResources } from '../src/rsi-authority-resources.ts'
import { createRsiBootstrapManifest, type RsiBootstrapManifestInput } from '../src/rsi-bootstrap-manifest.ts'
import { compileRsiProfiles } from '../src/rsi-profile.ts'
import type { RsiAuthorityRuntime } from '../src/rsi-authority-runtime.ts'

const now = Date.now()
const owner = {
  id: 'owner-binding', conversation: { channel: 'lark', account: 'account', tenant: 'tenant', kind: 'dm' as const, chat: 'chat' },
  principal: { channel: 'lark', account: 'account', tenant: 'tenant', user: 'owner' }, workspace: '',
  agentPreset: 'primary', sessionId: 'session', generation: 3, policyRef: 'owner-policy', status: 'active' as const,
  createdAt: 1, updatedAt: 1, version: 2,
  owner: { id: 'principal-record', principal: { channel: 'lark', account: 'account', tenant: 'tenant', user: 'owner' },
    role: 'owner' as const, status: 'active' as const, createdAt: 1, updatedAt: 1, version: 2 },
}
const coordinatorBase = '- insert:\n    - id: tool-web\n      name: "@deepseek-ai/tool-web"\n    - id: agent-loop\n      name: "@deepseek-ai/agent-loop"\n'
const coordinatorEffective = [
  { id: 'dsh-enhanced-assistant-policy', name: '@dsh-enhanced/assistant-policy', config: { budgets: [], rules: [] } },
  { id: 'dsh-enhanced-assistant-automations', name: '@dsh-enhanced/assistant-automations', config: { schedulerEnabled: false, allowUnbudgetedExecution: false } },
  { id: 'dsh-enhanced-plugin-control-plane', name: '@dsh-enhanced/plugin-control-plane', config: {} },
  { id: 'tool-web', name: '@deepseek-ai/tool-web', config: {} },
]

function runtime(home: string): RsiAuthorityRuntime {
  const root = join(home, 'rsi-authority-runtimes', 'target')
  const pin = (name: string) => ({ path: join(root, name), sha256: 'a'.repeat(64) })
  return { schemaVersion: 1, packageVersion: '0.1.48', root, node: pin('node'),
    executables: { approval: pin('approval'), release: pin('release'), adoption: pin('adoption'),
      observation: pin('observation'), qualification: pin('qualification'), hostAuthority: pin('host-authority'),
      hostAttestor: pin('host-attestor') },
    releaseAdapters: { pr: pin('pr'), review: pin('review'), merge: pin('merge'), build: pin('build'),
      sign: pin('sign'), publish: pin('publish'), 'registry-verify': pin('registry-verify'),
      'catalog-admission': pin('catalog-admission') },
    processHelper: pin('process-helper'), observerClient: pin('observer-client'),
    catalogValidator: pin('catalog-validator'), catalogInterpreter: pin('catalog-interpreter') }
}

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'rsi-manifest-'))
  const home = join(root, 'home'), workspace = join(home, 'assistant-workspace')
  await mkdir(home, { mode: 0o700 })
  await mkdir(join(home, 'profiles', 'target'), { recursive: true })
  await mkdir(join(home, 'profiles', 'coordinator'), { recursive: true })
  await mkdir(join(root, 'source'), { mode: 0o700 })
  await mkdir(join(root, 'release.git'), { mode: 0o700 })
  const resources = await prepareRsiAuthorityResources({ dshHome: home, profile: 'target' })
  await writeFile(join(resources.configRoot, 'observer.key'), Buffer.alloc(32, 7), { mode: 0o600 })
  await mkdir(join(resources.stateRoot, 'review-decisions'), { mode: 0o700 })
  await chmod(join(resources.stateRoot, 'review-decisions'), 0o700)
  const active = { ...owner, workspace }
  const route = { id: 'owner-route', conversation: active.conversation, principal: active.principal,
    workspace, agentPreset: 'primary', policyRef: 'owner-policy', minimumGeneration: 2 }
  const row = (id: string, name: string, config: object) => ({ id, name, config })
  const targetEffective = stringify([
    row('dsh-enhanced-personal-assistant', '@dsh-enhanced/personal-assistant',
      { assistantPolicy: { databasePath: join(home, 'policy.sqlite'), budgets: [{ id: 'existing-global', metric: 'automation-runs', limit: 9, periodMs: 86_400_000, scope: 'global' }], rules: [] },
        assistantAutomations: { schedulerEnabled: false, allowUnbudgetedExecution: false } }),
    row('dsh-enhanced-assistant-delivery', '@dsh-enhanced/assistant-delivery',
      { defaultWorkspace: workspace, defaultAgentPreset: 'primary', ownerRoutes: [route] }),
    row('dsh-enhanced-lark-channel', '@dsh-enhanced/lark-channel', { enabled: true }),
    row('dsh-enhanced-assistant-evaluation', '@dsh-enhanced/assistant-evaluation', {}),
    row('dsh-enhanced-assistant-goals', '@dsh-enhanced/assistant-goals', {}),
    row('dsh-enhanced-assistant-health', '@dsh-enhanced/assistant-health', {}),
    row('dsh-enhanced-assistant-skills', '@dsh-enhanced/assistant-skills', {}),
    row('dsh-enhanced-assistant-verifier', '@dsh-enhanced/assistant-verifier', { databasePath: join(home, 'verifier.sqlite') }),
    row('dsh-enhanced-assistant-growth-driver', '@dsh-enhanced/assistant-growth-driver',
      { provider: 'owner-provider', model: 'owner-model', reasoningEffort: 'high' }),
    row('dsh-enhanced-plugin-control-plane', '@dsh-enhanced/plugin-control-plane', {}),
  ])
  const input: RsiBootstrapManifestInput = { dshHome: home, targetProfile: 'target', coordinatorProfile: 'coordinator',
    targetEffective, owner: active, resources, runtime: runtime(home),
    source: { schemaVersion: 1, version: '0.1.48', origin: { kind: 'local-head', locator: root, ref: 'HEAD' },
      sourceCommit: 'a'.repeat(40), repository: join(root, 'source'),
      baseline: { ref: 'refs/dsh-source/repairs', remote: join(root, 'release.git'), targetBranch: 'repairs', initialCommit: 'a'.repeat(40) } },
    sourceBuild: { dockerPath: '/usr/bin/docker', image: `fixture@sha256:${'a'.repeat(64)}`, timeoutMs: 60_000,
      memoryMiB: 128, cpus: 1, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4096, versioning: 'patch' },
    git: { path: '/usr/bin/git', sha256: 'a'.repeat(64) }, now, expiresAt: now + 30 * 86_400_000,
    plugins: ['personal-assistant', 'assistant-goals', 'assistant-health', 'assistant-growth-driver'],
    observerTargets: [{ entryId: 'dsh-enhanced-lark-channel', module: '@dsh-enhanced/lark-channel',
      configDigest: runtimeConfigDigest({ enabled: true }), services: [] }],
    hostDeploymentInputs: ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml',
      ...['personal-assistant', 'assistant-goals', 'assistant-health', 'assistant-growth-driver'].flatMap(name => [
        `node_modules/@dsh-enhanced/${name}/package.json`,
        `node_modules/@dsh-enhanced/${name}/cordis.patch.yml`,
        `node_modules/@dsh-enhanced/${name}/lib/index.js`,
      ])] }
  return { root, input }
}

describe('ordinary-use RSI manifest factory', () => {
  test('composes a real validator-accepted owner-bound two-Host profile from prepared inputs', async () => {
    const { root, input } = await fixture()
    try {
      const manifest = createRsiBootstrapManifest(input)
      expect(manifest.limits.reviews).toBe(9)
      expect(manifest.growthDriver).toMatchObject({ provider: 'owner-provider', model: 'owner-model', reasoningEffort: 'high' })
      expect(manifest.controlPlane.sourceJobs!.baseline).toEqual(input.source.baseline)
      expect(manifest.controlPlane.sourceAdoptions!.hostDeploymentInputs).toEqual(input.hostDeploymentInputs)
      expect(manifest.serviceEnvironment!.target.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG).toBe(join(input.resources.configRoot, 'host-wrapper.json'))
      expect(normalizeConfig(manifest.growthDriver).pluginSourceProposals.preparationMode).toBe('durable')
      expect(() => normalizeControlPlaneConfig(manifest.controlPlane)).not.toThrow()
      expect(() => validateSourceReviewConfig(manifest.sourceReviews)).not.toThrow()
      const compiled = await compileRsiProfiles({ manifest, dshHome: input.dshHome, targetPatch: '[]\n',
        targetEffective: input.targetEffective, coordinatorPatch: '[]\n',
        coordinatorEffective: stringify(coordinatorEffective), coordinatorBase, owner: input.owner })
      expect(compiled.targetPatch).toContain('sourceAdoptions')
      expect(compiled.coordinatorPatch).toContain('adoptionCoordinator')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('rejects ambiguous owner routes, mutable observer rows and incomplete Host inputs', async () => {
    const { root, input } = await fixture()
    try {
      const rows = parse(input.targetEffective) as Array<{ id: string; config: Record<string, any> }>
      const delivery = rows.find(row => row.id === 'dsh-enhanced-assistant-delivery')!
      delivery.config.ownerRoutes.push({ ...structuredClone(delivery.config.ownerRoutes[0]), id: 'other-route' })
      expect(() => createRsiBootstrapManifest({ ...input, targetEffective: stringify(rows) })).toThrow('no unique effective route')
      expect(() => createRsiBootstrapManifest({ ...input, observerTargets: [{ ...input.observerTargets[0]!, entryId: 'dsh-enhanced-plugin-control-plane', module: '@dsh-enhanced/plugin-control-plane', configDigest: runtimeConfigDigest({}) }] })).toThrow('stable effective Loader')
      expect(() => createRsiBootstrapManifest({ ...input, hostDeploymentInputs: input.hostDeploymentInputs.slice(0, 3) })).toThrow('does not cover installed package')
      expect(() => createRsiBootstrapManifest({ ...input, plugins: ['plugin-control-plane'] })).toThrow('protected')
      expect(() => createRsiBootstrapManifest({ ...input, plugins: ['assistant-health'] })).toThrow('scope differs from all installed')
      expect(() => createRsiBootstrapManifest({ ...input, targetEffective: input.targetEffective.replace('enabled: true', 'enabled: !!js true') })).toThrow('evaluated YAML tags')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('inherits the triggering conversation model when no fixed growth route is configured', async () => {
    const { root, input } = await fixture()
    try {
      const rows = parse(input.targetEffective) as Array<{ id: string; config: Record<string, any> }>
      rows.find(row => row.id === 'dsh-enhanced-assistant-growth-driver')!.config = {}
      const manifest = createRsiBootstrapManifest({ ...input, targetEffective: stringify(rows) })
      expect(manifest.growthDriver.provider).toBeUndefined()
      expect(manifest.growthDriver.model).toBeUndefined()
      expect(manifest.growthDriver.reasoningEffort).toBeUndefined()
      expect(manifest.sourceReviews.model).toBeUndefined()
      expect(normalizeConfig(manifest.growthDriver).provider).toBeNull()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('accepts fresh default-only plugin rows and observes missing Loader config as null', async () => {
    const { root, input } = await fixture()
    try {
      const rows = parse(input.targetEffective) as Array<{ id: string; config?: Record<string, unknown> }>
      delete rows.find(row => row.id === 'dsh-enhanced-assistant-growth-driver')!.config
      delete rows.find(row => row.id === 'dsh-enhanced-assistant-health')!.config
      const targetEffective = stringify(rows)
      const manifest = createRsiBootstrapManifest({ ...input, targetEffective,
        observerTargets: [{ entryId: 'dsh-enhanced-assistant-health', module: '@dsh-enhanced/assistant-health',
          configDigest: runtimeConfigDigest(null), services: [] }] })
      expect(manifest.growthDriver.provider).toBeUndefined()
      const compiled = await compileRsiProfiles({ manifest, dshHome: input.dshHome, targetPatch: '[]\n',
        targetEffective, coordinatorPatch: '[]\n', coordinatorEffective: stringify(coordinatorEffective),
        coordinatorBase, owner: input.owner })
      expect(compiled.targetPatch).toContain('pluginSourceProposals:')
      expect(compiled.targetPatch).toContain('preparationMode: durable')
      expect(manifest.controlPlane.runtimeObserver!.targets[0]!.configDigest).toBe(runtimeConfigDigest(null))
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
