import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { prepareRsiAuthorityResources } from '../src/rsi-authority-resources.ts'
import { compileNativeRsiProfile } from '../src/rsi-native-profile.ts'
import { installNativeRsiOwnerDeployment, type NativeRsiInstallPorts } from '../src/rsi-native-install.ts'
import { applySelfIterationProfileToggle } from '../src/service.ts'
import { launchAgentPaths } from '../src/launchd.ts'

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })

async function fixture() {
  const home = await mkdtemp(join(await realpath('/tmp'), 'dsh-native-install-')); homes.push(home)
  const dshHome = join(home, '.dsh'), profile = `native-${process.pid}-${randomUUID().slice(0, 8)}`
  const profileRoot = join(dshHome, 'profiles', profile)
  const configRoot = join(dshHome, 'rsi-authorities', profile, 'config')
  const stateRoot = join(dshHome, 'rsi-authorities', profile, 'state')
  for (const directory of [dshHome, join(dshHome, 'profiles'), profileRoot, join(dshHome, 'rsi-authorities'),
    join(dshHome, 'rsi-authorities', profile), configRoot, stateRoot]) {
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    await chmod(directory, 0o700)
  }
  const patchPath = join(profileRoot, 'cordis.patch.yml'), originalPatch = '[]\n'
  const installedPatch = '- id: native-test\n  config:\n    enabled: true\n'
  await writeFile(patchPath, originalPatch, { mode: 0o600 })
  const input = { dshHome, profile }
  const paths = launchAgentPaths({ ...input, home })
  const owner = { id: 'owner-binding', version: 1 }
  const state = { registered: false, now: 1_800_000_000_000, bindings: [owner] as object[],
    inventory: { databasePath: join(dshHome, 'automations.sqlite'), schedulerEnabled: false, records: [] as object[] },
    failReady: false, driftOnStop: false, foreignService: false, starts: 0, stops: 0 }
  const prepared = { source: { sourceCommit: 'a'.repeat(40) }, resources: { configRoot, stateRoot },
    build: { schemaVersion: 1, sourceBuild: { image: `sha256:${'a'.repeat(64)}`, dockerPath: process.execPath } }, creationBuild: {}, executor: {
      id: 'dsh', version: '1', path: process.execPath, sha256: 'b'.repeat(64), environmentAllowlist: [],
    } } as unknown as Awaited<ReturnType<NativeRsiInstallPorts['prepare']>>
  const ports: NativeRsiInstallPorts = {
    home,
    now: () => state.now,
    prepare: vi.fn(async () => prepared),
    compile: vi.fn(value => ({ targetPatch: installedPatch,
      manifest: { schemaVersion: 1, now: value.now, expiresAt: value.expiresAt, owner: value.owner,
        controlPlane: { trustPath: join(configRoot, 'native-trust.json'), runtimeObserver: value.observer,
          sourceBuild: value.sourceBuild } },
      trust: { schemaVersion: 1, owner: value.owner },
    }) as unknown as ReturnType<NativeRsiInstallPorts['compile']>),
    dump: vi.fn(() => readFileSync(patchPath, 'utf8')),
    snapshot: vi.fn(async () => ({ bindings: state.bindings } as unknown as Awaited<ReturnType<NativeRsiInstallPorts['snapshot']>>)),
    inventory: vi.fn(async () => state.inventory as Awaited<ReturnType<NativeRsiInstallPorts['inventory']>>),
    inspect: vi.fn(() => {
      if (state.foreignService) throw new Error('loaded service belongs to another installation')
      return { registered: state.registered, pid: state.registered ? 1234 : 0 }
    }),
    validatePlist: vi.fn(),
    stop: vi.fn(async () => { state.stops++; state.registered = false
      if (state.driftOnStop) state.inventory = { ...state.inventory, records: [{ id: 'foreign-automation' }] } }),
    start: vi.fn(async () => { state.starts++; state.registered = true }),
    ready: vi.fn(async () => { if (state.failReady) throw new Error('injected readiness failure') }),
  }
  return { home, input, state, ports, paths, configRoot, patchPath, originalPatch, installedPatch }
}

