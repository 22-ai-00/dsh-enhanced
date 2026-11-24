import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse, stringify } from 'yaml'
import { runtimeConfigDigest } from '@dsh-enhanced/plugin-control-plane'
import { growthObjectDigest } from '@dsh-enhanced/assistant-growth-contract'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { assertRsiMemoryScanActivation, installRsiOwnerDeployment, preflightRsiOwnerReadiness, RsiOwnerPreflightUnavailableError, rsiCoordinatorProfile, rsiInstallPorts, type RsiInstallPorts } from '../src/rsi-install.js'
import { rsiSetupPorts } from '../src/rsi-setup.js'
import { collectRsiInstalledInputs, RsiInstalledInputsUnavailableError } from '../src/rsi-install-inputs.js'
import { applySelfIterationProfileToggle } from '../src/service.js'
import { LinuxRsiRuntimeUnavailableError } from '../src/rsi-linux-runtime-bootstrap.js'
import { linuxRuntimeDigest } from '@dsh-enhanced/assistant-isolation'
import { rsiBootstrapFixture } from './fixtures/rsi-bootstrap.js'
import { nativePreparedFixture } from './fixtures/rsi-linux-install.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })
async function fixture() {
  const f = await rsiBootstrapFixture(); cleanups.push(f.cleanup)
  const home = f.input.resources.root.split('/rsi-authorities/')[0]!, profile = 'target'
  const coordinator = rsiCoordinatorProfile(profile)
  await rename(join(home,'profiles','coordinator'),join(home,'profiles',coordinator))
  for (const name of [profile,coordinator]) await writeFile(join(home,'profiles',name,'cordis.patch.yml'),'[]\n',{mode:0o600})
  const starts: string[] = [], stops: string[] = []
  const unitProperties = f.input.unitProperties
  const originals: Record<string,string> = { [profile]: f.profiles.targetEffective, [coordinator]: f.profiles.coordinatorEffective }
  // Only the external DSH/systemd transports are replaced. Real profile compiler,
  // lock, resource preparation, authority validators and setup journal are used.
  const patches: Record<string,string> = { [profile]: '[]\n', [coordinator]: '[]\n' }
  const dump = (name: string) => {
    const base = parse(originals[name]!) as Array<{id:string;config?:unknown}>
    const overrides = parse(patches[name]!) as Array<{id:string;config?:unknown}>
    return stringify(base.map(row => ({ ...row, ...overrides.find(item => item.id === row.id) })))
  }
  const setup = { ...rsiSetupPorts,
    dump: vi.fn(dump), base: vi.fn(async () => f.profiles.coordinatorBase),
    snapshot: vi.fn(async () => ({bindings:[f.binding],storageDigest:stops.length ? 'stopped' : 'running'} as unknown as Awaited<ReturnType<typeof rsiSetupPorts.snapshot>>)),
    automationInventory: vi.fn(async (effective: string) => {
      const rows = parse(effective) as Array<{id:string;config:Record<string,any>}>
      const config = rows.find(row => row.id === 'dsh-enhanced-assistant-automations')?.config
        ?? rows.find(row => row.id === 'dsh-enhanced-personal-assistant')!.config.assistantAutomations
      return {databasePath:config.databasePath ?? join(home,'automations.sqlite'),schedulerEnabled:config.schedulerEnabled === true,records:[]}
    }),
    assertStopped: vi.fn(), start: vi.fn(async (name: string) => { starts.push(name) }),
    serviceUnitPath: (name: string) => join(home,'units',`${name}.service`),
    renderServiceUnit: vi.fn(async (name:string,_home:string,environment:Record<string,string>) => JSON.stringify({name,environment})),
    reloadServices: vi.fn(), validateServiceUnits: vi.fn(async () => {}),
  }
  // Refresh only at DSH composition boundaries, as the real CLI would do.
  const actualCompile = setup.compile
  setup.compile = async value => { const result = await actualCompile(value); return result }
  const native = await nativePreparedFixture(f.input.resources, f.input.source)
  const release = { schemaVersion: 2 as const, backend: 'linux-native' as const,
    sourceCommit: f.input.source.sourceCommit, runtimeDigest: linuxRuntimeDigest(native.repository.runtime),
    releaseBuild: f.input.releaseBuild }
  const ports: RsiInstallPorts = { ...rsiInstallPorts, setup,
    prepare: vi.fn(async () => ({ source:f.input.source, runtime:f.input.runtime,resources:f.input.resources,
      build:{ sourceBuild: native.sourceBuild }, creationBuild: native.creationBuild,
      runnerStates: native.runnerStates, release })),
    collect: vi.fn(async value => ({ dsh:{root:'/fixture/dsh',path:f.input.executor.path,version:f.input.executor.version,pin:f.input.executor},
      executor:f.input.executor,git:f.input.manifest.sourceReviews.git,systemctl:f.input.systemctl,
      plugins:[...f.input.manifest.sourceReviews.plugins],policies:f.input.policies,
      observerTargets:f.input.manifest.controlPlane.runtimeObserver!.targets.filter(target => ![
        'dsh-enhanced-assistant-growth-driver', 'dsh-enhanced-assistant-verifier',
        'dsh-enhanced-personal-assistant', 'dsh-enhanced-assistant-memory-learning',
      ].includes(target.entryId))
        .map(target => target.entryId === 'dsh-enhanced-assistant-delivery' ? {...target,
          configDigest:runtimeConfigDigest((parse(value.targetEffective) as Array<{id:string;config:unknown}>).find(row => row.id === target.entryId)!.config)} : target),
      hostDeploymentInputs:[...f.input.manifest.controlPlane.sourceAdoptions!.hostDeploymentInputs!] })),
    coordinator: vi.fn(async () => {}),
    // Shape-only fixture descriptors never touch /sys/fs/cgroup, so the real
    // file-system probe is replaced while every other preflight stage stays real.
    preflight: value => preflightRsiOwnerReadiness({ ...value, cgroupRootsProbe: async () => {} }),
    stop: vi.fn(async (_input,name) => { stops.push(name); return true }),
    capture: vi.fn(async () => unitProperties), readUnit: vi.fn(async () => unitProperties),
    ready: vi.fn(async () => {}),
  }
  // The synchronous dump port reads current profile bytes just like dsh --dump-config.
  const { readFileSync } = await import('node:fs')
  setup.dump = vi.fn(name => { patches[name] = readFileSync(join(home,'profiles',name,'cordis.patch.yml'),'utf8'); return dump(name) })
  return {f,home,profile,coordinator,ports,starts,stops,originals,input:{dshHome:home,profile}}
}

const hashTree = async (root: string): Promise<string> => {
  const hash = createHash('sha256')
  const visit = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const entryPath = join(dir, entry.name)
      hash.update(entryPath.slice(root.length) + '\0')
      if (entry.isDirectory()) await visit(entryPath)
      else hash.update((await readFile(entryPath)).toString('base64') + '\0')
    }
  }
  await visit(root)
  return hash.digest('hex')
}

