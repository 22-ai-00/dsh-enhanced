import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { assertLocalSourceNativeResources, bindLocalSourceInstaller, localSourceResourceBackend } from '../scripts/install/local-source-maintenance.mjs'
import { lifecycleProfileTest } from '../scripts/install/lifecycle-profile.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true}))) })
const digest = 'a'.repeat(64), logicalHome = '/srv/native-local-home', profile = 'assistant'
const stage = `${logicalHome}.dsh-enhanced-transaction/staged-home`
const resourceKinds = ['rsi-sources','rsi-local-cohorts','rsi-builds','rsi-release-builds','rsi-authorities','rsi-authority-runtimes']
function selection(backend: 'docker' | 'linux-native') {
  return {mode:'pre-owner',backend,sourceDigest:digest,
    resources:Object.fromEntries(resourceKinds.map(kind => [kind === 'rsi-builds' && backend === 'linux-native' ? 'rsi-linux-runtimes' : kind,digest])),
    metadata:Object.fromEntries(['package.json','cordis.patch.yml','pnpm-workspace.yaml','pnpm-lock.yaml'].map(path => [path,digest])),
    configDigests:{[profile]:digest},rawConfiguration:{profiles:[profile],files:{'cordis.yml':null,'cordis.patch.yml':null,[`profiles/${profile}/cordis.yml`]:digest,[`profiles/${profile}/cordis.patch.yml`]:digest}}}
}
function nativeProof(originalBackend: 'docker' | 'linux-native') {
  const elements = ['runtime','release-toolchain','release-store','release-cache'].map(name => {
    const logicalPath = join(logicalHome,name === 'runtime' ? 'rsi-linux-runtimes' : 'rsi-release-builds',profile,name === 'runtime' ? 'runtime' : name.slice('release-'.length))
    return {name,logicalPath,physicalPath:join(stage,relative(logicalHome,logicalPath)),dev:1,ino:2,sha256:digest,entries:3,bytes:4}
  })
  return {schemaVersion:1,backend:'linux-native',purpose:'pre-owner-base',logicalHome,physicalHome:stage,profile,preparationDigest:digest,cohortDigest:digest,originalBackend,
    relocation:{schemaVersion:1,backend:'linux-native',purpose:'pre-owner-base',profile,sourceHome:'/srv/native-preparation/home',physicalHome:stage,logicalHome,elements,digests:{runtime:digest,release:digest,relocation:digest}}}
}
function manifest(originalBackend: 'docker' | 'linux-native' = 'docker') {
  return {version:5,homePath:logicalHome,profile,operation:'upgrade',state:'validated',localSourceMaintenance:{
    protocol:'dsh-enhanced/pre-owner-source-maintenance/v3',installer:{root:'/srv/reviewed-installer',dev:'1',ino:'2',digest,entries:3},
    preparationRoot:'/srv/native-preparation',preparationDigest:digest,original:selection(originalBackend),candidate:selection('linux-native'),candidateBackend:'linux-native',nativeResources:nativeProof(originalBackend),
    bwrapExecutable:'/usr/bin/bwrap',driverDigest:digest}}
}
// Structural journal tests only. Hash-shaped strings below do not authenticate
// any runtime; helper dispatch and the real inspector rejection are tested separately.
test.each(['docker','linux-native'] as const)('v3 admits a complete %s-to-native journal, with no extension or the exact memory extension', originalBackend => {
  const value = manifest(originalBackend)
  expect(lifecycleProfileTest.validLocalSourceManifest(value)).toBe(true)
  expect(lifecycleProfileTest.validLocalSourceManifest({...value,localSourceMaintenance:{...value.localSourceMaintenance,extension:'memory-learning',expectedCandidateSemanticDigest:digest}})).toBe(true)
  const preparing = {...value,state:'prepared',localSourceMaintenance:{...value.localSourceMaintenance,candidate:null,nativeResources:null}}
  expect(lifecycleProfileTest.validLocalSourceManifest(preparing)).toBe(true)
  expect(lifecycleProfileTest.validLocalSourceManifest({...preparing,state:'validated'})).toBe(false)
})