describe('native RSI installation transaction', () => {
  test('does not reuse a frozen Docker plan after switching to the native backend', async () => {
    const f = await fixture()
    await installNativeRsiOwnerDeployment(f.input, f.ports)
    const original = f.ports.prepare
    f.ports.prepare = vi.fn(async (input, signal) => {
      const prepared = await original(input, signal)
      return { ...prepared, build: { ...prepared.build, schemaVersion: 2 as const } } as Awaited<ReturnType<NativeRsiInstallPorts['prepare']>>
    })
    const stops = f.state.stops
    await expect(installNativeRsiOwnerDeployment(f.input, f.ports))
      .rejects.toThrow('frozen Docker installation plan cannot be resumed')
    expect(f.state.stops).toBe(stops)
  })

  test('rejects a DSH_HOME whose native observer socket exceeds the path limit', async () => {
    const f = await fixture()
    const dshHome = join(f.home, 'x'.repeat(90))
    await mkdir(join(dshHome, 'profiles', f.input.profile), { recursive: true, mode: 0o700 })
    expect(Buffer.byteLength(join(dshHome, '.rsi-123456789012', 'observe.sock'))).toBeGreaterThan(100)
    await expect(installNativeRsiOwnerDeployment({ ...f.input, dshHome }, f.ports))
      .rejects.toThrow('DSH_HOME is too long for a native Unix socket')
    expect(f.ports.stop).not.toHaveBeenCalled()
    expect(f.ports.start).not.toHaveBeenCalled()
  })

  test.each(['patch', 'plist'])('rejects a group-writable %s before stopping the Host', async kind => {
    const f = await fixture()
    const path = kind === 'patch' ? f.patchPath : f.paths.plistPath
    if (kind === 'plist') {
      await mkdir(join(f.home, 'Library', 'LaunchAgents'), { recursive: true, mode: 0o700 })
      await writeFile(path, '<plist>existing service bytes</plist>\n', { mode: 0o600 })
    }
    await chmod(path, 0o620)
    await expect(installNativeRsiOwnerDeployment(f.input, f.ports)).rejects.toThrow('unsafe file')
    expect(f.ports.stop).not.toHaveBeenCalled()
    expect(f.ports.start).not.toHaveBeenCalled()
  })

  test('commits once and a retry preserves the original finite grant expiry', async () => {
    const f = await fixture()
    const first = await installNativeRsiOwnerDeployment(f.input, f.ports)
    expect(first).toMatchObject({ mode: 'ready', profiles: [f.input.profile] })
    expect(await readFile(f.patchPath, 'utf8')).toBe(f.installedPatch)
    const planPath = join(f.configRoot, 'native-plan.json'), manifestPath = join(f.configRoot, 'native-manifest.json')
    const plan = await readFile(planPath, 'utf8'), manifest = await readFile(manifestPath, 'utf8')
    const firstExpiry = JSON.parse(plan).expiresAt as number
    expect(firstExpiry).toBe(f.state.now + 365 * 86_400_000)
    expect(JSON.parse(await readFile(join(f.configRoot, 'native-journal.json'), 'utf8')).stage).toBe('ready')
    f.state.now += 86_400_000
    expect(await installNativeRsiOwnerDeployment(f.input, f.ports)).toEqual(first)
    expect(await readFile(planPath, 'utf8')).toBe(plan)
    expect(await readFile(manifestPath, 'utf8')).toBe(manifest)
    expect(JSON.parse(await readFile(planPath, 'utf8')).expiresAt).toBe(firstExpiry)
    const previousStops = f.state.stops
    f.state.now = firstExpiry + 1
    await expect(installNativeRsiOwnerDeployment(f.input, f.ports)).rejects.toThrow('native grant expired')
    expect(f.state.stops).toBe(previousStops)
    expect(await readFile(planPath, 'utf8')).toBe(plan)
  })

  test('restores exact profile and plist bytes after readiness failure, then retries frozen authority', async () => {
    const f = await fixture(); f.state.failReady = true
    const originalPlist = '<plist>existing service bytes</plist>\n'
    await mkdir(join(f.home, 'Library'), { mode: 0o700 })
    await mkdir(join(f.home, 'Library', 'LaunchAgents'), { mode: 0o700 })
    await writeFile(f.paths.plistPath, originalPlist, { mode: 0o600 })
    f.state.registered = true
    await expect(installNativeRsiOwnerDeployment(f.input, f.ports)).rejects.toThrow('injected readiness failure')
    expect(await readFile(f.patchPath, 'utf8')).toBe(f.originalPatch)
    expect(await readFile(f.paths.plistPath, 'utf8')).toBe(originalPlist)
    const planPath = join(f.configRoot, 'native-plan.json'), frozen = await readFile(planPath, 'utf8')
    expect(JSON.parse(await readFile(join(f.configRoot, 'native-journal.json'), 'utf8')).stage).toBe('rolled-back')
    expect(f.state.registered).toBe(true)
    f.state.failReady = false; f.state.now += 86_400_000
    await expect(installNativeRsiOwnerDeployment(f.input, f.ports)).resolves.toMatchObject({ mode: 'ready' })
    expect(await readFile(planPath, 'utf8')).toBe(frozen)
    expect(await readFile(f.patchPath, 'utf8')).toBe(f.installedPatch)
  })

  test('a failed verification retry preserves the already installed profile and service', async () => {
    const f = await fixture()
    await installNativeRsiOwnerDeployment(f.input, f.ports)
    const installedPlist = await readFile(f.paths.plistPath, 'utf8')
    f.state.failReady = true
    await expect(installNativeRsiOwnerDeployment(f.input, f.ports)).rejects.toThrow('injected readiness failure')
    expect(await readFile(f.patchPath, 'utf8')).toBe(f.installedPatch)
    expect(await readFile(f.paths.plistPath, 'utf8')).toBe(installedPlist)
    expect(f.state.registered).toBe(true)
  })

  test('an interrupted applied journal keeps the original rollback boundary', async () => {
    const f = await fixture()
    await installNativeRsiOwnerDeployment(f.input, f.ports)
    const journalPath = join(f.configRoot, 'native-journal.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, unknown>
    await writeFile(journalPath, JSON.stringify({ ...journal, stage: 'applied',
      beforePatch: f.originalPatch, beforePlist: null, registered: false }), { mode: 0o600 })
    f.state.registered = false; f.state.failReady = true
    await expect(installNativeRsiOwnerDeployment(f.input, f.ports)).rejects.toThrow('injected readiness failure')
    expect(await readFile(f.patchPath, 'utf8')).toBe(f.originalPatch)
    await expect(readFile(f.paths.plistPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(journalPath, 'utf8')).stage).toBe('rolled-back')
  })

  test('rejects owner and Automation inventory drift without applying the new profile', async () => {
    const owner = await fixture()
    await installNativeRsiOwnerDeployment(owner.input, owner.ports)
    const previousStops = owner.state.stops
    owner.state.bindings = [{ id: 'other-owner', version: 1 }]
    await expect(installNativeRsiOwnerDeployment(owner.input, owner.ports)).rejects.toThrow('owner')
    expect(owner.state.stops).toBe(previousStops)
    expect(await readFile(owner.patchPath, 'utf8')).toBe(owner.installedPatch)

    const automation = await fixture(); automation.state.driftOnStop = true
    await expect(installNativeRsiOwnerDeployment(automation.input, automation.ports)).rejects.toThrow('inventory changed while stopping')
    expect(await readFile(automation.patchPath, 'utf8')).toBe(automation.originalPatch)
    expect(JSON.parse(await readFile(join(automation.configRoot, 'native-journal.json'), 'utf8')).stage).toBe('rolled-back')
  })

  test('does not stop a foreign loaded service or overwrite its plist', async () => {
    const f = await fixture()
    const bytes = '<plist>foreign service</plist>\n'
    await mkdir(join(f.home, 'Library'), { mode: 0o700 })
    await mkdir(join(f.home, 'Library', 'LaunchAgents'), { mode: 0o700 })
    await writeFile(f.paths.plistPath, bytes, { mode: 0o600 })
    f.state.foreignService = true
    await expect(installNativeRsiOwnerDeployment(f.input, f.ports)).rejects.toThrow('another installation')
    expect(f.state.stops).toBe(0)
    expect(await readFile(f.paths.plistPath, 'utf8')).toBe(bytes)
    expect(await readFile(f.patchPath, 'utf8')).toBe(f.originalPatch)
  })

  test('rolls back when the owner rotates while startup is being observed', async () => {
    const f = await fixture()
    f.ports.ready = async () => { f.state.bindings = [{ id: 'replacement-owner', version: 2 }] }
    await expect(installNativeRsiOwnerDeployment(f.input, f.ports)).rejects.toThrow('owner changed during startup')
    expect(await readFile(f.patchPath, 'utf8')).toBe(f.originalPatch)
    expect(f.state.registered).toBe(false)
  })
})

describe('native pluginRevision transaction and runner directory preparation', () => {
  test('defaults enableRevision to true, honors opt-out, preserves plan across retries, and rejects incompatible toggles', async () => {
    const withWrappedCompile = (f: Awaited<ReturnType<typeof fixture>>) => {
      const baseCompile = f.ports.compile
      const calls: boolean[] = []
      f.ports.compile = vi.fn(value => {
        const enabled = value.enableRevision !== false
        calls.push(enabled)
        const base = baseCompile(value)
        if (!enabled) return base
        return {
          ...base,
          manifest: {
            ...base.manifest,
            pluginRevision: {
              revision: {}, reviews: {}, regressions: {}, verifications: {}, regressionVerifications: {},
            },
          },
        } as unknown as ReturnType<NativeRsiInstallPorts['compile']>
      })
      return calls
    }

    const f = await fixture()
    const calls = withWrappedCompile(f)
    await expect(installNativeRsiOwnerDeployment(f.input, f.ports)).resolves.toMatchObject({ mode: 'ready' })
    expect(calls).toEqual([true])
    // Idempotent retry preserves stored pluginRevision and rejects opt-out downgrade.
    await expect(installNativeRsiOwnerDeployment(f.input, f.ports)).resolves.toMatchObject({ mode: 'ready' })
    expect(calls).toEqual([true, true])
    await expect(installNativeRsiOwnerDeployment({ ...f.input, enableRevision: false }, f.ports))
      .rejects.toThrow('cannot drop plugin revision')
    await expect(installNativeRsiOwnerDeployment({ ...f.input, enableRevision: 'bad' as unknown as boolean }, f.ports))
      .rejects.toThrow('invalid native revision opt-in')

    // Separate fresh profile with explicit enableRevision: false opt-out.
    const fOptOut = await fixture()
    const optOutCalls = withWrappedCompile(fOptOut)
    await expect(installNativeRsiOwnerDeployment({ ...fOptOut.input, enableRevision: false }, fOptOut.ports))
      .resolves.toMatchObject({ mode: 'ready' })
    expect(optOutCalls).toEqual([false])
    await expect(installNativeRsiOwnerDeployment(fOptOut.input, fOptOut.ports)).resolves.toMatchObject({ mode: 'ready' })
    expect(optOutCalls).toEqual([false, false])
    await expect(installNativeRsiOwnerDeployment({ ...fOptOut.input, enableRevision: true }, fOptOut.ports))
      .rejects.toThrow('cannot be expanded with plugin revision')
  })

  test('prepare prepares 0700 revision-review-runner and revision-regression-runner dirs unless enableRevision is false', async () => {
    const f = await fixture()
    const { lstat } = await import('node:fs/promises')
    const prepared = await f.ports.prepare(f.input, new AbortController().signal)
    vi.resetModules()
    vi.doMock('../src/rsi-source.js', () => ({ prepareRsiSourceWorkspace: async () => ({ schemaVersion: 1, sourceCommit: 'a'.repeat(40), repository: '/tmp/repo', baseline: {} }) }))
    vi.doMock('../src/rsi-authority-resources.js', () => ({ prepareRsiAuthorityResources: async (input: { profile: string }) => ({ stateRoot: join(f.input.dshHome, 'rsi-authorities', input.profile, 'state'), configRoot: prepared.resources.configRoot }) }))
    vi.doMock('../src/rsi-native-runtime-bootstrap.js', () => ({
      prepareNativeRsiRuntime: async () => ({ schemaVersion: 2, sourceCommit: 'a'.repeat(40), runtime: {}, sourceBuild: {} }),
      nativeRsiCreationBuild: (build: { sourceCommit: string; runtime: unknown }) => ({ schemaVersion: 2, backend: 'macos-seatbelt', sourceCommit: build.sourceCommit, runtime: build.runtime }),
    }))
    vi.doMock('../src/rsi-install-inputs.js', async importOriginal => ({
      ...await importOriginal<typeof import('../src/rsi-install-inputs.js')>(),
      resolveInstalledRsiDsh: async () => ({ version: '1.0.0', path: process.execPath, pin: { sha256: 'b'.repeat(64) } }),
    }))

    try {
      const mod = await import('../src/rsi-native-install.js')
      const defaultStateRoot = join(f.input.dshHome, 'rsi-authorities', f.input.profile, 'state')
      await mod.nativeRsiInstallPorts.prepare(f.input, new AbortController().signal)
      for (const name of ['creation-review-runner', 'creation-adoption-runner', 'revision-review-runner', 'revision-regression-runner']) {
        const info = await lstat(join(defaultStateRoot, name))
        expect(info.isDirectory()).toBe(true)
        expect(info.mode & 0o777).toBe(0o700)
      }

      const optOutProfile = `${f.input.profile}-optout`
      const optOutStateRoot = join(f.input.dshHome, 'rsi-authorities', optOutProfile, 'state')
      await mkdir(optOutStateRoot, { recursive: true, mode: 0o700 })
      await mod.nativeRsiInstallPorts.prepare({ ...f.input, profile: optOutProfile, enableRevision: false }, new AbortController().signal)
      for (const name of ['creation-review-runner', 'creation-adoption-runner']) {
        const info = await lstat(join(optOutStateRoot, name))
        expect(info.isDirectory()).toBe(true)
        expect(info.mode & 0o777).toBe(0o700)
      }
      await expect(lstat(join(optOutStateRoot, 'revision-review-runner'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(lstat(join(optOutStateRoot, 'revision-regression-runner'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      vi.doUnmock('../src/rsi-source.js')
      vi.doUnmock('../src/rsi-authority-resources.js')
      vi.doUnmock('../src/rsi-native-runtime-bootstrap.js')
      vi.doUnmock('../src/rsi-install-inputs.js')
      vi.resetModules()
    }
  })

  test('upgradeExistingOwner upgrades with real compileNativeRsiProfile and rollback restores native-journal.json for bare retry', async () => {
    const home = await mkdtemp(join(await realpath(tmpdir()), 'ni-upg-'))
    homes.push(home)
    const dshHome = join(home, '.dsh')
    const profile = 'web'
    const profileRoot = join(dshHome, 'profiles', profile)
    const workspace = join(home, 'w')
    const sourceRoot = join(home, 's')
    const release = join(home, 'r')
    for (const dir of [dshHome, join(dshHome, 'profiles'), profileRoot, workspace, sourceRoot, release]) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await chmod(dir, 0o700)
    }
    const resources = await prepareRsiAuthorityResources({ dshHome, profile })
    for (const name of ['creation-review-runner', 'creation-adoption-runner', 'revision-review-runner', 'revision-regression-runner']) {
      await mkdir(join(resources.stateRoot, name), { mode: 0o700 })
    }
    const patchPath = join(profileRoot, 'cordis.patch.yml')
    await writeFile(patchPath, "- id: custom-row\n  name: custom-package\n  config: { keep: true }\n", { mode: 0o600 })

    const principal = { channel: 'lark' as const, account: 'account', tenant: 'tenant', user: 'owner' }
    const conversation = { channel: 'lark' as const, account: 'account', tenant: 'tenant', kind: 'dm' as const, chat: 'chat' }
    const owner = {
      id: 'binding', conversation, principal, workspace, agentPreset: 'primary', sessionId: 'session',
      generation: 1, policyRef: 'owner-policy', status: 'active' as const, createdAt: 1, updatedAt: 1, version: 1,
      owner: { id: 'principal-record', principal, role: 'owner' as const, status: 'active' as const, createdAt: 1, updatedAt: 1, version: 1 },
    }
    const baseRow = (name: string, config: object, extra = {}) => ({ id: `dsh-enhanced-${name}`, name: `@dsh-enhanced/${name}`, config, ...extra })
    const baseRows = [
      baseRow('personal-assistant', {
        assistantPolicy: { databasePath: join(home, 'policy.sqlite'), budgets: [], rules: [] },
        assistantAutomations: { databasePath: join(home, 'automations.sqlite'), runsPath: join(home, 'runs'),
          schedulerEnabled: false, allowUnbudgetedExecution: false },
        personalMemory: { databasePath: join(home, 'memory.sqlite') },
      }),
      baseRow('assistant-delivery', { defaultWorkspace: workspace, defaultAgentPreset: 'primary', ownerRoutes: [],
        agentProvider: 'deepseek-official', agentModel: 'deepseek-v4-flash' }),
      baseRow('assistant-verifier', { databasePath: join(home, 'verifier.sqlite') }),
      baseRow('assistant-growth-driver', { provider: 'owner-provider', model: 'owner-model' }),
      { id: 'dsh-enhanced-assistant-memory-learning', name: '@dsh-enhanced/assistant-memory-learning', disabled: true },
      baseRow('plugin-control-plane', {}),
      baseRow('lark-channel', { enabled: true }),
      baseRow('assistant-proactive', {}),
      baseRow('assistant-work-items', { enabled: true, mode: 'observe', intakeLedger: { enabled: true } }),
    ]

    const runtimeRoot = join(dshHome, 'rsi-native-runtimes', profile, 'runtime')
    const runtime = {
      schemaVersion: 1 as const,
      platform: `darwin-${process.arch}` as 'darwin-arm64' | 'darwin-x64',
      nodePath: join(runtimeRoot, 'bin', 'node'),
      nodeSha256: 'a'.repeat(64),
      roots: [{ path: runtimeRoot, dev: 1, ino: 2, sha256: 'b'.repeat(64) }],
      modulesPath: join(runtimeRoot, 'node_modules'),
      versions: { node: 'v24.22.0', typescript: '5.9.3', cordis: '3.0.0', tools: '1.0.0', systemPrompt: '1.0.0' },
    }
    const executorPath = join(home, 'dsh')
    const executorBytes = '#!/bin/sh\nexit 0\n'
    await writeFile(executorPath, executorBytes, { mode: 0o500 })
    const executor = {
      id: 'dsh', version: '1', path: executorPath,
      sha256: createHash('sha256').update(executorBytes).digest('hex'), environmentAllowlist: [],
    }
    const state = {
      registered: false,
      now: 1_800_000_000_000,
      sourceCommit: 'b'.repeat(40),
      failReady: false,
    }
    const paths = launchAgentPaths({ dshHome, profile, home })
    const dumpEffective = () => {
      const currentPatch = parse(readFileSync(patchPath, 'utf8')) as Array<{ id: string; name?: string; disabled?: boolean; config?: Record<string, unknown> }>
      const patchMap = new Map(currentPatch.map(row => [row.id, row]))
      const baseIds = new Set(baseRows.map(row => row.id))
      return stringify([
        ...baseRows.map(row => {
          const patched = patchMap.get(row.id)
          return patched ? { ...row, ...patched } : row
        }),
        ...currentPatch.filter(row => !baseIds.has(row.id)),
      ])
    }
    const ports: NativeRsiInstallPorts = {
      home,
      now: () => state.now,
      prepare: vi.fn(async () => ({
        source: {
          schemaVersion: 1 as const, version: '0.1.84',
          origin: { kind: 'local-head' as const, locator: home, ref: 'HEAD' },
          sourceCommit: state.sourceCommit, repository: sourceRoot,
          baseline: { ref: 'refs/dsh-source/repairs', remote: release, targetBranch: 'repairs', initialCommit: state.sourceCommit },
        },
        resources,
        build: {
          schemaVersion: 2 as const,
          sourceBuild: { backend: 'macos-seatbelt' as const, runtime, timeoutMs: 60_000 as const,
            outputBytes: 1_048_576 as const, versioning: 'patch' as const },
        },
        creationBuild: { schemaVersion: 2 as const, backend: 'macos-seatbelt' as const, sourceCommit: state.sourceCommit, runtime },
        executor,
      }) as unknown as Awaited<ReturnType<NativeRsiInstallPorts['prepare']>>),
      compile: vi.fn(value => compileNativeRsiProfile(value)),
      dump: vi.fn(dumpEffective),
      snapshot: vi.fn(async () => ({ bindings: [owner] }) as unknown as Awaited<ReturnType<NativeRsiInstallPorts['snapshot']>>),
      inventory: vi.fn(async () => ({
        databasePath: join(dshHome, 'automations.sqlite'), schedulerEnabled: false, records: [],
      }) as unknown as Awaited<ReturnType<NativeRsiInstallPorts['inventory']>>),
      inspect: vi.fn(() => ({ registered: state.registered, pid: state.registered ? 1234 : 0 })),
      validatePlist: vi.fn(),
      stop: vi.fn(async () => { state.registered = false }),
      start: vi.fn(async () => { state.registered = true }),
      ready: vi.fn(async () => { if (state.failReady) throw new Error('injected native upgrade readiness failure') }),
    }

    // 1. Fresh install with enableRevision: false & enableOrdinaryUseLearning: false
    const first = await installNativeRsiOwnerDeployment({ dshHome, profile, enableRevision: false }, ports)
    expect(first.mode).toBe('ready')
    const planPath = join(resources.configRoot, 'native-plan.json')
    const manifestPath = join(resources.configRoot, 'native-manifest.json')
    const trustPath = join(resources.configRoot, 'native-trust.json')
    const journalPath = join(resources.configRoot, 'native-journal.json')
    const planBeforeRollback = await readFile(planPath, 'utf8')
    const manifestBeforeRollback = await readFile(manifestPath, 'utf8')
    const trustBeforeRollback = await readFile(trustPath, 'utf8')
    const journalBeforeRollback = await readFile(journalPath, 'utf8')
    const patchBeforeRollback = await readFile(patchPath, 'utf8')
    const plistBeforeRollback = await readFile(paths.plistPath, 'utf8')

    // 2. Bare retry expanding ordinary-use learning without upgradeExistingOwner fails closed
    await expect(installNativeRsiOwnerDeployment({ dshHome, profile, enableOrdinaryUseLearning: true }, ports))
      .rejects.toThrow('cannot be expanded with ordinary-use learning')

    // 3. Upgrade failure during readiness rolls back plan, manifest, trust, journal, patch, and plist cleanly
    state.failReady = true
    state.sourceCommit = 'c'.repeat(40)
    await expect(installNativeRsiOwnerDeployment({
      dshHome, profile, enableOrdinaryUseLearning: true, enableRevision: true, upgradeExistingOwner: true,
    }, ports)).rejects.toThrow('injected native upgrade readiness failure')

    expect(await readFile(planPath, 'utf8')).toBe(planBeforeRollback)
    expect(await readFile(manifestPath, 'utf8')).toBe(manifestBeforeRollback)
    expect(await readFile(trustPath, 'utf8')).toBe(trustBeforeRollback)
    expect(await readFile(journalPath, 'utf8')).toBe(journalBeforeRollback)
    expect(await readFile(patchPath, 'utf8')).toBe(patchBeforeRollback)
    expect(await readFile(paths.plistPath, 'utf8')).toBe(plistBeforeRollback)
    expect(state.registered).toBe(true)

    // 4. Subsequent bare retry (with original sourceCommit and failReady cleared) succeeds without journal mismatch!
    state.failReady = false
    state.sourceCommit = 'b'.repeat(40)
    await expect(installNativeRsiOwnerDeployment({ dshHome, profile }, ports)).resolves.toMatchObject({ mode: 'ready' })

    // 5. Explicit upgradeExistingOwner: true succeeds and updates grants & sourceCommit
    state.sourceCommit = 'c'.repeat(40)
    const upgraded = await installNativeRsiOwnerDeployment({
      dshHome, profile, enableOrdinaryUseLearning: true, enableRevision: true,
      intakeProvider: 'deepseek-official', intakeModel: 'deepseek-chat', upgradeExistingOwner: true,
    }, ports)
    expect(upgraded.mode).toBe('ready')
    const upgradedManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    expect(upgradedManifest.now).toBe(1_800_000_000_000)
    expect(upgradedManifest.expiresAt).toBe(1_800_000_000_000 + 365 * 86_400_000)
    expect(upgradedManifest.ordinaryUseLearning.intakeEvaluation).toMatchObject({
      provider: 'deepseek-official', model: 'deepseek-chat',
    })
    expect(upgradedManifest.pluginRevision).toBeDefined()
    expect(JSON.parse(await readFile(journalPath, 'utf8')).stage).toBe('ready')

    // 6. Real /autonomy disable disables all Contract 1 rows (growth, memory, proactive, work-items);
    //    bare retry fails closed, while upgradeExistingOwner: true upgrades and re-enables cleanly
    const toggleOff = await applySelfIterationProfileToggle({ dshHome, profile, enable: false })
    expect(toggleOff).toMatchObject({ ok: true, state: 'disabled' })
    const disabledPatch = parse(await readFile(patchPath, 'utf8')) as Array<{ id: string; disabled?: boolean; config?: Record<string, unknown> }>
    for (const id of ['dsh-enhanced-assistant-growth-driver', 'dsh-enhanced-assistant-memory-learning',
      'dsh-enhanced-assistant-proactive', 'dsh-enhanced-assistant-work-items']) {
      expect(disabledPatch.find(row => row.id === id)?.disabled).toBe(true)
    }
    expect(disabledPatch.find(row => row.id === 'dsh-enhanced-assistant-work-items')?.config?.enabled).toBe(false)

    await expect(installNativeRsiOwnerDeployment({ dshHome, profile }, ports)).rejects.toThrow()

    const afterDisableUpgrade = await installNativeRsiOwnerDeployment({
      dshHome, profile, enableOrdinaryUseLearning: true, enableRevision: true, upgradeExistingOwner: true,
    }, ports)
    expect(afterDisableUpgrade.mode).toBe('ready')
    const reenabledPatch = parse(await readFile(patchPath, 'utf8')) as Array<{ id: string; disabled?: boolean; config?: Record<string, unknown> }>
    for (const id of ['dsh-enhanced-assistant-growth-driver', 'dsh-enhanced-assistant-memory-learning',
      'dsh-enhanced-assistant-proactive', 'dsh-enhanced-assistant-work-items']) {
      expect(reenabledPatch.find(row => row.id === id)?.disabled).toBe(false)
    }
    expect(reenabledPatch.find(row => row.id === 'dsh-enhanced-assistant-work-items')?.config?.enabled).toBe(true)
    expect(reenabledPatch.find(row => row.id === 'dsh-enhanced-assistant-growth-driver')?.config?.enabled).toBe(true)
  })
})