describe('owner readiness preflight', () => {
  async function preflightFixture() {
    // /private/tmp keeps the observer socket short enough for sun_path even
    // under the macOS temporary-directory prefix.
    const root = await realpath(await mkdtemp(join(await realpath('/tmp'), 'rsi-pf-'))); cleanups.push(async () => rm(root, { recursive: true, force: true }))
    const pin = async (path: string) => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex'), interpreter: null as null })
    const bindir = join(root, 'fake-bin'); await mkdir(bindir, { recursive: true, mode: 0o700 })
    const bwrap = join(bindir, 'bwrap'), tar = join(bindir, 'tar')
    await writeFile(bwrap, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); await writeFile(tar, 'tar fixture\n', { mode: 0o755 })
    // Delegated cgroup roots are real directories here; production reads the
    // /sys/fs/cgroup delegated trees that the installer prepared.
    const cgroup = join(root, 'cgroup')
    const roots = { cpu: join(cgroup, 'cpu'), memory: join(cgroup, 'memory'), pids: join(cgroup, 'pids'), freezer: join(cgroup, 'freezer') }
    for (const rootPath of Object.values(roots)) await mkdir(rootPath, { recursive: true, mode: 0o700 })
    const authorityRoot = join(root, 'rsi-authorities', 'target')
    const state = join(authorityRoot, 'state'), configRoot = join(authorityRoot, 'config')
    await mkdir(state, { recursive: true, mode: 0o700 }); await mkdir(configRoot, { recursive: true, mode: 0o700 })
    const profiles = join(root, 'profiles')
    for (const name of ['target', 'coordinator']) await mkdir(join(profiles, name), { recursive: true, mode: 0o700 })
    const value = {
      input: { dshHome: root }, prepared: {
        release: { releaseBuild: { sandboxExecutable: await pin(bwrap), tarExecutable: await pin(tar) } },
        build: { sourceBuild: { cgroupRoots: { mode: 'v1' as const, ...roots } } } },
      // A fresh install has no installed release policies yet.
      installed: { systemctl: await pin(await realpath('/usr/bin/true')), policies: [] },
      manifest: { schemaVersion: 1, targetProfile: 'target', coordinatorProfile: 'coordinator',
        sourceReviews: { decisionRoot: join(state, 'review-decisions') },
        growthDriver: { enabled: true, budgetId: 'growth-budget', usageLearning: {} }, limits: {},
        controlPlane: { sourceJobs: { budgetId: 'jobs-budget', ownerRouteId: 'owner-route' },
          sourceBuild: {}, sourceAdoptions: {}, taskObservations: {},
          sourceReleaseExecution: { reviewDecisionRoot: join(state, 'review-decisions') },
          runtimeObserver: { socketPath: join(state, 'observer.sock'), keyPath: join(configRoot, 'observer.key'),
            profilePath: join(profiles, 'target') } } },
      binding: {}, profiles: { targetPatch: 'x', targetEffective: 'x', coordinatorPatch: 'y', coordinatorEffective: 'y', coordinatorBase: '[]' },
      signal: new AbortController().signal }
    return { root, bwrap, tar, cgroup, roots, value, pin }
  }
  test('maps each readiness gap to a readable stage', async () => {
    const f = await preflightFixture()
    await expect(preflightRsiOwnerReadiness({ ...f.value,
      installed: { systemctl: await f.pin(await realpath('/usr/bin/false')), policies: [] } } as never))
      .rejects.toMatchObject({ stage: 'service-manager' })
    // Release-pinned tools are checked by exact pinned path, executable mode and
    // content digest, never by a PATH lookup.
    await rm(f.tar)
    await expect(preflightRsiOwnerReadiness(f.value as never)).rejects.toMatchObject({ stage: 'tool-pin' })
    await writeFile(f.tar, 'tar fixture\n', { mode: 0o755 })
    await writeFile(f.tar, 'tampered\n', { mode: 0o755 })
    await expect(preflightRsiOwnerReadiness(f.value as never)).rejects.toMatchObject({ stage: 'tool-pin' })
    await writeFile(f.tar, 'tar fixture\n', { mode: 0o755 })
    // The four delegated roots must still be existing, readable directories.
    await rm(f.roots.pids, { recursive: true, force: true })
    await expect(preflightRsiOwnerReadiness(f.value as never)).rejects.toMatchObject({ stage: 'cgroup' })
    await mkdir(f.roots.pids, { recursive: true, mode: 0o700 })
    await chmod(f.roots.freezer, 0o000)
    try {
      await expect(preflightRsiOwnerReadiness(f.value as never)).rejects.toMatchObject({ stage: 'cgroup' })
    } finally { await chmod(f.roots.freezer, 0o700) }
    await expect(preflightRsiOwnerReadiness({ ...f.value,
      prepared: { ...f.value.prepared, build: { sourceBuild: { cgroupRoots: { ...f.value.prepared.build.sourceBuild.cgroupRoots, mode: 'v2' } } } } } as never))
      .rejects.toMatchObject({ stage: 'cgroup' })
    await expect(preflightRsiOwnerReadiness({ ...f.value,
      prepared: { ...f.value.prepared, build: { sourceBuild: { cgroupRoots: { mode: 'v2', unified: f.roots.cpu } } } } } as never))
      .resolves.toBeUndefined()
    await expect(preflightRsiOwnerReadiness({ ...f.value,
      prepared: { ...f.value.prepared, build: { sourceBuild: { cgroupRoots: { mode: 'v2', unified: 'relative/uid-1000' } } } } } as never))
      .rejects.toMatchObject({ stage: 'cgroup' })
    await expect(preflightRsiOwnerReadiness({ ...f.value,
      prepared: { ...f.value.prepared, build: { sourceBuild: { cgroupRoots: { mode: 'v2', unified: join(f.root, 'missing-v2-root') } } } } } as never))
      .rejects.toMatchObject({ stage: 'cgroup' })
    await expect(preflightRsiOwnerReadiness({ ...f.value, manifest: { ...f.value.manifest,
      controlPlane: { runtimeObserver: { ...f.value.manifest.controlPlane.runtimeObserver,
        socketPath: join(f.root, 'nested', 'x'.repeat(120), 'observer.sock') } } } } as never))
      .rejects.toMatchObject({ stage: 'observer' })
  })
  test('fresh installs pass without installed policies; retries require them', async () => {
    const f = await preflightFixture()
    // Fresh: coordinator base input is shape-checked, installed policies and the
    // installed base read are not required before the first grants exist.
    await expect(preflightRsiOwnerReadiness(f.value as never)).resolves.toBeUndefined()
    // Retry: the same shape-only fixture now carries a previous manifest, so a
    // missing installed policy set fails the authority stage.
    await expect(preflightRsiOwnerReadiness({ ...f.value, previousManifest: {} } as never))
      .rejects.toMatchObject({ stage: 'authority' })
    // Retry with the installed policies re-read is accepted.
    await expect(preflightRsiOwnerReadiness({ ...f.value, previousManifest: {},
      installed: { ...f.value.installed, policies: [{}] } } as never)).resolves.toBeUndefined()
  })
  test('authority composition failure is a readable stage', async () => {
    const f = await preflightFixture()
    await expect(preflightRsiOwnerReadiness({ ...f.value, previousManifest: {} } as never))
      .rejects.toMatchObject({ stage: 'authority' })
  })
  test('shape validation rejects inconsistent decision roots and missing manifest groups', async () => {
    const f = await preflightFixture()
    const manifest = f.value.manifest
    const stateRoot = join(f.root, 'rsi-authorities', 'target', 'state')
    const observe = (change: (copy: any) => void) => {
      const copy = structuredClone(manifest) as any
      change(copy)
      return preflightRsiOwnerReadiness({ ...f.value, manifest: copy } as never)
    }
    // Fresh shape is accepted.
    await expect(observe(() => {})).resolves.toBeUndefined()
    // decisionRoot must equal the release-execution review decision root.
    await expect(observe(copy => { copy.sourceReviews.decisionRoot = join(stateRoot, 'other-decisions') }))
      .rejects.toMatchObject({ stage: 'authority' })
    // Both roots must stay under this installation's authority state root.
    await expect(observe(copy => {
      copy.sourceReviews.decisionRoot = join(f.root, 'outside', 'review-decisions')
      copy.controlPlane.sourceReleaseExecution.reviewDecisionRoot = join(f.root, 'outside', 'review-decisions')
    })).rejects.toMatchObject({ stage: 'authority' })
    // Required groups must be present.
    await expect(observe(copy => { delete copy.growthDriver })).rejects.toMatchObject({ stage: 'authority' })
    await expect(observe(copy => { delete copy.controlPlane.sourceJobs })).rejects.toMatchObject({ stage: 'authority' })
    await expect(observe(copy => { copy.sourceReviews = {} })).rejects.toMatchObject({ stage: 'authority' })
  })
  test('passes when the pinned tools, delegated roots and prepared paths are ready without writing', async () => {
    const f = await preflightFixture()
    const before = await hashTree(f.root)
    await expect(preflightRsiOwnerReadiness(f.value as never)).resolves.toBeUndefined()
    // The preflight stages write nothing in this prepared tree (hash-verified);
    // the earlier lock/prepare/coordinator receipt writes are outside this claim.
    expect(await hashTree(f.root)).toBe(before)
  })
})

