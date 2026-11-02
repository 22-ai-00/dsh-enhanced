import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { isMap, isSeq, parseDocument, stringify } from 'yaml'
import { prepareAutonomyProfile, preflightAutonomyProfile, validateAutonomyOptions } from '../src/autonomy.ts'
import { configureWebOwner, prepareWebOwnerProfile, type WebOwnerSetupInput } from '../src/setup.ts'
import { prepareGoalAdmission } from '../src/goal-admission.ts'
import { DeliveryStore } from '../../assistant-delivery/lib/store.js'
import { IsolationLedger } from '../../assistant-isolation/lib/ledger.js'
import { inspectAutonomyProfile, probeAutonomyProfileRuntime } from '../src/doctor.ts'

// Real profile lock/CAS, YAML and Delivery pairing; resource preparation/probe
// are explicitly recorded stubs. This does not prove Linux isolation readiness.
const resource = vi.hoisted(() => ({ freeze: vi.fn(), prepare: vi.fn(), read: vi.fn(), discover: vi.fn(), probe: vi.fn(), docker: vi.fn(), verify: vi.fn() }))
vi.mock('@dsh-enhanced/assistant-isolation/native-resources', () => ({ freezeLinuxRuntimeSource: resource.freeze,
  prepareLinuxRuntime: resource.prepare, readLinuxRuntime: resource.read, discoverLinuxCgroupRoots: resource.discover, probeLinuxIsolationRuntime: resource.probe }))
