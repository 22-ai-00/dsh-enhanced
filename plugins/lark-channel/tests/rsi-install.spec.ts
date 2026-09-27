import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { installRsiOwnerDeployment, rsiCoordinatorProfile, rsiInstallPorts, type RsiInstallPorts } from '../src/rsi-install.js'
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
    collect: vi.fn(async () => ({ dsh:{root:'/fixture/dsh',path:f.input.executor.path,version:f.input.executor.version,pin:f.input.executor},
      executor:f.input.executor,git:f.input.manifest.sourceReviews.git,systemctl:f.input.systemctl,
      plugins:[...f.input.manifest.sourceReviews.plugins],policies:f.input.policies,
      observerTargets:f.input.manifest.controlPlane.runtimeObserver!.targets.filter(target => !['dsh-enhanced-assistant-growth-driver','dsh-enhanced-assistant-verifier'].includes(target.entryId)),
      hostDeploymentInputs:[...f.input.manifest.controlPlane.sourceAdoptions!.hostDeploymentInputs!] })),
    coordinator: vi.fn(async () => {}),
    stop: vi.fn(async (_input,name) => { stops.push(name); return true }),
    capture: vi.fn(async () => unitProperties), readUnit: vi.fn(async () => unitProperties),
    ready: vi.fn(async () => {}),
  }
  // The synchronous dump port reads current profile bytes just like dsh --dump-config.
  const { readFileSync } = await import('node:fs')
  setup.dump = vi.fn(name => { patches[name] = readFileSync(join(home,'profiles',name,'cordis.patch.yml'),'utf8'); return dump(name) })
  return {f,home,profile,coordinator,ports,starts,stops,input:{dshHome:home,profile}}
}

describe('automatic owner deployment', () => {
  test('applies real owner/profile/authority transaction, starts coordinator first, and preserves frozen installation on retry', async () => {
    const f = await fixture()
    const first = await installRsiOwnerDeployment(f.input,f.ports)
    expect(first.mode).toBe('ready')
    expect(f.starts).toEqual([f.coordinator,f.profile])
    const manifest = await readFile(join(f.f.input.resources.configRoot,'manifest.json'),'utf8')
    const key = await readFile(join(f.f.input.resources.configRoot,'observer.key'))
    expect(f.ports.ready).toHaveBeenCalledOnce()
    expect(vi.mocked(f.ports.ready).mock.calls[0]![3]).toBeGreaterThan(0)
    // Simulate an interrupted two-profile write: one side still has its old patch.
    const journalPath = join(f.home,'.rsi-setup-journal.json')
    const journal = JSON.parse(await readFile(journalPath,'utf8')) as {stage:string;entries:Array<{profile:string;before:string}>}
    journal.stage = 'prepared'
    await writeFile(journalPath,JSON.stringify(journal),{mode:0o600})
    await writeFile(join(f.home,'profiles',f.coordinator,'cordis.patch.yml'),journal.entries[1]!.before,{mode:0o600})
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
    f.ports.readUnit = vi.fn(async () => ({...f.f.input.unitProperties,User:'changed'}))
    await expect(installRsiOwnerDeployment(f.input,f.ports)).rejects.toThrow('final loaded systemd unit differs')
    expect(f.starts).toEqual([])
    expect(await readFile(join(f.home,'profiles',f.profile,'cordis.patch.yml'),'utf8')).toBe('[]\n')
  },120_000)
})
