import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { bindLocalSourceInstaller, loadLocalSourceInstaller } from './local-source-maintenance.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const exact = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value && !value.includes('\0')
const inside = (root, path) => path === root || path.startsWith(root + sep)
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const BUNDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const HASH = /^[a-f0-9]{64}$/u
const fail = message => { throw new Error(`Host local artifacts: ${message}`) }

async function directory(path, privateMode = true) {
  if (!exact(path) || await realpath(path) !== path) fail(`non-canonical directory: ${path}`)
  const item = await lstat(path)
  if (!item.isDirectory() || item.isSymbolicLink() || item.uid !== process.getuid()
    || item.mode & (privateMode ? 0o077 : 0o022)) {
    fail(`unsafe private directory: ${path}`)
  }
}
async function stableFile(path, maximum = 268_435_456) {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid()
    || before.mode & 0o022 || before.size < 1 || before.size > maximum) fail(`unsafe file: ${path}`)
  const bytes = await readFile(path), after = await lstat(path)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size) {
    fail(`file changed during read: ${path}`)
  }
  return bytes
}
async function privateCreate(path) {
  try { await mkdir(path, { mode: 0o700 }) }
  catch (error) { if (error?.code !== 'EEXIST') throw error }
  await directory(path)
}
async function runtime(installer, ports) {
  const api = await (ports.loadInstaller ?? loadLocalSourceInstaller)(installer)
  const base = join(installer.root, 'plugins', 'lark-channel', 'lib')
  const source = ports.source ?? await import(pathToFileURL(join(base, 'rsi-source.js')).href)
  const build = ports.build ?? await import(pathToFileURL(join(base, 'rsi-local-update-build.js')).href)
  return { api, source, build }
}
function inputIdentity(input) {
  const { sourcePreparationRoot, homePath, profile, installerRoot, root, bundles } = input
  if (![sourcePreparationRoot, homePath, installerRoot, root].every(exact) || !PROFILE.test(profile)
    || !Array.isArray(bundles) || !bundles.length || bundles.length > 128
    || bundles.some(name => !BUNDLE.test(name)) || new Set(bundles).size !== bundles.length
    || [sourcePreparationRoot, homePath, installerRoot].some(path => inside(path, root) || inside(root, path))) {
    fail('invalid auxiliary preparation identity')
  }
  return [...bundles].sort()
}
function auxiliaryProfile(input, preparation, bundles) {
  return `host-migration-${hash(JSON.stringify({ homePath: input.homePath, profile: input.profile,
    preparationDigest: preparation.receiptDigest, bundles })).slice(0, 20)}`
}
function assertPreparation(preparation, input, bundles) {
  if (preparation?.mode !== 'prepared' || preparation.schemaVersion !== 1 || preparation.extension !== undefined
    || preparation.dshHome !== input.homePath || preparation.profile !== input.profile
    || preparation.root !== input.sourcePreparationRoot || !HASH.test(preparation.receiptDigest)
    || !exact(preparation.source?.repository) || !/^[a-f0-9]{40}$/u.test(preparation.source?.sourceCommit)
    || typeof preparation.source?.version !== 'string' || !preparation.build
    || bundles.some(name => preparation.cohort.bundles.includes(name))) fail('auxiliary source preparation differs')
}
function proofBody(input, installer, preparation, auxiliaryProfileName, cohort) {
  return { protocol: 'dsh-enhanced/host-local-artifacts/v1', homePath: input.homePath, profile: input.profile,
    sourcePreparationRoot: input.sourcePreparationRoot, preparationDigest: preparation.receiptDigest,
    installer, root: input.root, auxiliaryProfile: auxiliaryProfileName, bundles: [...input.bundles].sort(),
    candidateRepository: preparation.source.repository, sourceCommit: preparation.source.sourceCommit,
    version: preparation.source.version,
    cohortDigest: cohort.receiptDigest }
}
function fullProof(body) { return { ...body, receiptDigest: hash(JSON.stringify(body)) } }
function assertCohort(cohort, preparation, auxiliaryHome, auxiliaryProfileName, bundles) {
  if (cohort.root !== join(auxiliaryHome, 'rsi-local-cohorts', auxiliaryProfileName)
    || cohort.sourceCommit !== preparation.source.sourceCommit || cohort.version !== preparation.source.version
    || cohort.sourceRepository !== preparation.source.repository
    || !isDeepStrictEqual(cohort.bundles, bundles)) fail('auxiliary cohort differs from exact candidate source')
}
async function assertArtifactBytes(cohort) {
  for (const item of cohort.packages) {
    if (!HASH.test(item.sha256) || hash(await stableFile(item.tarball)) !== item.sha256) {
      fail(`auxiliary artifact bytes differ: ${item.name}`)
    }
  }
}