test('selection backend and resource-family identity cannot be omitted, mixed or passed off as legacy', () => {
  for (const backend of ['docker','linux-native'] as const) {
    const value = selection(backend)
    expect(lifecycleProfileTest.validLocalSourceSelection(value,backend)).toBe(true)
    expect(lifecycleProfileTest.validLocalSourceSelection(value,backend === 'docker' ? 'linux-native' : 'docker')).toBe(false)
    const {backend:_backend,...missing} = value
    expect(lifecycleProfileTest.validLocalSourceSelection(missing,backend)).toBe(false)
    expect(lifecycleProfileTest.validLocalSourceSelection(value)).toBe(false)
    expect(lifecycleProfileTest.validLocalSourceSelection({...value,resources:{...value.resources,...selection(backend === 'docker' ? 'linux-native' : 'docker').resources}},backend)).toBe(false)
  }
  const {backend:_backend,...legacy} = selection('docker')
  expect(lifecycleProfileTest.validLocalSourceSelection(legacy)).toBe(true)
})

test('v3 rejects incomplete or legacy-mixed candidate evidence and fake composition success', () => {
  const value = manifest(), proof = value.localSourceMaintenance
  const {candidateBackend:_backend,...missingBackend} = proof
  const {nativeResources:_resources,...missingResources} = proof
  const {backend:_originalBackend,...legacyOriginal} = proof.original
  for (const changed of [
    missingBackend,missingResources,{...proof,original:legacyOriginal},{...proof,candidateBackend:'docker'},
    {...proof,nativeResources:null},{...proof,candidate:null},{...proof,candidate:{verified:true}},
    {...proof,nativeResources:{verified:true}},
    {...proof,protocol:'dsh-enhanced/pre-owner-source-maintenance/v1'},
    {...proof,protocol:'dsh-enhanced/pre-owner-source-maintenance/v2',extension:'memory-learning',expectedCandidateSemanticDigest:digest},
    {...proof,extension:'other',expectedCandidateSemanticDigest:digest},
    {...proof,extension:'memory-learning'},
  ]) expect(lifecycleProfileTest.validLocalSourceManifest({...value,localSourceMaintenance:changed})).toBe(false)
})

test('staged native proof must bind its purpose, logical Home, physical stage, preparation and relocation elements', () => {
  const value = manifest()
  const mutations: Array<(proof: ReturnType<typeof nativeProof>) => void> = [
    proof => {proof.purpose='owner-family'},proof => {proof.backend='docker'},
    proof => {proof.logicalHome='/srv/other'},proof => {proof.physicalHome=logicalHome},
    proof => {proof.profile='other'},proof => {proof.preparationDigest='b'.repeat(64)},
    proof => {proof.originalBackend='linux-native'},
    proof => {proof.relocation.purpose='owner-family'},proof => {proof.relocation.backend='docker'},
    proof => {proof.relocation.logicalHome='/srv/other'},proof => {proof.relocation.physicalHome=logicalHome},
    proof => {proof.relocation.profile='other'},proof => {proof.relocation.sourceHome=logicalHome},
    proof => {proof.relocation.sourceHome='/srv/other-preparation/home'},
    proof => {proof.relocation.digests.runtime='bad'},
    proof => {proof.relocation.elements[0]!.logicalPath='/srv/other/runtime'},
    proof => {proof.relocation.elements[0]!.physicalPath=join(logicalHome,'rsi-linux-runtimes',profile,'runtime')},
    proof => {proof.relocation.elements[0]!.name=proof.relocation.elements[1]!.name},
    proof => {proof.relocation.elements[0]!.ino=-1},
  ]
  for (const mutate of mutations) {
    const changed = structuredClone(value); mutate(changed.localSourceMaintenance.nativeResources)
    expect(lifecycleProfileTest.validLocalSourceManifest(changed)).toBe(false)
  }
  expect(lifecycleProfileTest.validLocalSourceManifest({...value,localSourceMaintenance:{...value.localSourceMaintenance,preparationRoot:join(logicalHome,'preparation')}})).toBe(false)
  expect(lifecycleProfileTest.validLocalSourceManifest({...value,localSourceMaintenance:{...value.localSourceMaintenance,preparationRoot:'/srv/other-preparation'}})).toBe(false)
})

