import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { runtimeConfigDigest } from '@dsh-enhanced/plugin-control-plane'
import { growthObjectDigest } from '@dsh-enhanced/assistant-growth-contract'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { assertRsiMemoryScanActivation, installRsiOwnerDeployment, rsiCoordinatorProfile, rsiInstallPorts, type RsiInstallPorts } from '../src/rsi-install.js'
import { rsiSetupPorts } from '../src/rsi-setup.js'
import { RsiBuildUnavailableError } from '../src/rsi-build.js'
import { RsiInstalledInputsUnavailableError } from '../src/rsi-install-inputs.js'
import { rsiBootstrapFixture } from './fixtures/rsi-bootstrap.js'

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
  const ports: RsiInstallPorts = { ...rsiInstallPorts, setup,
    prepare: vi.fn(async () => ({ source:f.input.source, runtime:f.input.runtime,resources:f.input.resources,
      build:{schemaVersion:1 as const,sourceCommit:f.input.source.sourceCommit,sourceBuild:f.input.manifest.controlPlane.sourceBuild!},
      release:{schemaVersion:1 as const,sourceCommit:f.input.source.sourceCommit,image:'sha256:'+'a'.repeat(64),releaseBuild:f.input.releaseBuild} })),
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
    stop: vi.fn(async (_input,name) => { stops.push(name); return true }),
    capture: vi.fn(async () => unitProperties), readUnit: vi.fn(async () => unitProperties),
    ready: vi.fn(async () => {}),
  }
  // The synchronous dump port reads current profile bytes just like dsh --dump-config.
  const { readFileSync } = await import('node:fs')
  setup.dump = vi.fn(name => { patches[name] = readFileSync(join(home,'profiles',name,'cordis.patch.yml'),'utf8'); return dump(name) })
  return {f,home,profile,coordinator,ports,starts,stops,originals,input:{dshHome:home,profile}}
}

describe('automatic owner deployment', () => {
  test('rejects persisted creation, receipt and grant file drift before either Host is stopped', async () => {
    const f = await fixture()
    for (const name of ['creation-review-runner', 'creation-adoption-runner']) {
      await mkdir(join(f.f.input.resources.stateRoot, name), { mode: 0o700 })
    }
    const prepared = await f.ports.prepare(f.input, new AbortController().signal)
    vi.mocked(f.ports.prepare).mockResolvedValue({ ...prepared, creationBuild: {
      schemaVersion: 1, sourceCommit: prepared.source.sourceCommit,
      sourceImage: prepared.build.sourceBuild.image, image: `sha256:${'b'.repeat(64)}`,
      dockerPath: prepared.build.sourceBuild.dockerPath } })
    expect((await installRsiOwnerDeployment(f.input, f.ports)).mode).toBe('ready')
    const config = f.f.input.resources.configRoot
    const cases = [
      { name: 'manifest.json', change: (value: any) => { value.pluginCreation.reviews.runner.image = `sha256:${'c'.repeat(64)}` } },
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
    for (const name of ['creation-review-runner', 'creation-adoption-runner']) {
      await mkdir(join(f.f.input.resources.stateRoot, name), { mode: 0o700 })
    }
    const prepared = await f.ports.prepare(f.input, new AbortController().signal)
    const creationBuild = { schemaVersion: 1 as const, sourceCommit: prepared.source.sourceCommit,
      sourceImage: prepared.build.sourceBuild.image, image: `sha256:${'b'.repeat(64)}`,
      dockerPath: prepared.build.sourceBuild.dockerPath }
    vi.mocked(f.ports.prepare).mockResolvedValue({ ...prepared, creationBuild })
    const first = await installRsiOwnerDeployment(f.input, f.ports)
    expect(first.mode).toBe('ready')
    const path = join(f.f.input.resources.configRoot, 'manifest.json')
    const bytes = await readFile(path, 'utf8')
    const manifest = JSON.parse(bytes)
    expect(manifest.pluginCreation.reviews.runner.image).toBe(creationBuild.image)
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
  })
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
    expect(JSON.parse(manifest).pluginCreation).toBeUndefined()
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
    // Even if new build resources are available, replay must preserve a legacy
    // installation's authorization scope rather than enable created plugins.
    const prepared = await f.ports.prepare(f.input, new AbortController().signal)
    vi.mocked(f.ports.prepare).mockResolvedValue({ ...prepared, creationBuild: {
      schemaVersion: 1, sourceCommit: prepared.source.sourceCommit,
      sourceImage: prepared.build.sourceBuild.image, image: `sha256:${'b'.repeat(64)}`,
      dockerPath: prepared.build.sourceBuild.dockerPath } })
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
    f.ports.prepare = vi.fn(async () => { throw new RsiBuildUnavailableError('Docker unavailable') })
    expect(await installRsiOwnerDeployment(f.input,f.ports)).toEqual({mode:'not-ready',reason:'rsi build unavailable: Docker unavailable'})
    expect(f.stops).toEqual([])
    expect(f.ports.coordinator).not.toHaveBeenCalled()
  },120_000)
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
})