export async function prepareHostLocalArtifacts(input, ports = {}) {
  const bundles = inputIdentity(input)
  await directory(input.homePath); await directory(input.sourcePreparationRoot); await directory(input.installerRoot, false)
  await directory(dirname(input.root), false); await privateCreate(input.root)
  const installer = await (ports.bindInstaller ?? bindLocalSourceInstaller)(input.installerRoot)
  const existingReceipt = await stableFile(join(input.root, 'receipt.json'), 20_971_520).catch(error => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  if (existingReceipt) {
    const previous = JSON.parse(existingReceipt.toString('utf8'))
    if (previous.root !== input.root || previous.profile !== input.profile || previous.sourcePreparationRoot !== input.sourcePreparationRoot
      || !isDeepStrictEqual(previous.bundles, bundles) || !isDeepStrictEqual(previous.installer, installer)) {
      fail('existing auxiliary preparation inputs changed')
    }
    await verifyHostLocalArtifacts({ proof: previous, homePath: input.homePath }, ports)
    return previous
  }
  const { api, source, build } = await runtime(installer, ports)
  const preparation = await api.readRsiLocalUpdateLocked({ dshHome: input.homePath, profile: input.profile,
    root: input.sourcePreparationRoot })
  assertPreparation(preparation, input, bundles)
  const auxiliaryProfileName = auxiliaryProfile(input, preparation, bundles)
  const auxiliaryHome = join(input.root, 'home')
  await privateCreate(auxiliaryHome)
  const workspace = await source.prepareRsiSourceWorkspace({ dshHome: auxiliaryHome, profile: auxiliaryProfileName,
    version: preparation.source.version, sourceRepository: preparation.source.repository })
  if (workspace.sourceCommit !== preparation.source.sourceCommit || workspace.version !== preparation.source.version
    || workspace.origin?.locator !== preparation.source.repository) fail('auxiliary workspace differs from candidate source')
  const builder = await build.prepareRsiLocalUpdateBuild({ dshHome: auxiliaryHome, profile: auxiliaryProfileName,
    source: workspace, signal: input.signal ?? new AbortController().signal })
  const cohort = await api.prepareRsiLocalCohort({ dshHome: auxiliaryHome, profile: auxiliaryProfileName,
    source: workspace, bundles, signal: input.signal }, builder.ports)
  assertCohort(cohort, preparation, auxiliaryHome, auxiliaryProfileName, bundles)
  const verified = await api.readRsiLocalCohort({ dshHome: auxiliaryHome, profile: auxiliaryProfileName,
    source: workspace })
  if (!isDeepStrictEqual(verified, cohort)) fail('auxiliary cohort receipt or archive differs')
  await assertArtifactBytes(verified)
  const proof = fullProof(proofBody({ ...input, bundles }, installer, preparation, auxiliaryProfileName, cohort))
  const receiptPath = join(input.root, 'receipt.json')
  let previous
  try { previous = await stableFile(receiptPath, 20_971_520) }
  catch (error) { if (error?.code !== 'ENOENT') throw error }
  if (previous) {
    if (!previous.equals(Buffer.from(JSON.stringify(proof)))) fail('auxiliary receipt changed')
  } else await writeFile(receiptPath, JSON.stringify(proof), { flag: 'wx', mode: 0o600 })
  if (!isDeepStrictEqual((await readdir(input.root)).sort(), ['home', 'receipt.json'])) fail('auxiliary preparation contains unknown files')
  await verifyHostLocalArtifacts({ proof, homePath: input.homePath }, ports)
  return proof
}

export async function verifyHostLocalArtifactsFinal({ proof, homePath }, ports = {}) {
  if (proof?.protocol !== 'dsh-enhanced/host-local-artifacts/v1' || proof.homePath !== homePath
    || !HASH.test(proof.receiptDigest)) fail('invalid auxiliary proof protocol')
  const input = { homePath, profile: proof.profile, sourcePreparationRoot: proof.sourcePreparationRoot,
    installerRoot: proof.installer?.root, root: proof.root, bundles: proof.bundles }
  const bundles = inputIdentity(input)
  if (!exact(proof.candidateRepository) || proof.candidateRepository !== join(proof.sourcePreparationRoot, 'source', 'repository')) {
    fail('auxiliary candidate repository differs')
  }
  const { receiptDigest, ...body } = proof
  if (receiptDigest !== hash(JSON.stringify(body))) {
    fail('auxiliary proof digest differs')
  }
  await directory(homePath); await directory(proof.root)
  if (!isDeepStrictEqual((await readdir(proof.root)).sort(), ['home', 'receipt.json'])
    || !(await stableFile(join(proof.root, 'receipt.json'), 20_971_520)).equals(Buffer.from(JSON.stringify(proof)))) {
    fail('auxiliary receipt changed')
  }
  const installer = await (ports.bindInstaller ?? bindLocalSourceInstaller)(proof.installer.root)
  if (!isDeepStrictEqual(installer, proof.installer)) fail('auxiliary installer changed')
  const { api, source } = await runtime(installer, ports)
  const preparation = { receiptDigest: proof.preparationDigest,
    source: { repository: proof.candidateRepository, sourceCommit: proof.sourceCommit, version: proof.version } }
  const auxiliaryProfileName = auxiliaryProfile(input, preparation, bundles)
  if (auxiliaryProfileName !== proof.auxiliaryProfile) {
    fail('auxiliary source binding changed')
  }
  const auxiliaryHome = join(proof.root, 'home')
  await directory(auxiliaryHome)
  const workspace = await source.readRsiSourceWorkspace({ dshHome: auxiliaryHome, profile: auxiliaryProfileName,
    version: proof.version, sourceRepository: preparation.source.repository })
  if (workspace.sourceCommit !== proof.sourceCommit || workspace.origin?.locator !== preparation.source.repository) {
    fail('auxiliary workspace source changed')
  }
  const cohort = await api.readRsiLocalCohort({ dshHome: auxiliaryHome, profile: auxiliaryProfileName,
    source: workspace })
  assertCohort(cohort, preparation, auxiliaryHome, auxiliaryProfileName, bundles)
  await assertArtifactBytes(cohort)
  if (!isDeepStrictEqual(fullProof(proofBody(input, installer, preparation, auxiliaryProfileName, cohort)), proof)) {
    fail('auxiliary cohort proof changed')
  }
  return { proof, cohort }
}

export async function verifyHostLocalArtifacts({ proof, homePath }, ports = {}) {
  const verified = await verifyHostLocalArtifactsFinal({ proof, homePath }, ports)
  const { api } = await runtime(proof.installer, ports)
  const preparation = await api.readRsiLocalUpdateLocked({ dshHome: homePath, profile: proof.profile,
    root: proof.sourcePreparationRoot })
  assertPreparation(preparation, { homePath, profile: proof.profile, sourcePreparationRoot: proof.sourcePreparationRoot }, proof.bundles)
  if (preparation.receiptDigest !== proof.preparationDigest || preparation.source.repository !== proof.candidateRepository
    || preparation.source.sourceCommit !== proof.sourceCommit || preparation.source.version !== proof.version) {
    fail('auxiliary source binding changed')
  }
  return verified
}

function rebaseCohort(cohort, logicalHome, auxiliaryProfileName) {
  const root = join(logicalHome, 'rsi-local-cohorts', auxiliaryProfileName)
  const body = { ...cohort, root, packages: cohort.packages.map(item => ({ ...item,
    tarball: join(root, 'artifacts', `${item.name.split('/')[1]}.tgz`) })) }
  delete body.receiptDigest
  return { ...body, receiptDigest: hash(JSON.stringify(body)) }
}

export async function verifyHostLocalArtifactsInHome({ proof, homePath, physicalHome, skipOriginal = false }, ports = {}) {
  const { cohort } = skipOriginal
    ? await verifyHostLocalArtifactsFinal({ proof, homePath }, ports)
    : await verifyHostLocalArtifacts({ proof, homePath }, ports)
  if (!exact(physicalHome) || await realpath(physicalHome) !== physicalHome) fail('invalid artifact Home')
  const stagedRoot = join(physicalHome, 'rsi-local-cohorts', proof.auxiliaryProfile)
  await directory(stagedRoot); await directory(join(stagedRoot, 'artifacts'))
  const expected = rebaseCohort(cohort, homePath, proof.auxiliaryProfile)
  if (!isDeepStrictEqual(JSON.parse((await stableFile(join(stagedRoot, 'receipt.json'), 20_971_520)).toString('utf8')), expected)
    || !isDeepStrictEqual((await readdir(stagedRoot)).sort(), ['artifacts', 'receipt.json'])
    || !isDeepStrictEqual((await readdir(join(stagedRoot, 'artifacts'))).sort(),
      cohort.packages.map(item => `${item.name.split('/')[1]}.tgz`).sort())) fail('staged auxiliary cohort differs')
  const artifacts = {}
  for (const item of expected.packages) {
    const source = cohort.packages.find(candidate => candidate.name === item.name)
    if (!source || hash(await stableFile(join(stagedRoot, 'artifacts', `${item.name.split('/')[1]}.tgz`))) !== item.sha256) {
      fail(`staged auxiliary artifact differs: ${item.name}`)
    }
    artifacts[item.name] = { version: expected.version, tarball: item.tarball,
      sourcePath: join(physicalHome, relative(homePath, item.tarball)), sha256: item.sha256,
      runtimeDependencies: item.runtimeDependencies, files: item.files }
  }
  return { cohort: expected, artifacts }
}

export async function materializeHostLocalArtifacts({ proof, homePath, physicalHome }, ports = {}) {
  const { cohort } = await verifyHostLocalArtifacts({ proof, homePath }, ports)
  if (!exact(physicalHome) || await realpath(physicalHome) !== physicalHome
    || inside(homePath, physicalHome) || inside(physicalHome, homePath)
    || inside(proof.root, physicalHome) || inside(physicalHome, proof.root)) fail('auxiliary stage overlaps an input')
  await directory(physicalHome)
  const parent = join(physicalHome, 'rsi-local-cohorts')
  await privateCreate(parent)
  const destination = join(parent, proof.auxiliaryProfile)
  try { await lstat(destination); fail('auxiliary artifact namespace already exists') }
  catch (error) { if (error?.code !== 'ENOENT') throw error }
  const temporary = join(parent, `.${proof.auxiliaryProfile}-${process.pid}`)
  await cp(cohort.root, temporary, { recursive: true, errorOnExist: true, force: false, dereference: false })
  try {
    const rebased = rebaseCohort(cohort, homePath, proof.auxiliaryProfile)
    await writeFile(join(temporary, 'receipt.json'), JSON.stringify(rebased), { mode: 0o600 })
    await rename(temporary, destination)
    return await verifyHostLocalArtifactsInHome({ proof, homePath, physicalHome }, ports)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}