async function home() {
  const value = await realpath(await mkdtemp(join(tmpdir(),'local-source-native-'))); roots.push(value); return value
}
test('layout discrimination accepts exactly one backend and rejects native owner-only build families', async () => {
  const homePath = await home()
  await expect(localSourceResourceBackend({homePath,profile})).rejects.toThrow('exactly one build backend')
  await mkdir(join(homePath,'rsi-builds',profile),{recursive:true,mode:0o700})
  await expect(localSourceResourceBackend({homePath,profile})).resolves.toBe('docker')
  await mkdir(join(homePath,'rsi-linux-runtimes',profile),{recursive:true,mode:0o700})
  await expect(localSourceResourceBackend({homePath,profile})).rejects.toThrow('exactly one build backend')
  await rm(join(homePath,'rsi-builds'),{recursive:true})
  await expect(localSourceResourceBackend({homePath,profile})).resolves.toBe('linux-native')
  for (const kind of ['rsi-creation-builds','rsi-linux-repository-runtimes','rsi-linux-creation-builds']) {
    const path = join(homePath,kind,profile); await mkdir(path,{recursive:true,mode:0o700})
    await expect(localSourceResourceBackend({homePath,profile})).rejects.toThrow('owner build family')
    await rm(join(homePath,kind),{recursive:true})
  }
})

async function boundInspectorFixture() {
  const root = await home(), physicalHome = await home(), log = join(physicalHome,'inspector-calls')
  for (const path of ['plugins/lark-channel/lib','packages/shared/lib','scripts/install','node_modules']) await mkdir(join(root,path),{recursive:true,mode:0o700})
  for (const path of ['package.json','plugins/lark-channel/package.json','packages/shared/package.json']) await writeFile(join(root,path),'{"type":"module"}',{mode:0o600})
  await writeFile(join(root,'pnpm-lock.yaml'),'{}',{mode:0o600})
  await writeFile(join(root,'scripts/install/local-source-maintenance.mjs'),'export {}\n',{mode:0o600})
  const require = createRequire(import.meta.url)
  await cp(dirname(require.resolve('yaml/package.json')),join(root,'node_modules/yaml'),{recursive:true})
  const names = ['rsi-local-update','rsi-local-update-build','rsi-source-maintenance','rsi-local-activation','rsi-local-pair-install','rsi-local-install','rsi-local-cohort','rsi-authority-runtime','rsi-linux-native-resources','rsi-plugin-revision','supervised-growth-profile']
  for (const name of names) await writeFile(join(root,'plugins/lark-channel/lib',name+'.js'),'export {}\n',{mode:0o600})
  const actualPath = fileURLToPath(new URL('../plugins/lark-channel/lib/rsi-linux-native-resources.js',import.meta.url))
  // The source reader is a fixture port. Identity validation delegates to the
  // actual production inspector; an exact rejection, not a missing export, is required.
  await writeFile(join(root,'plugins/lark-channel/lib/rsi-linux-native-resources.js'),`import {appendFileSync} from 'node:fs'
import {inspectLinuxRsiNativeBaseAt as actual} from ${JSON.stringify(pathToFileURL(actualPath).href)}
export async function inspectLinuxRsiNativeBaseAt(input) {appendFileSync(${JSON.stringify(log)},JSON.stringify({logicalHome:input.logicalHome,physicalHome:input.physicalHome,profile:input.profile})+'\\n');return actual(input)}
export function readRsiSourceMaintenance() {return {records:[],workspace:{sourceCommit:'a'.repeat(40),version:'0.1.65'}}}
export function freezeLinuxRuntimeSource() {throw new Error('must not reach source freezing after invalid identity')}
`,{mode:0o600})
  const authority = join(physicalHome,'rsi-authorities',profile)
  for (const name of ['config','state','registry','identities']) await mkdir(join(authority,name),{recursive:true,mode:0o700})
  await writeFile(join(authority,'bootstrap.json'),'{}',{mode:0o600})
  await writeFile(join(authority,'catalog.json'),'{"schemaVersion":1,"entries":[]}',{mode:0o600})
  await mkdir(join(physicalHome,'rsi-linux-runtimes',profile),{recursive:true,mode:0o700})
  return {installer:await bindLocalSourceInstaller(root),physicalHome,log}
}

test('composition success switches cannot bypass the actual native Home identity inspector', async () => {
  const f = await boundInspectorFixture()
  // The inspector must reject overlapping Home identities before platform/runtime
  // IO on either Mac or Linux. This does not claim a valid inode/runtime fixture.
  const homePath = join(f.physicalHome,'nested-logical')
  for (const flags of [{},{composition:true},{composition:{verified:true}},{contentOnly:true,verified:true}]) {
    await expect(assertLocalSourceNativeResources({homePath,physicalHome:f.physicalHome,profile,installer:f.installer,...flags})).rejects.toThrow('rsi Linux native relocation: invalid base inspection identity')
  }
  const calls = (await readFile(f.log,'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(calls).toEqual(Array.from({length:4},() => ({logicalHome:homePath,physicalHome:f.physicalHome,profile})))
})
