import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import ts from 'typescript'
import { assertLocalSourcePreparedCandidate, bindLocalSourceInstaller, installLocalSourceCandidatePackages, parseLocalSourceCandidateYaml,
  planLocalSourceCandidatePackages } from '../scripts/install/local-source-maintenance.mjs'

// Adapter boundary tests: byte-bound installer APIs are recorded doubles. The
// real shared planner/stager has separate cohort tests; no network/cache proof.
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'candidate-actions-'))); roots.push(root)
  const installerRoot = join(root, 'installer'), lib = join(installerRoot, 'plugins/lark-channel/lib')
  const homePath = join(root, 'home'), profile = 'web', profilePath = join(homePath, 'profiles', profile)
  for (const dir of [lib, join(installerRoot, 'packages'), join(installerRoot, 'scripts/install'), join(installerRoot, 'node_modules'), profilePath]) await mkdir(dir, { recursive: true, mode: 0o700 })
  for (const name of ['package.json', 'plugins/lark-channel/package.json']) await writeFile(join(installerRoot, name), '{"type":"module"}', { mode: 0o600 })
  await writeFile(join(installerRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', { mode: 0o600 })
  const require = createRequire(import.meta.url)
  await cp(dirname(require.resolve('yaml/package.json')), join(installerRoot, 'node_modules/yaml'), { recursive: true })
  for (const name of ['rsi-local-update', 'rsi-source-maintenance', 'rsi-local-activation',
    'rsi-authority-runtime', 'supervised-growth-profile']) await writeFile(join(lib, `${name}.js`), 'export {}\n', { mode: 0o600 })
  await writeFile(join(lib, 'rsi-local-update.js'), `import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';
export async function readRsiLocalUpdateLocked({dshHome,profile,root}) {
const p=JSON.parse(await readFile(join(root,'receipt.json'),'utf8'));
if(p.dshHome!==dshHome||p.profile!==profile)throw Error('prepared identity differs');
if(p.mutateInstaller)await writeFile(new URL(import.meta.url),'export const replaced=true\\n');
return p;
}`, { mode: 0o600 })
  const cohort = { root: join(homePath, 'rsi-local-cohorts', profile), version: '0.1.65', receiptDigest: 'candidate', bundles: ['target'], allowBuilds: { esbuild: true },
    packages: [{ name: '@dsh-enhanced/target', path: 'plugins/target', runtimeDependencies: [] as string[], bundle: true, tarball: join(homePath, 'rsi-local-cohorts', profile, 'artifacts/target.tgz') }] }
  await writeFile(join(profilePath, 'cohort.json'), JSON.stringify(cohort), { mode: 0o600 })
  const workspace = `packages: []\nnodeLinker: isolated\nallowBuilds:\n  esbuild: true\noverrides:\n  '@dsh-enhanced/target': file:${cohort.packages[0]!.tarball}\n`
  await writeFile(join(profilePath, 'pnpm-workspace.yaml'), workspace, { mode: 0o600 })
  await writeFile(join(profilePath, 'package.json'), JSON.stringify({ dependencies: { '@dsh-enhanced/target': `file:${cohort.packages[0]!.tarball}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@dsh-enhanced/target'] } } }), { mode: 0o600 })
  await writeFile(join(lib, 'rsi-local-cohort.js'), `import { readFile } from 'node:fs/promises';import { join } from 'node:path';
export async function readRsiLocalCohort({dshHome,profile}) { return JSON.parse(await readFile(join(dshHome,'profiles',profile,'cohort.json'),'utf8')) }
export async function rsiLocalPeerOverrides() { return {} }
`, { mode: 0o600 })
  for (const name of ['rsi-local-profile-update', 'rsi-local-roots-extension']) {
    const source = await readFile(join(process.cwd(), 'plugins/lark-channel/src', `${name}.ts`), 'utf8')
    await writeFile(join(lib, `${name}.js`), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText, { mode: 0o600 })
  }
  await writeFile(join(lib, 'rsi-local-pair-install.js'), `export async function planRsiLocalProfilePackages(input) {
if(input.rootExtension && input.rootExtension!=='memory-learning') throw Error('unsupported extension');
return {workspace:input.source,bundles:[...input.bundles],tarballs:input.bundles.map(s=>input.candidate.packages.find(p=>p.name==='@dsh-enhanced/'+s).tarball)}
}`, { mode: 0o600 })
  await writeFile(join(lib, 'rsi-local-install.js'), `import { readFile, writeFile } from 'node:fs/promises';import { join } from 'node:path';import { parseDocument } from 'yaml';
export function rsiLocalDependencyOverrides(c,b) { return Object.fromEntries(b.map(s=>{const p=c.packages.find(p=>p.name==='@dsh-enhanced/'+s);return [p.name,'file:'+p.tarball]})) }
export function mergeRsiLocalOverrides(source,overrides,builds) {const d=parseDocument(source);for(const[k,v]of Object.entries(overrides))if(d.getIn(['overrides',k])!==v)throw Error('override changed');for(const[k,v]of Object.entries(builds))if(d.getIn(['allowBuilds',k])!==v)throw Error('build changed');return source}
export async function installRsiLocalProfile(input) {
const manifestPath=join(input.dshHome,'profiles',input.profile,'package.json');const m=JSON.parse(await readFile(manifestPath,'utf8'));await writeFile(join(input.dshHome,'manifest-before-cli.json'),JSON.stringify(m));
if(await readFile(join(input.dshHome,'complete-mount'),'utf8').catch(()=>null)==='yes') {m.dsh.profile.bundles.push('@dsh-enhanced/assistant-memory-learning');await writeFile(manifestPath,JSON.stringify(m));}
if(!input.signal||input.signal.aborted)throw Error('no active signal');await writeFile(join(input.dshHome,'install-observed.json'),JSON.stringify({dshHome:input.dshHome,profile:input.profile,cohort:input.cohort,bundles:input.bundles,dsh:input.dsh,initializeFromManifest:input.initializeFromManifest}));}
`, { mode: 0o600 })
  const installer = await bindLocalSourceInstaller(installerRoot)
  const dsh = { path: join(root, 'dsh'), pin: { path: join(root, 'dsh'), sha256: hash('cli') } }
  const input = { homePath, profile, originalCohort: cohort, proof: { installer }, dsh }
  return { root, lib, homePath, profilePath, cohort, workspace, installer, input }
}

test('plans old mounted roots without writes and dispatches the exact reviewed native installer input', async () => {
  const f = await fixture(), before = await readFile(join(f.profilePath, 'package.json'))
  const plan = await planLocalSourceCandidatePackages(f.input)
  expect(plan).toEqual({ workspace: f.workspace, bundles: ['target'], tarballs: [f.cohort.packages[0]!.tarball], cohort: f.cohort })
  expect(await readFile(join(f.profilePath, 'package.json'))).toEqual(before)
  await expect(readFile(join(f.homePath, 'install-observed.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await installLocalSourceCandidatePackages({ ...f.input, plan })
  expect(JSON.parse(await readFile(join(f.homePath, 'install-observed.json'), 'utf8'))).toEqual({ dshHome: f.homePath, profile: 'web', cohort: f.cohort, bundles: ['target'], dsh: f.input.dsh, initializeFromManifest: true })
})

test('candidate CLI actions run through the same reviewed plan/install adapters', async () => {
  const f = await fixture(), path = join(f.root, 'input.json')
  const invoke = (action: string) => spawnSync(process.execPath, [join(process.cwd(), 'scripts/install/local-source-maintenance.mjs'), action, path], { encoding: 'utf8' })
  await writeFile(path, JSON.stringify(f.input), { mode: 0o600 })
  const planned = invoke('candidate-plan'); expect(planned.stderr).toBe(''); expect(planned.status).toBe(0)
  const plan = JSON.parse(planned.stdout)
  await writeFile(path, JSON.stringify({ ...f.input, plan }))
  const installed = invoke('candidate-install'); expect(installed.stderr).toBe(''); expect(installed.status).toBe(0)
  expect(JSON.parse(installed.stdout)).toEqual({ cohortDigest: 'candidate', bundles: ['target'], tarballs: plan.tarballs })
})

test.each(['missing', 'changed'] as const)('refuses %s candidate cohort before install dispatch', async mode => {
  const f = await fixture(), plan = await planLocalSourceCandidatePackages(f.input)
  const path = join(f.profilePath, 'cohort.json')
  if (mode === 'missing') await rm(path)
  else await writeFile(path, JSON.stringify({ ...f.cohort, receiptDigest: 'drift' }))
  await expect(installLocalSourceCandidatePackages({ ...f.input, plan })).rejects.toThrow()
  await expect(readFile(join(f.homePath, 'install-observed.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test.each(['workspace', 'tarballs', 'bundles', 'policy'] as const)('refuses %s plan drift', async field => {
  const f = await fixture(), plan = await planLocalSourceCandidatePackages(f.input)
  if (field === 'workspace') plan.workspace += '#changed\n'
  if (field === 'tarballs') plan.tarballs = ['/foreign.tgz']
  if (field === 'bundles') plan.bundles = ['foreign']
  if (field === 'policy') { plan.workspace = plan.workspace.replace('esbuild: true', 'esbuild: false'); await writeFile(join(f.profilePath, 'pnpm-workspace.yaml'), plan.workspace) }
  await expect(installLocalSourceCandidatePackages({ ...f.input, plan })).rejects.toThrow()
  await expect(readFile(join(f.homePath, 'install-observed.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test.each(['directory', 'dangling-link'] as const)('never installs over existing node_modules %s', async kind => {
  const f = await fixture(), plan = await planLocalSourceCandidatePackages(f.input), path = join(f.profilePath, 'node_modules')
  if (kind === 'directory') await mkdir(path); else await symlink(join(f.root, 'missing'), path)
  await expect(installLocalSourceCandidatePackages({ ...f.input, plan })).rejects.toThrow('already has node_modules')
  await expect(readFile(join(f.homePath, 'install-observed.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('rejects changed mounted roots and reviewed installer bytes', async () => {
  const f = await fixture()
  await writeFile(join(f.profilePath, 'package.json'), '{"dsh":{"profile":{"bundles":[]}}}')
  await expect(planLocalSourceCandidatePackages(f.input)).rejects.toThrow('mounted internal bundle roots changed')
  await writeFile(join(f.lib, 'rsi-local-install.js'), 'export {}\n')
  await expect(parseLocalSourceCandidateYaml({ installer: f.installer, source: 'x: 1\n' })).rejects.toThrow('bytes or ownership changed')
})

test('bound YAML parser accepts plain mappings and rejects aliases, duplicate keys and non-JSON values', async () => {
  const f = await fixture(), parse = (source: string) => parseLocalSourceCandidateYaml({ installer: f.installer, source })
  expect(await parse('policy:\n  allowed: false\nvalues: [1, null, x]\n')).toEqual({ policy: { allowed: false }, values: [1, null, 'x'] })
  for (const source of ['x: &v 1\ny: *v\n', 'x: 1\nx: 2\n', '[]\n', 'x: .inf\n', 'x: !!js foo()\n', '1: value\n', '? [a, b]\n: value\n']) await expect(parse(source)).rejects.toThrow()
})


async function learnerFixture() {
  const f = await fixture(), name = '@dsh-enhanced/assistant-memory-learning'
  f.cohort.bundles.push('assistant-memory-learning')
  const pkg = { name, path: 'plugins/assistant-memory-learning', runtimeDependencies: [] as string[], bundle: true,
    tarball: join(f.cohort.root, 'artifacts/assistant-memory-learning.tgz') }
  f.cohort.packages.push(pkg)
  const path = join(f.profilePath, 'package.json'), manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.dependencies[name] = `file:${pkg.tarball}`
  await writeFile(path, JSON.stringify(manifest))
  await writeFile(join(f.profilePath, 'cohort.json'), JSON.stringify(f.cohort))
  const workspace = f.workspace + `  '${name}': file:${pkg.tarball}\n`
  await writeFile(join(f.profilePath, 'pnpm-workspace.yaml'), workspace)
  const plan = { workspace, cohort: f.cohort, bundles: f.cohort.bundles, tarballs: f.cohort.packages.map(p => p.tarball) }
  return { ...f, plan, manifestPath: path, manifest }
}

test('authorized learner warm install leaves mount mutation to the native installer and verifies its result', async () => {
  const f = await learnerFixture()
  await writeFile(join(f.homePath, 'complete-mount'), 'yes')
  await installLocalSourceCandidatePackages({ ...f.input, proof: { ...f.input.proof, extension: 'memory-learning' }, plan: f.plan })
  expect(JSON.parse(await readFile(join(f.homePath, 'manifest-before-cli.json'), 'utf8'))).toEqual(f.manifest)
  expect(JSON.parse(await readFile(f.manifestPath, 'utf8')).dsh.profile.bundles).toContain('@dsh-enhanced/assistant-memory-learning')
})

test('native installer failing to mount the authorized learner cannot produce a successful candidate proof', async () => {
  const f = await learnerFixture()
  await expect(installLocalSourceCandidatePackages({ ...f.input, proof: { ...f.input.proof, extension: 'memory-learning' }, plan: f.plan }))
    .rejects.toThrow('mounted internal bundle roots changed')
  expect(JSON.parse(await readFile(f.manifestPath, 'utf8'))).toEqual(f.manifest)
  expect(JSON.parse(await readFile(join(f.homePath, 'install-observed.json'), 'utf8'))).toHaveProperty('profile', 'web')
})

test.each(['unauthorized', 'missing-other', 'extra-mount', 'bad-locator'] as const)('learner warm exception rejects %s before native dispatch', async mode => {
  const f = await learnerFixture(), m = structuredClone(f.manifest)
  if (mode === 'missing-other') m.dsh.profile.bundles = ['@deepseek-ai/dsh-base']
  if (mode === 'extra-mount') m.dsh.profile.bundles.push('@dsh-enhanced/foreign')
  if (mode === 'bad-locator') m.dependencies['@dsh-enhanced/target'] = 'file:/foreign.tgz'
  await writeFile(f.manifestPath, JSON.stringify(m))
  await expect(installLocalSourceCandidatePackages({ ...f.input, proof: { ...f.input.proof, ...(mode === 'unauthorized' ? {} : { extension: 'memory-learning' }) }, plan: f.plan })).rejects.toThrow()
  await expect(readFile(join(f.homePath, 'install-observed.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})


async function preparedFixture() {
  const f = await fixture(), preparationRoot = join(f.homePath, 'preparation')
  await mkdir(preparationRoot, { mode: 0o700 })
  const preparation = { receiptDigest: 'frozen-preparation', extension: 'memory-learning', dshHome: f.homePath,
    profile: f.input.profile, source: { root: '/frozen/source' } }
  const receipt = join(preparationRoot, 'receipt.json')
  await writeFile(receipt, JSON.stringify(preparation))
  const input = { homePath: f.homePath, profile: f.input.profile, proof: { installer: f.installer, preparationRoot,
    preparationDigest: preparation.receiptDigest, extension: preparation.extension } }
  return { ...f, preparation, receipt, preparedInput: input }
}

test('pre-stop assertion returns the reviewed preparation without installing or changing it', async () => {
  const f = await preparedFixture(), before = await readFile(f.receipt)
  expect(await assertLocalSourcePreparedCandidate(f.preparedInput)).toEqual(f.preparation)
  expect(await readFile(f.receipt)).toEqual(before)
  await expect(readFile(join(f.homePath, 'install-observed.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test.each(['receiptDigest', 'extension'] as const)('pre-stop assertion rejects external prepared %s drift', async field => {
  const f = await preparedFixture()
  await writeFile(f.receipt, JSON.stringify({ ...f.preparation, [field]: field === 'extension' ? undefined : 'changed' }))
  await expect(assertLocalSourcePreparedCandidate(f.preparedInput)).rejects.toThrow('prepared candidate changed')
})

test('pre-stop assertion rechecks reviewed installer binding after the preparation reader awaits', async () => {
  const f = await preparedFixture()
  await writeFile(f.receipt, JSON.stringify({ ...f.preparation, mutateInstaller: true }))
  await expect(assertLocalSourcePreparedCandidate(f.preparedInput)).rejects.toThrow('bytes or ownership changed')
})