vi.mock('@dsh-enhanced/assistant-isolation', async original => ({ ...await original<typeof import('@dsh-enhanced/assistant-isolation')>(), probeIsolationRuntime: resource.docker, verifyLinuxRuntime: resource.verify }))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
beforeEach(() => { for (const stub of Object.values(resource)) stub.mockReset() })
async function fixture() {
  const dshHome = await realpath(await mkdtemp(join(tmpdir(), 'native-ordinary-web-'))); roots.push(dshHome)
  const input: WebOwnerSetupInput = { dshHome, profile: 'web', workspace: join(dshHome, 'workspace'), preset: 'standard',
    isolation: { backend: 'linux-native', maxRuns: 3, leaseMs: 3600000, maxTotalDurationMs: 120000 } }
  const directory = join(dshHome, 'profiles', 'web'); await mkdir(directory, { recursive: true })
  const document = parseDocument('[]')
  for (const slug of ['personal-assistant','assistant-delivery','assistant-goals','assistant-web-owner','assistant-isolation','assistant-actions','credentials-keychain','assistant-verifier','assistant-deepseek-budget']) {
    const published = parseDocument(await readFile(new URL(`../../${slug}/cordis.patch.yml`, import.meta.url), 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
    if (!isSeq(published.contents)) throw new Error('fixture expected patch')
    for (const holder of published.contents.items) if (isMap(holder) && holder.has('insert')) {
      const rows = holder.get('insert', true); if (!isSeq(rows)) throw new Error('fixture expected inserts')
      for (const row of rows.items) document.add(row)
    }
  }
  const effective = document.toString(), plan = prepareWebOwnerProfile(input, '[]', effective)
  const runtimeRoot = join(dshHome, 'rsi-linux-runtimes', 'web', 'runtime')
  const runtime: LinuxRuntime = { schemaVersion: 1, backend: 'linux-native', platform: process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64', sourceCommit: 'a'.repeat(40), lockSha256: 'b'.repeat(64),
    root: { path: runtimeRoot, dev: 1, ino: 2, sha256: 'c'.repeat(64) }, nodePath: join(runtimeRoot,'bin/node'), nodeSha256: 'd'.repeat(64), pnpmPath: join(runtimeRoot,'pnpm/bin/pnpm.mjs'),
    nativePnpmRoot: join(runtimeRoot,'pnpm-native'), nativePnpmPath: join(runtimeRoot,'pnpm-native/pnpm'), modulesPath: join(runtimeRoot,'node_modules'), storePath: join(runtimeRoot,'store'), cachePath: join(runtimeRoot,'cache'),
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '5.9.3', cordis: '4.0.5', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' } }
  const cgroupRoots = { mode: 'v1' as const, cpu: '/sys/fs/cgroup/cpu/uid-1000', memory: '/sys/fs/cgroup/memory/uid-1000', pids: '/sys/fs/cgroup/pids/uid-1000', freezer: '/sys/fs/cgroup/freezer/uid-1000' }
  const frozen = { version: '0.1.65', sourceCommit: runtime.sourceCommit, manifests: [] }
  resource.freeze.mockResolvedValue(frozen); resource.prepare.mockResolvedValue({ schemaVersion: 3, backend: 'linux-native', sourceCommit: runtime.sourceCommit, lockSha256: runtime.lockSha256, runtime })
  resource.read.mockImplementation(async () => ({ schemaVersion: 3, backend: 'linux-native', sourceCommit: runtime.sourceCommit, lockSha256: runtime.lockSha256, runtime: structuredClone(runtime) }))
  resource.discover.mockResolvedValue(cgroupRoots); resource.probe.mockResolvedValue({ ready: true }); resource.docker.mockResolvedValue(undefined); resource.verify.mockResolvedValue(undefined)
  return { input, effective, databasePath: plan.databasePath, patchPath: join(directory,'cordis.patch.yml'), runtime, cgroupRoots }
}
function rows(path: string, sql: string) { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(sql).all() } finally { db.close() } }

test.each(['freeze','prepare','read','discover','probe'] as const)('native %s failure precedes owner pairing and grant/config writes', async stage => {
  const f = await fixture(); resource[stage].mockRejectedValueOnce(new Error(`resource-${stage}-failed`))
  await writeFile(f.patchPath, '# unchanged\n[]\n')
  await expect(configureWebOwner(f.input, f.effective)).rejects.toThrow(`resource-${stage}-failed`)
  expect(existsSync(f.databasePath)).toBe(false)
  expect(await readFile(f.patchPath,'utf8')).toBe('# unchanged\n[]\n')
  expect(resource.docker).not.toHaveBeenCalled()
})

test('native first setup pairs once; replay reads the existing receipt without preparing or refreshing authority', async () => {
  const f = await fixture()
  await configureWebOwner(f.input, f.effective)
  const first = await readFile(f.patchPath,'utf8'), owners = rows(f.databasePath,'SELECT * FROM delivery_principals')
  const parsed = inspectAutonomyProfile(first,'web',f.input.dshHome)
  expect(parsed).toMatchObject({ backend:'linux-native',linux:{runtime:f.runtime,cgroupRoots:f.cgroupRoots} })
  expect(first).not.toMatch(/\b(?:image|dockerPath|socketPath):/u)
  expect(resource.freeze).toHaveBeenCalledWith({ kind:'official-tag',version: JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version })
  expect(resource.prepare).toHaveBeenCalledTimes(1)
  const ledgerPath = join(parsed.stateRoot,'ledger.sqlite'), ledger = new IsolationLedger(ledgerPath)
  ledger.syncGrants([parsed.grant])
  const grant = parsed.grant
  ledger.prepare({ identity:{principalDigest:grant.principalDigest,principalRecordId:grant.principalRecordId,principalVersion:grant.principalVersion,workspace:grant.workspace,agentPreset:grant.agentPreset},
    sessionId:'existing-session',grantId:grant.id,idempotencyKey:'existing-budget-use',requestDigest:'existing-budget-use',durationMs:1000 })
  ledger.close()
  const grantsBefore = rows(ledgerPath,'SELECT * FROM isolation_grants'), jobsBefore = rows(ledgerPath,'SELECT * FROM isolation_jobs')
  await configureWebOwner(f.input,first)
  expect(resource.prepare).toHaveBeenCalledTimes(1)
  expect(await readFile(f.patchPath,'utf8')).toBe(first)
  expect(rows(f.databasePath,'SELECT * FROM delivery_principals')).toEqual(owners)
  expect(rows(ledgerPath,'SELECT * FROM isolation_grants')).toEqual(grantsBefore)
  expect(rows(ledgerPath,'SELECT * FROM isolation_jobs')).toEqual(jobsBefore)
  expect(resource.docker).not.toHaveBeenCalled()
})

test('native source, backend, grant and runtime/state drift fail before pairing or patch mutation', async () => {
  const f = await fixture()
  const docker = { ...f.input, isolation: { image: `sha256:${'e'.repeat(64)}`, maxRuns:3,leaseMs:3600000,maxTotalDurationMs:120000 } }
  const preexisting = prepareAutonomyProfile(docker,prepareWebOwnerProfile(f.input,'[]',f.effective).patch,f.effective,{id:'old-owner',version:1})
  await writeFile(f.patchPath,preexisting)
  await expect(configureWebOwner(f.input,preexisting)).rejects.toThrow(/backend differs/u)
  expect(resource.freeze).not.toHaveBeenCalled(); expect(existsSync(f.databasePath)).toBe(false)
  await writeFile(f.patchPath,'[]')
  await configureWebOwner(f.input,f.effective)
  const first = await readFile(f.patchPath,'utf8'), beforeOwners = rows(f.databasePath,'SELECT * FROM delivery_principals')
  f.runtime.root.sha256 = 'f'.repeat(64)
  await expect(configureWebOwner(f.input,first)).rejects.toThrow(/descriptor differs/u)
  expect(await readFile(f.patchPath,'utf8')).toBe(first)
  expect(rows(f.databasePath,'SELECT * FROM delivery_principals')).toEqual(beforeOwners)
  resource.freeze.mockRejectedValueOnce(new Error('source no longer matches original receipt'))
  await expect(configureWebOwner(f.input,first)).rejects.toThrow(/source no longer matches/u)
  expect(await readFile(f.patchPath,'utf8')).toBe(first)
})

test('native static preflight rejects invalid grant and overlapping roots before resource IO', async () => {
  const f = await fixture()
  const resolved = { ...f.input,isolation:{backend:'linux-native' as const,linux:{runtime:f.runtime,cgroupRoots:f.cgroupRoots},maxRuns:3,leaseMs:3600000,maxTotalDurationMs:120000} }
  const first = prepareAutonomyProfile(resolved,prepareWebOwnerProfile(f.input,'[]',f.effective).patch,f.effective,{id:'old-owner',version:1})
  const bad = first.replace('maxRuns: 3','maxRuns: 4')
  await writeFile(f.patchPath,bad)
  await expect(configureWebOwner(f.input,bad)).rejects.toThrow(/managed isolation grant differs/u)
  expect(resource.freeze).not.toHaveBeenCalled(); expect(existsSync(f.databasePath)).toBe(false)
  const overlap = stringify([{id:'dsh-enhanced-assistant-isolation',config:{stateRoot:join(f.input.dshHome,'rsi-linux-runtimes')}}])
  expect(() => preflightAutonomyProfile({ ...f.input,isolation:f.input.isolation! },overlap,f.effective)).toThrow(/overlaps Linux runtime/u)
})

test('doctor uses only the persisted native descriptor and never prepares, freezes or discovers resources', async () => {
  const f = await fixture(); await configureWebOwner(f.input,f.effective)
  const source = await readFile(f.patchPath,'utf8'), parsed = inspectAutonomyProfile(source,'web',f.input.dshHome)
  for (const stub of Object.values(resource)) stub.mockClear()
  const owner = rows(f.databasePath,'SELECT * FROM delivery_principals')
  await probeAutonomyProfileRuntime(parsed)
  expect(resource.verify).toHaveBeenCalledExactlyOnceWith(f.runtime)
  expect(resource.probe).toHaveBeenCalledExactlyOnceWith({runtime:f.runtime,cgroupRoots:f.cgroupRoots})
  for (const stub of [resource.freeze,resource.prepare,resource.read,resource.discover,resource.docker]) expect(stub).not.toHaveBeenCalled()
  expect(await readFile(f.patchPath,'utf8')).toBe(source)
  expect(rows(f.databasePath,'SELECT * FROM delivery_principals')).toEqual(owner)
})

test('mixed source/image/backend options are rejected and explicit local HEAD is the only development source', () => {
  const finite = {maxRuns:3,leaseMs:60000,maxTotalDurationMs:120000}
  expect(() => validateAutonomyOptions({...finite,backend:'linux-native',source:{kind:'local-head',repository:'/absolute/repository'}})).not.toThrow()
  for (const bad of [
    {...finite,backend:'linux-native',image:'sha256:'+'a'.repeat(64)},
    {...finite,backend:'docker',image:'sha256:'+'a'.repeat(64),source:{kind:'official-tag'}},
    {...finite,backend:'linux-native',source:{kind:'local-head',repository:'relative'}},
    {...finite,backend:'linux-native',source:{kind:'official-tag',version:'0.0.0'}},
  ]) expect(() => validateAutonomyOptions(bad as never)).toThrow()
})


test('native ordinary setup rejects Goal admission before composing an unsupported independent verifier', async () => {
  const f = await fixture(); await configureWebOwner(f.input,f.effective)
  const source = await readFile(f.patchPath,'utf8'), delivery = new DeliveryStore({path:f.databasePath})
  const principal = {channel:'web',account:'web',tenant:'local',user:'operator'}
  const owner = delivery.ensureOwner(principal), binding = delivery.createBinding({conversation:{channel:'web',account:'web',tenant:'local',kind:'dm',chat:'session'},principal,workspace:f.input.workspace,agentPreset:f.input.preset,sessionId:'session',policyRef:'owner-dm'})
  delivery.close()
  const task = JSON.stringify({version:2,objective:'Verify result',route:{provider:'test-provider',model:'test-model'},maxGoalRounds:2,stepMaxDurationMs:60000,
    executionBudget:{mode:'calls',modelCalls:3,toolCalls:3,durationMs:120000,maxOutputTokensPerCall:8192,routes:[{provider:'test-provider',model:'test-model'}]},
    verification:{artifactPath:'result.txt',command:'node verify.mjs',maxRuns:4,maxTotalDurationMs:100000,maxDurationMs:20000,maxOutputBytes:4096,cases:[{stdin:'one',expectedStdout:'one',expectedExitCode:0}]}})
  const before = rows(f.databasePath,'SELECT * FROM delivery_principals')
  expect(() => prepareGoalAdmission(f.input,source,f.effective,task,{owner,binding})).toThrow(/native Goal independent verification is not supported yet/u)
  expect(await readFile(f.patchPath,'utf8')).toBe(source)
  expect(rows(f.databasePath,'SELECT * FROM delivery_principals')).toEqual(before)
})

test('explicit local HEAD source uses installed version and a final receipt failure still cannot pair', async () => {
  const f = await fixture()
  f.input.isolation = {backend:'linux-native',source:{kind:'local-head',repository:f.input.dshHome},maxRuns:3,leaseMs:3600000,maxTotalDurationMs:120000}
  const firstRead = resource.read.getMockImplementation()!
  resource.read.mockImplementationOnce(firstRead).mockRejectedValueOnce(new Error('receipt changed after probe'))
  await expect(configureWebOwner(f.input,f.effective)).rejects.toThrow(/receipt changed after probe/u)
  expect(resource.freeze).toHaveBeenCalledWith({kind:'local-head',repository:f.input.dshHome,version:JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version})
  expect(resource.probe).toHaveBeenCalledTimes(1)
  expect(existsSync(f.databasePath)).toBe(false)
  expect(existsSync(f.patchPath)).toBe(false)
})