describe.skipIf(process.platform !== 'linux')('automatic owner deployment', () => {
  test('installs and reopens the complete native family without renewing terms or reconstructing a missing unused ledger', async () => {
    const f = await fixture(), prepared = await f.ports.prepare(f.input, new AbortController().signal)
    const native = await nativePreparedFixture(prepared.resources, prepared.source)
    vi.mocked(f.ports.prepare).mockResolvedValue({ ...prepared, build: { sourceBuild: native.sourceBuild },
      creationBuild: native.creationBuild, runnerStates: native.runnerStates })
    const first = await installRsiOwnerDeployment(f.input, f.ports)
    expect(first.mode).toBe('ready'); expect(f.starts).toEqual([f.coordinator, f.profile])
    const path = join(prepared.resources.configRoot, 'manifest.json'), bytes = await readFile(path, 'utf8')
    const manifest = JSON.parse(bytes)
    expect(manifest.controlPlane.sourceBuild).toMatchObject({ backend: 'linux-native', stateSeal: native.runnerStates.sourceBuild })
    expect(manifest.controlPlane.sourceJobs.revision).toEqual(manifest.pluginRevision.revision)
    expect(manifest.growthDriver.pluginSourceProposals).toMatchObject({ allowCreation: true, allowRevision: true })
    expect(manifest.pluginCreation.reviews.runner.stateSeal).toEqual(native.runnerStates.creationReview)
    expect(manifest.pluginCreation.capabilities.runner.stateSeal).toEqual(native.runnerStates.creationAdoption)
    expect(manifest.pluginRevision.reviews.runner.stateSeal).toEqual(native.runnerStates.revisionReview)
    expect(manifest.pluginRevision.regressions.runner.stateSeal).toEqual(native.runnerStates.revisionRegression)
    const grant = await readFile(join(prepared.resources.configRoot, 'host-authority.json'), 'utf8')
    expect(await installRsiOwnerDeployment(f.input, f.ports)).toEqual(first)
    expect(await readFile(path, 'utf8')).toBe(bytes)
    expect(await readFile(join(prepared.resources.configRoot, 'host-authority.json'), 'utf8')).toBe(grant)
    // No task has ever opened this lazy reviewer. Its pre-initialized ledger is
    // still mandatory and must not be silently treated as a fresh budget.
    const ledger = join(prepared.resources.stateRoot, 'revision-review-runner', 'ledger.sqlite')
    await rm(ledger)
    vi.mocked(f.ports.stop).mockClear()
    await expect(installRsiOwnerDeployment(f.input, f.ports)).rejects.toThrow()
    expect(f.ports.stop).not.toHaveBeenCalled()
    await expect(readFile(ledger)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path, 'utf8')).toBe(bytes)
  }, 120_000)

  test('refuses to expand an existing installation with the fresh ordinary-use learning opt-in', async () => {
    const f = await fixture()
    expect((await installRsiOwnerDeployment(f.input, f.ports)).mode).toBe('ready')
    vi.mocked(f.ports.stop).mockClear()
    await expect(installRsiOwnerDeployment({ ...f.input, enableOrdinaryUseLearning: true }, f.ports))
      .rejects.toThrow('existing installation cannot be expanded with ordinary-use learning')
    expect(f.ports.stop).not.toHaveBeenCalled()
  }, 120_000)

  test('a fresh skip issues no memory-learning chain and a retry preserves that absence', async () => {
    const f = await fixture()
    const first = await installRsiOwnerDeployment({ ...f.input, skipMemoryLearning: true }, f.ports)
    expect(first.mode).toBe('ready')
    const manifestPath = join(f.f.input.resources.configRoot, 'manifest.json')
    const bytes = await readFile(manifestPath, 'utf8')
    const manifest = JSON.parse(bytes) as { memoryLearning?: unknown; ordinaryUseLearning?: unknown
      controlPlane: { runtimeObserver: { targets: Array<{ entryId: string }> } } }
    expect(manifest.memoryLearning).toBeUndefined()
    expect(manifest.ordinaryUseLearning).toBeUndefined()
    expect(manifest.controlPlane.runtimeObserver.targets.map(target => target.entryId))
      .not.toContain('dsh-enhanced-assistant-memory-learning')
    const rows = parse(await readFile(join(f.home, 'profiles', f.profile, 'cordis.patch.yml'), 'utf8')) as Array<{
      id: string; config?: Record<string, any>; disabled?: boolean }>
    const personal = rows.find(row => row.id === 'dsh-enhanced-personal-assistant')!.config!
    expect(personal.personalMemory.automaticLearning).toBeUndefined()
    expect((personal.assistantPolicy.budgets as Array<{ id?: string }>).filter(budget => String(budget.id).includes('memory'))).toEqual([])
    expect((personal.assistantPolicy.rules as Array<{ id?: string }>).filter(rule => String(rule.id).includes('memory'))).toEqual([])
    expect(rows.find(row => row.id === 'dsh-enhanced-assistant-verifier')!.config!.memoryReviews).toBeUndefined()
    expect(rows.find(row => row.id === 'dsh-enhanced-assistant-memory-learning')?.config).toBeUndefined()
    expect(f.starts).toEqual([f.coordinator, f.profile])
    // A retry without the explicit flag keeps exactly the recorded absence and
    // never issues the skipped grants.
    expect(await installRsiOwnerDeployment(f.input, f.ports)).toEqual(first)
    expect(await readFile(manifestPath, 'utf8')).toBe(bytes)
  }, 120_000)

  test('refuses to drop an already authorized memory-learning chain with a skip decision', async () => {
    const f = await fixture()
    expect((await installRsiOwnerDeployment(f.input, f.ports)).mode).toBe('ready')
    vi.mocked(f.ports.stop).mockClear()
    await expect(installRsiOwnerDeployment({ ...f.input, skipMemoryLearning: true }, f.ports))
      .rejects.toThrow('cannot drop memory learning')
    expect(f.ports.stop).not.toHaveBeenCalled()
  }, 120_000)

  test('rejects persisted creation, receipt and grant file drift before either Host is stopped', async () => {
    const f = await fixture()
    expect((await installRsiOwnerDeployment(f.input, f.ports)).mode).toBe('ready')
    const config = f.f.input.resources.configRoot
    const cases = [
      { name: 'manifest.json', change: (value: any) => { value.pluginCreation.reviews.runner.runtime.sourceCommit = 'c'.repeat(40) } },
      { name: 'bootstrap.json', change: (value: any) => { value.planDigest = '0'.repeat(64) } },
      { name: 'adoption.json', change: (value: any) => { value.unrecognized = true } },
    ]
    for (const { name, change } of cases) {
      const path = join(config, name), original = await readFile(path, 'utf8')
      const value = JSON.parse(original); change(value)
      await writeFile(path, JSON.stringify(value), { mode: 0o600 })
      vi.mocked(f.ports.stop).mockClear()
      await expect(installRsiOwnerDeployment(f.input, f.ports)).rejects.toThrow('before stopping Hosts')
      expect(f.ports.stop).not.toHaveBeenCalled()
      await writeFile(path, original, { mode: 0o600 })
    }
  }, 120_000)
  test('installs a complete created-tool grant once and reuses its exact terms on restart', async () => {
    const f = await fixture()
    const first = await installRsiOwnerDeployment(f.input, f.ports)
    expect(first.mode).toBe('ready')
    const path = join(f.f.input.resources.configRoot, 'manifest.json')
    const bytes = await readFile(path, 'utf8')
    const manifest = JSON.parse(bytes)
    expect(manifest.pluginCreation.reviews.runner).toMatchObject({ backend: 'linux-native' })
    expect(manifest.growthDriver.pluginSourceProposals.allowCreation).toBe(true)
    const rows = parse(await readFile(join(f.home, 'profiles', f.profile, 'cordis.patch.yml'), 'utf8')) as Array<{ id: string; config: Record<string, any> }>
    expect(rows.find(row => row.id === 'dsh-enhanced-assistant-verifier')!.config.creationReviews).toEqual(manifest.pluginCreation.reviews)
    expect(await installRsiOwnerDeployment(f.input, f.ports)).toEqual(first)
    expect(await readFile(path, 'utf8')).toBe(bytes)
  }, 120_000)
  test('accepts an exact persisted memory scan on restart and rejects owner, catalog, or config drift', async () => {
    const f = await fixture()
    const learning = f.f.input.manifest.memoryLearning!.learning, owner = learning.owner
    const record = { id: `memory-scan-${growthObjectDigest([learning.authorityId, owner])}`,
      owner: 'assistant-memory-learning', updatedAt: 1, definition: {
        principal: owner.principalId, workspace: owner.workspace, agentPreset: owner.agentPreset,
        budgetId: learning.scanBudgetId, budgetAmount: learning.scanBudgetAmount, retrySafety: 'never', maxRetries: 0,
        execution: { kind: 'host', executorId: 'assistant-memory-learning-v1', executorContractVersion: 1,
          runbookId: 'scan', runbookVersion: 1, catalogDigest: growthObjectDigest({ executor: 'assistant-memory-learning-v1', contract: 1 }),
          ownerRouteId: owner.authorityId, activationNonce: growthObjectDigest(learning),
          targetScope: { workspace: owner.workspace, preset: owner.agentPreset },
          scopeDigest: growthObjectDigest([owner.workspace, owner.agentPreset]) },
      } }
    const check = (value: typeof record) => assertRsiMemoryScanActivation(f.f.input.manifest,
      [value] as unknown as Parameters<typeof assertRsiMemoryScanActivation>[1])
    expect(() => check(record)).not.toThrow()
    expect(() => check({ ...record, definition: { ...record.definition, principal: 'other-owner' } })).toThrow('memory scan activation')
    expect(() => check({ ...record, definition: { ...record.definition,
      execution: { ...record.definition.execution, catalogDigest: 'a'.repeat(64) } } })).toThrow('memory scan activation')
    expect(() => check({ ...record, definition: { ...record.definition,
      execution: { ...record.definition.execution, activationNonce: 'b'.repeat(64) } } })).toThrow('memory scan activation')
  }, 120_000)
  test('applies real owner/profile/authority transaction, starts coordinator first, and preserves frozen installation on retry', async () => {
    const f = await fixture()
    const original = parse(f.originals[f.profile]!) as Array<{id:string;config:Record<string,any>}>
    const delivery = original.find(row => row.id === 'dsh-enhanced-assistant-delivery')!
    delivery.config.ownerRoutes = []
    delivery.config.preservedSetting = {exact:'keep'}
    f.originals[f.profile] = stringify(original)
    const first = await installRsiOwnerDeployment(f.input,f.ports)
    expect(first.mode).toBe('ready')
    expect(f.starts).toEqual([f.coordinator,f.profile])
    const manifest = await readFile(join(f.f.input.resources.configRoot,'manifest.json'),'utf8')
    expect(JSON.parse(manifest).pluginCreation).toBeDefined()
    const appliedRows = parse(await readFile(join(f.home,'profiles',f.profile,'cordis.patch.yml'),'utf8')) as Array<{id:string;config:Record<string,any>}>
    const appliedDelivery = appliedRows.find(row => row.id === delivery.id)!.config
    expect(appliedDelivery.ownerRoutes).toHaveLength(1)
    expect(appliedDelivery.ownerRoutes[0].id).toMatch(/^rsi-owner-/u)
    expect(appliedDelivery.preservedSetting).toEqual({exact:'keep'})
    expect(JSON.parse(manifest).controlPlane.runtimeObserver.targets.find((target:{entryId:string}) => target.entryId === delivery.id).configDigest)
      .toBe(runtimeConfigDigest(appliedDelivery))
    const key = await readFile(join(f.f.input.resources.configRoot,'observer.key'))
    expect(f.ports.ready).toHaveBeenCalledOnce()
    expect(vi.mocked(f.ports.ready).mock.calls[0]![3]).toBeGreaterThan(0)
    // Simulate an interrupted two-profile write: one side still has its old patch.
    const journalPath = join(f.home,'.rsi-setup-journal.json')
    const journal = JSON.parse(await readFile(journalPath,'utf8')) as {stage:string;entries:Array<{profile:string;before:string}>}
    journal.stage = 'prepared'
    await writeFile(journalPath,JSON.stringify(journal),{mode:0o600})
    await writeFile(join(f.home,'profiles',f.coordinator,'cordis.patch.yml'),journal.entries[1]!.before,{mode:0o600})
    // Replay must preserve the frozen native authorization scope and terms.
    const second = await installRsiOwnerDeployment(f.input,f.ports)
    expect(second).toEqual(first)
    expect(await readFile(join(f.f.input.resources.configRoot,'manifest.json'),'utf8')).toBe(manifest)
    expect(await readFile(join(f.f.input.resources.configRoot,'observer.key'))).toEqual(key)
    const recoveredJournal = JSON.parse(await readFile(journalPath,'utf8')) as {stage:string}
    recoveredJournal.stage = 'prepared'
    await writeFile(journalPath,JSON.stringify(recoveredJournal),{mode:0o600})
    const startsBeforeFailure = f.starts.length
    vi.mocked(f.ports.setup.snapshot).mockRejectedValueOnce(new Error('owner preflight failed after rollback'))
    await expect(installRsiOwnerDeployment(f.input,f.ports)).rejects.toThrow('owner preflight failed after rollback')
    expect(f.starts.slice(startsBeforeFailure)).toEqual([f.coordinator,f.profile])
    expect(await readFile(join(f.f.input.resources.configRoot,'manifest.json'),'utf8')).toBe(manifest)

  },120_000)
  test('retries only its own partial coordinator package installation', async () => {
    const root = await mkdtemp(join(tmpdir(),'rsi-coordinator-install-')); cleanups.push(() => rm(root,{recursive:true,force:true}))
    const home = join(root,'home'); await mkdir(join(home,'profiles'),{recursive:true,mode:0o700})
    const profile = 'target', coordinator = rsiCoordinatorProfile(profile)
    const hostVersion = JSON.parse(await readFile(new URL('../../../package.json',import.meta.url),'utf8')) as {version:string}
    const control = join(root,'systemctl')
    await writeFile(control,`#!${process.execPath}\nprocess.stdout.write('ActiveState=inactive\\nMainPID=0\\n')\n`,{mode:0o700})
    const systemctl = {path:control,sha256:createHash('sha256').update(await readFile(control)).digest('hex'),interpreter:null}
    const dsh = join(root,'dsh')
    await writeFile(dsh,`#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const root = path.join(process.env.DSH_HOME,'profiles',process.argv[process.argv.indexOf('--profile')+1]);
const first = !fs.existsSync(root);
for (const name of (first ? ['assistant-policy'] : ['assistant-policy','assistant-automations','plugin-control-plane'])) {
  const dir = path.join(root,'node_modules','@dsh-enhanced',name);fs.mkdirSync(dir,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'@dsh-enhanced/'+name,version:${JSON.stringify(hostVersion.version)}}));
}
process.exit(first ? 9 : 0);
`,{mode:0o700})
    await chmod(dsh,0o700)
    const executor = {path:dsh,sha256:createHash('sha256').update(await readFile(dsh)).digest('hex'),version:'0.1.5-rc.3',id:'dsh',environmentAllowlist:[]}
    const signal = new AbortController().signal
    await expect(rsiInstallPorts.coordinator({dshHome:home,profile},coordinator,executor,signal,systemctl)).rejects.toThrow('exit=9')
    await expect(rsiInstallPorts.coordinator({dshHome:home,profile},coordinator,executor,signal,systemctl)).resolves.toBeUndefined()
    expect(JSON.parse(await readFile(join(home,'profiles',coordinator,'node_modules','@dsh-enhanced','plugin-control-plane','package.json'),'utf8')).name)
      .toBe('@dsh-enhanced/plugin-control-plane')
    const unowned = rsiCoordinatorProfile('foreign')
    await mkdir(join(home,'profiles',unowned),{mode:0o700})
    await expect(rsiInstallPorts.coordinator({dshHome:home,profile:'foreign'},unowned,executor,signal,systemctl))
      .rejects.toThrow('unregistered coordinator')
    for (const name of ['assistant-policy','assistant-automations','plugin-control-plane']) {
      const dir = join(home,'profiles',unowned,'node_modules','@dsh-enhanced',name)
      await mkdir(dir,{recursive:true,mode:0o700})
      await writeFile(join(dir,'package.json'),JSON.stringify({name:`@dsh-enhanced/${name}`,version:hostVersion.version}))
    }
    await expect(rsiInstallPorts.coordinator({dshHome:home,profile:'foreign'},unowned,executor,signal,systemctl))
      .rejects.toThrow('unregistered coordinator')
  })
  test('missing build prerequisites leave ordinary installation running and do not issue grants', async () => {
    const f = await fixture()
    f.ports.prepare = vi.fn(async () => { throw new LinuxRsiRuntimeUnavailableError('runtime unavailable') })
    expect(await installRsiOwnerDeployment(f.input,f.ports)).toEqual({mode:'not-ready',reason:'rsi Linux runtime unavailable: runtime unavailable'})
    expect(f.stops).toEqual([])
    expect(f.ports.coordinator).not.toHaveBeenCalled()
  },120_000)
  test('readiness preflight failure returns not-ready before any grant, manifest or service stop', async () => {
    const f = await fixture()
    // Preflight runs after the lock, resource preparation and coordinator
    // receipt; this asserts only that the preflight window itself writes no
    // manifest, grant, authority config or journal under configRoot.
    const configRoot = f.f.input.resources.configRoot
    const before = await hashTree(configRoot)
    f.ports.preflight = vi.fn(async () => {
      throw new RsiOwnerPreflightUnavailableError('observer', 'runtime observer socket path is invalid')
    })
    const result = await installRsiOwnerDeployment(f.input, f.ports)
    expect(result).toEqual({ mode: 'not-ready', reason: 'rsi owner preflight unavailable (observer): runtime observer socket path is invalid' })
    expect(vi.mocked(f.ports.preflight)).toHaveBeenCalledOnce()
    // Nothing was stopped, started, journaled, granted or manifested.
    expect(f.stops).toEqual([])
    expect(f.starts).toEqual([])
    expect(await hashTree(configRoot)).toBe(before)
    await expect(readFile(join(configRoot, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(f.home, '.rsi-setup-journal.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 120_000)

  test('a transient readiness failure issues no grants and the retry recovers', async () => {
    const f = await fixture()
    const original = f.ports.preflight
    f.ports.preflight = vi.fn(async () => {
      throw new RsiOwnerPreflightUnavailableError('service-manager', 'user manager is not reachable')
    })
    expect(await installRsiOwnerDeployment(f.input, f.ports)).toMatchObject({ mode: 'not-ready',
      reason: expect.stringContaining('(service-manager)') })
    expect(f.stops).toEqual([]); expect(f.starts).toEqual([])
    expect(await readFile(join(f.f.input.resources.configRoot, 'manifest.json')).catch(() => null)).toBeNull()
    // The same frozen inputs succeed once readiness is restored; the preflight
    // is read-only, so no rollback/journal reconciliation is needed.
    f.ports.preflight = vi.fn(original)
    const first = await installRsiOwnerDeployment(f.input, f.ports)
    expect(first.mode).toBe('ready')
    expect(vi.mocked(f.ports.preflight)).toHaveBeenCalledTimes(1)
    expect(await installRsiOwnerDeployment(f.input, f.ports)).toEqual(first)
  }, 120_000)

  test('authorize and skip owner installs both pass through the readiness preflight', async () => {
    for (const skipMemoryLearning of [undefined, true] as const) {
      const f = await fixture()
      const preflight = vi.fn(f.ports.preflight)
      f.ports.preflight = preflight
      const result = await installRsiOwnerDeployment(skipMemoryLearning === undefined
        ? f.input : { ...f.input, skipMemoryLearning }, f.ports)
      expect(result.mode, String(skipMemoryLearning)).toBe('ready')
      expect(preflight).toHaveBeenCalledOnce()
    }
  }, 240_000)

  test('profile-external local packages return not-ready before stopping services or issuing grants', async () => {
    const f = await fixture()
    f.ports.collect = vi.fn(async () => { throw new RsiInstalledInputsUnavailableError('local package link') })
    f.ports.prepareOwner = vi.fn(f.ports.prepareOwner)
    expect(await installRsiOwnerDeployment(f.input,f.ports)).toEqual({mode:'not-ready',reason:'rsi installed inputs unavailable: local package link'})
    expect(f.stops).toEqual([])
    expect(f.ports.coordinator).not.toHaveBeenCalled()
    expect(f.ports.prepareOwner).not.toHaveBeenCalled()
  },120_000)
  test('failed startup readiness retains applied recovery journal and retries without renewing authority', async () => {
    const f = await fixture()
    f.ports.ready = vi.fn(async () => { throw new Error('observer unavailable') })
    await expect(installRsiOwnerDeployment(f.input,f.ports)).rejects.toThrow('observer unavailable')
    const journal = JSON.parse(await readFile(join(f.home,'.rsi-setup-journal.json'),'utf8')) as {stage:string}
    expect(journal.stage).toBe('applied')
    const manifest = await readFile(join(f.f.input.resources.configRoot,'manifest.json'),'utf8')
    f.ports.ready = vi.fn(async () => {})
    expect((await installRsiOwnerDeployment(f.input,f.ports)).mode).toBe('ready')
    expect(await readFile(join(f.f.input.resources.configRoot,'manifest.json'),'utf8')).toBe(manifest)
    const startsBeforeRetry = f.starts.length
    f.ports.readUnit = vi.fn(async () => ({...f.f.input.unitProperties,User:'changed'}))
    await expect(installRsiOwnerDeployment(f.input,f.ports)).rejects.toThrow('final loaded systemd unit differs')
    expect(f.starts.slice(startsBeforeRetry)).toEqual([f.coordinator,f.profile])
  },120_000)
  test('final unit property drift rolls back profile application before any Host starts', async () => {
    const f = await fixture()
    const original = parse(f.originals[f.profile]!) as Array<{id:string;config:Record<string,any>}>
    original.find(row => row.id === 'dsh-enhanced-assistant-delivery')!.config.ownerRoutes = []
    f.originals[f.profile] = stringify(original)
    f.ports.readUnit = vi.fn(async () => ({...f.f.input.unitProperties,User:'changed'}))
    await expect(installRsiOwnerDeployment(f.input,f.ports)).rejects.toThrow('final loaded systemd unit differs')
    expect(f.starts).toEqual([])
    expect(await readFile(join(f.home,'profiles',f.profile,'cordis.patch.yml'),'utf8')).toBe('[]\n')
  },120_000)
  test('an active destination coordinator ledger needs acknowledgement even when both source ledgers are empty', async () => {
    const f = await fixture()
    const inspect = f.ports.setup.automationInventory, destination = join(f.home,'rsi-coordinators',f.coordinator,'automations.sqlite')
    const active = [{id:'existing-coordinator-row',status:'active',version:1}] as unknown as Awaited<ReturnType<typeof inspect>>['records']
    f.ports.setup.automationInventory = vi.fn(async (effective,home) => {
      const inventory = await inspect(effective,home)
      return {...inventory,records:inventory.databasePath === destination ? active : []}
    })
    await expect(installRsiOwnerDeployment(f.input,f.ports)).rejects.toThrow('--ack-existing-automations')
    expect(f.stops).toEqual([])
    expect((await installRsiOwnerDeployment({...f.input,ackExistingAutomations:true},f.ports)).mode).toBe('ready')
    expect(active).toEqual([{id:'existing-coordinator-row',status:'active',version:1}])
  },120_000)
  test('requires acknowledgement for existing Recovery/heartbeat rows and rejects post-stop inventory drift before grants', async () => {
    const f = await fixture()
    const inspect = f.ports.setup.automationInventory
    const active = [{id:'recovery:supervised-growth',owner:'dsh-enhanced-assistant-recovery',status:'active',version:1}] as unknown as Awaited<ReturnType<typeof inspect>>['records']
    f.ports.setup.automationInventory = vi.fn(async (effective,home) => {
      const inventory = await inspect(effective,home)
      return {...inventory,records:inventory.databasePath === join(f.home,'automations.sqlite') ? active : []}
    })
    f.ports.prepareOwner = vi.fn(f.ports.prepareOwner)
    await expect(installRsiOwnerDeployment(f.input,f.ports)).rejects.toThrow('--ack-existing-automations')
    expect(f.stops).toEqual([])
    expect(f.ports.prepareOwner).not.toHaveBeenCalled()
    const stop = f.ports.stop
    f.ports.stop = vi.fn(async (...args: Parameters<RsiInstallPorts['stop']>) => {
      const result = await stop(...args)
      active[0] = {...active[0]!,version:2}
      return result
    })
    await expect(installRsiOwnerDeployment({...f.input,ackExistingAutomations:true},f.ports)).rejects.toThrow('Automation inventory changed while stopping')
    expect(f.ports.prepareOwner).not.toHaveBeenCalled()
    expect(await readFile(join(f.home,'profiles',f.profile,'cordis.patch.yml'),'utf8')).toBe('[]\n')
    f.ports.stop = stop
    expect((await installRsiOwnerDeployment({...f.input,ackExistingAutomations:true},f.ports)).mode).toBe('ready')
    expect(active[0]).toMatchObject({id:'recovery:supervised-growth',version:2})
  },120_000)

  test('upgradeExistingOwner upgrades an existing owner deployment in place while preserving owner, bindings, and ledgers', async () => {
    const f = await fixture()
    const first = await installRsiOwnerDeployment(f.input, f.ports)
    expect(first.mode).toBe('ready')
    const manifestPath = join(f.f.input.resources.configRoot, 'manifest.json')
    const firstManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      sourceReviews: { owner: unknown; expiresAt: number }
      controlPlane: { sourceJobs: { authorityId: string } }
      ordinaryUseLearning?: unknown
    }
    const ledgerPath = join(f.f.input.resources.stateRoot, 'revision-review-runner', 'ledger.sqlite')
    const ledgerBefore = await readFile(ledgerPath)

    // Bare retry without upgradeExistingOwner still fails closed
    await expect(installRsiOwnerDeployment({ ...f.input, enableOrdinaryUseLearning: true }, f.ports))
      .rejects.toThrow('existing installation cannot be expanded with ordinary-use learning')

    // Upgrade the installed profile bundles (adding assistant-proactive & assistant-work-items) and run upgradeExistingOwner
    const originalRows = parse(f.originals[f.profile]!) as Array<{ id: string; name?: string; config?: Record<string, unknown> }>
    originalRows.push(
      { id: 'dsh-enhanced-assistant-proactive', name: '@dsh-enhanced/assistant-proactive', config: {} },
      { id: 'dsh-enhanced-assistant-work-items', name: '@dsh-enhanced/assistant-work-items', config: { enabled: true, intakeLedger: { enabled: true } } },
    )
    f.originals[f.profile] = stringify(originalRows)
    const baseCollect = f.ports.collect
    f.ports.collect = vi.fn(async value => {
      const collected = await baseCollect(value)
      const added = ['assistant-proactive', 'assistant-work-items'] as const
      const extraInputs = added.flatMap(plugin => [
        `node_modules/@dsh-enhanced/${plugin}/package.json`,
        `node_modules/@dsh-enhanced/${plugin}/cordis.patch.yml`,
        `node_modules/@dsh-enhanced/${plugin}/lib/index.js`,
      ])
      const samplePolicy = collected.policies[0]!
      const extraPolicies = added.map(plugin => ({
        ...samplePolicy,
        candidateId: plugin,
        packageName: `@dsh-enhanced/${plugin}`,
        packagePath: `plugins/${plugin}`,
        capabilities: [plugin],
      }))
      return {
        ...collected,
        plugins: [...collected.plugins, ...added],
        hostDeploymentInputs: [...collected.hostDeploymentInputs, ...extraInputs],
        policies: [...collected.policies, ...extraPolicies],
      }
    })

    // Explicit upgradeExistingOwner succeeds and preserves owner identity, expiry, and SQLite ledgers
    const upgraded = await installRsiOwnerDeployment({
      ...f.input,
      enableOrdinaryUseLearning: true,
      intakeProvider: 'deepseek-official',
      intakeModel: 'deepseek-chat',
      upgradeExistingOwner: true,
    }, f.ports)
    expect(upgraded.mode).toBe('ready')
    const secondManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      sourceReviews: { owner: unknown; expiresAt: number }
      controlPlane: { sourceJobs: { authorityId: string } }
      ordinaryUseLearning?: { intakeEvaluation: { provider: string; model: string } }
    }
    expect(secondManifest.sourceReviews.owner).toEqual(firstManifest.sourceReviews.owner)
    expect(secondManifest.sourceReviews.expiresAt).toBe(firstManifest.sourceReviews.expiresAt)
    expect(secondManifest.controlPlane.sourceJobs.authorityId).toBe(firstManifest.controlPlane.sourceJobs.authorityId)
    expect(secondManifest.ordinaryUseLearning?.intakeEvaluation).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
    })
    expect(await readFile(ledgerPath)).toEqual(ledgerBefore)
    const rows = parse(await readFile(join(f.home, 'profiles', f.profile, 'cordis.patch.yml'), 'utf8')) as Array<{
      id: string; config?: Record<string, any> }>
    expect(rows.find(row => row.id === 'dsh-enhanced-assistant-memory-learning')?.config?.workItemExperiences).toBe(true)
    expect(rows.find(row => row.id === 'dsh-enhanced-assistant-proactive')?.config?.intakeEvaluation).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
    })
    const effectiveAfter = parse(f.ports.setup.dump(f.profile, f.home)) as Array<{
      id: string; config?: Record<string, any> }>
    const delivery = effectiveAfter.find(row => row.id === 'dsh-enhanced-assistant-delivery')!.config!
    expect(delivery.ownerRoutes).toHaveLength(1)
  }, 120_000)

  test('upgradeExistingOwner rolls back configRoot when ports.configure fails after prepareOwner, then retries cleanly', async () => {
    const f = await fixture()
    const first = await installRsiOwnerDeployment(f.input, f.ports)
    expect(first.mode).toBe('ready')
    const configRoot = f.f.input.resources.configRoot
    const configBefore = await hashTree(configRoot)
    const manifestPath = join(configRoot, 'manifest.json')
    const bootstrapPath = join(configRoot, 'bootstrap.json')
    const manifestBefore = await readFile(manifestPath, 'utf8')
    const bootstrapBefore = await readFile(bootstrapPath, 'utf8')
    const targetPatchBefore = await readFile(join(f.home, 'profiles', f.profile, 'cordis.patch.yml'), 'utf8')
    const coordinatorPatchBefore = await readFile(join(f.home, 'profiles', f.coordinator, 'cordis.patch.yml'), 'utf8')

    // Prepare upgraded bundles for the failed upgrade attempt
    const originalRows = parse(f.originals[f.profile]!) as Array<{ id: string; name?: string; config?: Record<string, unknown> }>
    originalRows.push(
      { id: 'dsh-enhanced-assistant-proactive', name: '@dsh-enhanced/assistant-proactive', config: {} },
      { id: 'dsh-enhanced-assistant-work-items', name: '@dsh-enhanced/assistant-work-items', config: { enabled: true, intakeLedger: { enabled: true } } },
    )
    f.originals[f.profile] = stringify(originalRows)
    const baseCollect = f.ports.collect
    f.ports.collect = vi.fn(async value => {
      const collected = await baseCollect(value)
      const added = ['assistant-proactive', 'assistant-work-items'] as const
      const extraInputs = added.flatMap(plugin => [
        `node_modules/@dsh-enhanced/${plugin}/package.json`,
        `node_modules/@dsh-enhanced/${plugin}/cordis.patch.yml`,
        `node_modules/@dsh-enhanced/${plugin}/lib/index.js`,
      ])
      const samplePolicy = collected.policies[0]!
      const extraPolicies = added.map(plugin => ({
        ...samplePolicy,
        candidateId: plugin,
        packageName: `@dsh-enhanced/${plugin}`,
        packagePath: `plugins/${plugin}`,
        capabilities: [plugin],
      }))
      return {
        ...collected,
        plugins: [...collected.plugins, ...added],
        hostDeploymentInputs: [...collected.hostDeploymentInputs, ...extraInputs],
        policies: [...collected.policies, ...extraPolicies],
      }
    })

    const originalConfigure = f.ports.configure
    let prepareCount = 0
    const originalPrepareOwner = f.ports.prepareOwner
    f.ports.prepareOwner = vi.fn(async (...args: Parameters<RsiInstallPorts['prepareOwner']>) => {
      prepareCount += 1
      return await originalPrepareOwner(...args)
    })
    f.ports.configure = vi.fn(async () => {
      throw new Error('INJECTED_CONFIGURE_FAILURE')
    })

    const startsBeforeFail = f.starts.length
    await expect(installRsiOwnerDeployment({
      ...f.input,
      enableOrdinaryUseLearning: true,
      intakeProvider: 'deepseek-official',
      intakeModel: 'deepseek-chat',
      upgradeExistingOwner: true,
    }, f.ports)).rejects.toThrow('INJECTED_CONFIGURE_FAILURE')

    expect(prepareCount).toBe(1)
    expect(await readFile(manifestPath, 'utf8')).toBe(manifestBefore)
    expect(await readFile(bootstrapPath, 'utf8')).toBe(bootstrapBefore)
    expect(await hashTree(configRoot)).toBe(configBefore)
    expect(await readFile(join(f.home, 'profiles', f.profile, 'cordis.patch.yml'), 'utf8')).toBe(targetPatchBefore)
    expect(await readFile(join(f.home, 'profiles', f.coordinator, 'cordis.patch.yml'), 'utf8')).toBe(coordinatorPatchBefore)
    expect(f.starts.slice(startsBeforeFail)).toEqual([f.coordinator, f.profile])

    // Subsequent upgrade retry succeeds cleanly
    f.ports.configure = originalConfigure
    const retried = await installRsiOwnerDeployment({
      ...f.input,
      enableOrdinaryUseLearning: true,
      intakeProvider: 'deepseek-official',
      intakeModel: 'deepseek-chat',
      upgradeExistingOwner: true,
    }, f.ports)
    expect(retried.mode).toBe('ready')
    expect(JSON.parse(await readFile(manifestPath, 'utf8')).ordinaryUseLearning?.intakeEvaluation).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
    })
  }, 120_000)

  test('upgradeExistingOwner succeeds when assistant-memory-learning was temporarily disabled via /autonomy disable', async () => {
    const f = await fixture()
    const first = await installRsiOwnerDeployment(f.input, f.ports)
    expect(first.mode).toBe('ready')

    // Simulate /autonomy disable setting disabled: true while retaining owner config on disk
    const patchPath = join(f.home, 'profiles', f.profile, 'cordis.patch.yml')
    const patchRows = parse(await readFile(patchPath, 'utf8')) as Array<{ id: string; disabled?: boolean; config?: Record<string, unknown> }>
    const learner = patchRows.find(row => row.id === 'dsh-enhanced-assistant-memory-learning')!
    learner.disabled = true
    await writeFile(patchPath, stringify(patchRows), { mode: 0o600 })

    // Bare retry without upgradeExistingOwner still fails closed
    await expect(installRsiOwnerDeployment(f.input, f.ports))
      .rejects.toThrow('effective memory learner must be the installed unconfigured bundle')

    // Explicit upgradeExistingOwner succeeds and re-enables the owner's learner grant
    const upgraded = await installRsiOwnerDeployment({ ...f.input, upgradeExistingOwner: true }, f.ports)
    expect(upgraded.mode).toBe('ready')
    const finalPatchRows = parse(await readFile(patchPath, 'utf8')) as Array<{ id: string; disabled?: boolean }>
    expect(finalPatchRows.find(row => row.id === 'dsh-enhanced-assistant-memory-learning')?.disabled).toBe(false)
  }, 120_000)

  test('accepts disabled === undefined with config after /autonomy disable -> /autonomy enable on bare retry and upgradeExistingOwner', async () => {
    const f = await fixture()
    // Match real plugins/assistant-memory-learning/cordis.patch.yml where base omits `disabled`
    const baseRows = parse(f.originals[f.profile]!) as Array<{ id: string; disabled?: boolean }>
    delete baseRows.find(row => row.id === 'dsh-enhanced-assistant-memory-learning')!.disabled
    f.originals[f.profile] = stringify(baseRows)

    const first = await installRsiOwnerDeployment(f.input, f.ports)
    expect(first.mode).toBe('ready')

    const toggleOff = await applySelfIterationProfileToggle({ dshHome: f.home, profile: f.profile, enable: false })
    expect(toggleOff).toMatchObject({ ok: true, state: 'disabled' })
    const toggleOn = await applySelfIterationProfileToggle({ dshHome: f.home, profile: f.profile, enable: true })
    expect(toggleOn).toMatchObject({ ok: true, state: 'enabled' })

    const patchPath = join(f.home, 'profiles', f.profile, 'cordis.patch.yml')
    const patchRows = parse(await readFile(patchPath, 'utf8')) as Array<{ id: string; disabled?: boolean; config?: unknown }>
    const learnerRow = patchRows.find(row => row.id === 'dsh-enhanced-assistant-memory-learning')!
    expect(learnerRow.disabled).toBeUndefined()
    expect(learnerRow.config).toBeDefined()

    // Bare retry detects cordis.patch.yml digest change before stopping Hosts; explicit upgradeExistingOwner succeeds
    await expect(installRsiOwnerDeployment(f.input, f.ports)).rejects.toThrow('owner receipt digest changed')
    await expect(installRsiOwnerDeployment({ ...f.input, upgradeExistingOwner: true }, f.ports)).resolves.toMatchObject({ mode: 'ready' })
  }, 120_000)

  test('upgradeExistingOwner succeeds after real /autonomy disable with enableOrdinaryUseLearning and real collectRsiInstalledInputs', async () => {
    const f = await fixture()
    const profileRoot = join(f.home, 'profiles', f.profile)
    const writeInstalledFile = async (path: string, value: string, mode = 0o600) => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, value, { mode })
      await chmod(path, mode)
    }

    // Populate real installed package descriptors + DSH/systemctl bins so real collectRsiInstalledInputs runs
    const version = f.f.input.source.version
    const allPlugins = ['personal-assistant', 'assistant-goals', 'assistant-growth-driver',
      'assistant-memory-learning', 'hello', 'assistant-proactive', 'assistant-work-items',
      'assistant-evaluation', 'personal-memory']
    for (const name of allPlugins) {
      const pkgRoot = join(profileRoot, 'node_modules', '@dsh-enhanced', name)
      await writeInstalledFile(join(pkgRoot, 'package.json'), JSON.stringify({
        name: `@dsh-enhanced/${name}`, version, main: './lib/index.js',
        exports: { '.': { default: './lib/index.js' }, './package.json': './package.json' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }))
      await writeInstalledFile(join(pkgRoot, 'cordis.patch.yml'), `- insert:\n    - id: dsh-enhanced-${name}\n      name: '@dsh-enhanced/${name}'\n`)
      await writeInstalledFile(join(pkgRoot, 'lib', 'index.js'), 'export default {}\n')
    }
    const dshRoot = join(f.f.root, 'real-dsh')
    const binDir = join(f.f.root, 'real-bin')
    await mkdir(binDir, { recursive: true })
    await symlink('/usr/bin/true', join(binDir, 'systemctl'))
    await writeInstalledFile(join(dshRoot, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh', version: f.f.input.executor.version, bin: { dsh: 'lib/bin.js' },
    }))
    await writeInstalledFile(join(dshRoot, 'lib', 'bin.js'), '#!/usr/bin/env node\n', 0o700)
    await symlink(join(dshRoot, 'lib', 'bin.js'), join(binDir, 'dsh'))

    // Add delivery route model, assistant-proactive, assistant-work-items, and an enabled evaluation row to the profile
    const originalRows = parse(f.originals[f.profile]!) as Array<{ id: string; name?: string; config?: Record<string, unknown> }>
    const deliveryRow = originalRows.find(row => row.id === 'dsh-enhanced-assistant-delivery')!
    deliveryRow.config = { ...deliveryRow.config, agentProvider: 'deepseek-official', agentModel: 'deepseek-v4-flash' }
    originalRows.push(
      { id: 'dsh-enhanced-assistant-proactive', name: '@dsh-enhanced/assistant-proactive', config: { enabled: true } },
      { id: 'dsh-enhanced-assistant-work-items', name: '@dsh-enhanced/assistant-work-items', config: { enabled: true, intakeLedger: { enabled: true } } },
    )
    f.originals[f.profile] = stringify(originalRows)
    const patchPath = join(profileRoot, 'cordis.patch.yml')
    await writeInstalledFile(patchPath, stringify([
      { id: 'dsh-enhanced-assistant-evaluation', name: '@dsh-enhanced/assistant-evaluation', config: { enabled: true } },
      { id: 'dsh-enhanced-assistant-proactive', name: '@dsh-enhanced/assistant-proactive', config: { enabled: true } },
      { id: 'dsh-enhanced-assistant-work-items', name: '@dsh-enhanced/assistant-work-items', config: { enabled: true, intakeLedger: { enabled: true } } },
    ]))

    f.ports.collect = vi.fn(async value => {
      const collected = await collectRsiInstalledInputs({
        ...value,
        source: { ...value.source, origin: undefined } as typeof value.source,
        environment: { PATH: `${binDir}:/usr/bin:/bin` },
      })
      return {
        ...collected,
        executor: f.f.input.executor,
        git: f.f.input.manifest.sourceReviews.git,
        systemctl: f.f.input.systemctl,
      }
    })

    const first = await installRsiOwnerDeployment({ ...f.input, enableOrdinaryUseLearning: true }, f.ports)
    expect(first.mode).toBe('ready')

    // Real /autonomy disable toggles all Contract 1 rows (work-items, proactive, growth-driver, memory-learning, evaluation)
    const toggleOff = await applySelfIterationProfileToggle({ dshHome: f.home, profile: f.profile, enable: false })
    expect(toggleOff).toMatchObject({ ok: true, state: 'disabled' })
    const disabledPatch = parse(await readFile(patchPath, 'utf8')) as Array<{ id: string; disabled?: boolean; config?: Record<string, unknown> }>
    for (const id of ['dsh-enhanced-assistant-growth-driver', 'dsh-enhanced-assistant-memory-learning',
      'dsh-enhanced-assistant-proactive', 'dsh-enhanced-assistant-work-items', 'dsh-enhanced-assistant-evaluation']) {
      expect(disabledPatch.find(row => row.id === id)?.disabled).toBe(true)
    }
    expect(disabledPatch.find(row => row.id === 'dsh-enhanced-assistant-work-items')?.config?.enabled).toBe(false)

    // Bare retry without upgradeExistingOwner still fails closed
    await expect(installRsiOwnerDeployment(f.input, f.ports)).rejects.toThrow()

    // Explicit upgradeExistingOwner: true succeeds cleanly using real collectRsiInstalledInputs!
    const upgraded = await installRsiOwnerDeployment({ ...f.input, upgradeExistingOwner: true }, f.ports)
    expect(upgraded.mode).toBe('ready')
    const finalPatch = parse(await readFile(patchPath, 'utf8')) as Array<{ id: string; disabled?: boolean; config?: Record<string, unknown> }>
    for (const id of ['dsh-enhanced-assistant-growth-driver', 'dsh-enhanced-assistant-memory-learning',
      'dsh-enhanced-assistant-proactive', 'dsh-enhanced-assistant-work-items']) {
      expect(finalPatch.find(row => row.id === id)?.disabled).toBe(false)
    }
    expect(finalPatch.find(row => row.id === 'dsh-enhanced-assistant-work-items')?.config?.enabled).toBe(true)
    expect(finalPatch.find(row => row.id === 'dsh-enhanced-assistant-proactive')?.config?.enabled).toBe(true)
    expect(finalPatch.find(row => row.id === 'dsh-enhanced-assistant-growth-driver')?.config?.enabled).toBe(true)
  }, 120_000)
})
