import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { installNativeRsiOwnerDeployment, type NativeRsiInstallPorts } from '../src/rsi-native-install.ts'
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
