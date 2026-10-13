import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { assertLocalSourceInstaller, bindLocalSourceInstaller, loadLocalSourceInstaller } from './local-source-maintenance.mjs'
import { materializeHostLocalArtifacts, prepareHostLocalArtifacts, verifyHostLocalArtifacts,
  verifyHostLocalArtifactsInHome } from './host-local-artifacts.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const exact = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value && !value.includes('\0')
const profileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const fail = message => { throw new Error(`Host local source update: ${message}`) }
const same = (left, right) => isDeepStrictEqual(left, right)
const repairProtocol = 'dsh-enhanced/host-owner-source-repair/v1'
const repairMode = proof => proof?.protocol === repairProtocol
function assertProtocol(proof) {
  if (!repairMode(proof) && proof?.protocol !== 'dsh-enhanced/host-local-source-update/v1') fail('invalid source proof protocol')
  if (repairMode(proof) !== (proof.ownerRepair !== undefined)) fail('source owner repair scope differs')
}

async function privateHome(path) {
  if (!exact(path) || await realpath(path) !== path) fail('Home must be canonical')
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid()
    || (entry.mode & 0o022)) fail('Home owner or mode differs')
}

async function privateFileDigest(path, optional = false, publicRead = false) {
  let before
  try { before = await lstat(path) }
  catch (error) { if (optional && error?.code === 'ENOENT') return null; throw error }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid()
    || (before.mode & (publicRead ? 0o022 : 0o077)) || before.size < 1 || before.size > 16_777_216) fail(`unsafe source file: ${path}`)
  const source = await readFile(path)
  const after = await lstat(path)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail(`source file changed: ${path}`)
  return hash(source)
}

async function authorityTreeDigest(root) {
  const entries = []
  let total = 0
  const visit = async path => {
    if (entries.length >= 150_000) fail('authority tree exceeds entry limit')
    const entry = await lstat(path)
    if (entry.isSymbolicLink() || entry.uid !== process.getuid() || (entry.mode & 0o077)) fail(`unsafe authority entry: ${path}`)
    if (entry.isDirectory()) {
      entries.push([relative(root, path), 'directory', entry.mode & 0o777])
      for (const name of (await readdir(path)).sort()) await visit(join(path, name))
    } else if (entry.isFile() && entry.nlink === 1) {
      total += entry.size
      if (entry.size > 268_435_456 || total > 1_073_741_824) fail('authority tree exceeds byte limit')
      entries.push([relative(root, path), 'file', entry.mode & 0o777, hash(await readFile(path))])
    } else fail(`unsupported authority entry: ${path}`)
  }
  await visit(root)
  return hash(JSON.stringify(entries))
}

async function ownerInventory(homePath, profile) {
  const expected = new Set([profile])
  for (const kind of ['rsi-authorities', 'rsi-sources']) {
    const names = (await readdir(join(homePath, kind))).sort()
    if (!same(names, [...expected])) fail(`other ${kind} installation is present`)
  }
  const coordinators = await readdir(join(homePath, 'rsi-coordinators')).catch(error => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
  if (coordinators.length) fail('other coordinator installation is present')
  const marker = `.rsi-coordinator-${hash(profile).slice(0, 16)}.json`
  const markers = (await readdir(homePath)).filter(name => name.startsWith('.rsi-coordinator-') || name === '.rsi-setup-journal.json').sort()
  if (!same(markers, [marker])) fail('unknown coordinator marker or setup journal is present')
  return {
    authorityTree: await authorityTreeDigest(join(homePath, 'rsi-authorities', profile)),
    marker: await privateFileDigest(join(homePath, marker)),
    authorityBootstrap: await privateFileDigest(join(homePath, 'rsi-authorities', profile, 'bootstrap.json')),
    sourceBootstrap: await privateFileDigest(join(homePath, 'rsi-sources', profile, 'bootstrap.json')),
    sourceMaintenance: await privateFileDigest(join(homePath, 'rsi-sources', profile, 'maintenance.json'), true),
  }
}

async function profileInventory(homePath, profile) {
  const directory = join(homePath, 'profiles', profile)
  const files = {}
  for (const name of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
    files[name] = await privateFileDigest(join(directory, name), false, true)
  }
  return files
}

async function allProfileRoots(homePath, candidateCohort) {
  const profilesRoot = join(homePath, 'profiles')
  const available = new Set(candidateCohort.packages.map(item => item.name))
  const missing = new Set()
  const manifests = {}
  for (const name of (await readdir(profilesRoot)).sort()) {
    if (name === 'node_modules') continue
    if (!profileName.test(name)) fail(`invalid Home profile: ${name}`)
    const directory = join(profilesRoot, name), entry = await lstat(directory)
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid() || entry.mode & 0o022) {
      fail(`unsafe Home profile: ${name}`)
    }
    const manifestPath = join(directory, 'package.json')
    manifests[name] = await privateFileDigest(manifestPath, false, true)
    const manifestBytes = await readFile(manifestPath)
    if (hash(manifestBytes) !== manifests[name]) fail(`Home profile manifest changed: ${name}`)
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail(`invalid Home profile manifest: ${name}`)
    for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
      const roots = manifest[field]
      if (roots === undefined) continue
      if (!roots || typeof roots !== 'object' || Array.isArray(roots)) fail(`invalid Home profile roots: ${name}`)
      for (const dependency of Object.keys(roots)) {
        if (dependency.startsWith('@dsh-enhanced/') && !available.has(dependency)) {
          const slug = dependency.slice('@dsh-enhanced/'.length)
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) fail(`invalid enhanced root: ${dependency}`)
          missing.add(slug)
        }
      }
    }
  }
  return { manifests, missing: [...missing].sort() }
}

function mergeArtifacts(primary, additional = {}) {
  const result = { ...primary }
  for (const [name, artifact] of Object.entries(additional)) {
    if (Object.hasOwn(result, name)) {
      const original = result[name]
      const identity = item => ({ version: item.version, sha256: item.sha256,
        files: item.files, runtimeDependencies: item.runtimeDependencies })
      if (original.name !== name || artifact.name !== undefined && artifact.name !== name
        || !same(identity(original), identity(artifact))) fail(`conflicting candidate artifact: ${name}`)
      continue
    }
    result[name] = artifact
  }
  return result
}

function artifactMap(cohort, homePath, profile, sourceHome) {
  if (!cohort || !Array.isArray(cohort.packages) || !/^[a-f0-9]{64}$/u.test(cohort.receiptDigest)) fail('prepared cohort is invalid')
  const result = {}
  for (const item of cohort.packages) {
    if (typeof item.name !== 'string' || !item.name.startsWith('@dsh-enhanced/') || !exact(item.tarball)
      || !item.tarball.startsWith(`${cohort.root}${sep}`) || !/^[a-f0-9]{64}$/u.test(item.sha256)) fail('prepared artifact is invalid')
    const tarball = join(homePath, 'rsi-local-cohorts', profile, 'artifacts', basename(item.tarball))
    if (Object.hasOwn(result, item.name)) fail('duplicate prepared artifact')
    result[item.name] = { name: item.name, version: cohort.version, sha256: item.sha256,
      runtimeDependencies: item.runtimeDependencies, files: item.files,
      sourcePath: join(sourceHome, 'rsi-local-cohorts', profile, 'artifacts', basename(item.tarball)), tarball }
  }
  return result
}

function artifactIdentity(artifacts) {
  return Object.fromEntries(Object.entries(artifacts).map(([name, { sourcePath: _sourcePath, ...item }]) => [name, item]))
}

function assertCandidateResources(resources, proof, physicalHome) {
  if (resources.cohort.version !== proof.candidate.version
    || resources.cohort.sourceCommit !== proof.candidate.sourceCommit
    || !same(artifactIdentity(artifactMap(resources.cohort, proof.homePath, proof.profile, physicalHome)),
      artifactIdentity(proof.candidateArtifacts))) fail('staged candidate resources differ')
}

async function readOriginal(proof, homePath, api) {
  await privateHome(homePath)
  if (proof.homePath !== homePath || !profileName.test(proof.profile)) fail('source proof Home or profile differs')
  const preparation = await api.readRsiLocalUpdateLocked({ dshHome: homePath, profile: proof.profile,
    root: proof.preparationRoot })
  if (preparation.receiptDigest !== proof.preparationDigest || preparation.originalCohortDigest !== proof.original.cohortDigest
    || preparation.cohort.receiptDigest !== proof.candidate.cohortDigest
    || !same(artifactMap(preparation.cohort, homePath, proof.profile, preparation.candidateHome), proof.candidateArtifacts)) fail('prepared source or cohort changed')
  if (!same(await allProfileRoots(homePath, preparation.cohort), proof.profileRoots)) fail('Home profile roots changed')
  if (proof.auxiliary) await verifyHostLocalArtifacts({ proof: proof.auxiliary, homePath })
  if (repairMode(proof)) {
    const { verifyOwnerSourceRepair } = await import('./owner-source-repair.mjs')
    await verifyOwnerSourceRepair({ ownerRepair: proof.ownerRepair, homePath, physicalHome: homePath,
      installer: proof.installer, phase: 'original' })
  } else {
    const preOwner = await api.assertRsiPreOwnerInstallation({ logicalHome: homePath, physicalHome: homePath,
      profile: proof.profile, preparedCoordinator: true })
    if (!preOwner.preparedCoordinator || !same(preOwner, proof.original.preOwner)) fail('pre-owner identity changed')
  }
  const source = await api.readRsiSourceMaintenance({ logicalHome: homePath, physicalHome: homePath,
    profile: proof.profile })
  const cohort = await api.readRsiLocalCohort({ dshHome: homePath, profile: proof.profile })
  const runtime = await api.readRsiAuthorityRuntimeReceipt({ logicalHome: homePath, physicalHome: homePath,
    profile: proof.profile })
  if (!same(source, proof.original.source) || cohort.receiptDigest !== proof.original.cohortDigest
    || cohort.version !== proof.original.version || !same(runtime, proof.original.authorityRuntime)
    || !repairMode(proof) && !same(await ownerInventory(homePath, proof.profile), proof.original.ownerInventory)
    || !same(await profileInventory(homePath, proof.profile), proof.original.profileInventory)) fail('original source identity changed')
  return { preparation, source, cohort }
}

export async function prepareHostLocalSourceUpdate({ homePath, profile, preparationRoot, installerRoot, auxiliaryRoot,
  ownerRepairPreset, dshPath, dshEnvironment }) {
  await privateHome(homePath)
  if (!profileName.test(profile) || !exact(preparationRoot) || !exact(installerRoot)) fail('invalid source preparation input')
  const installer = await bindLocalSourceInstaller(installerRoot)
  const api = await loadLocalSourceInstaller(installer, { ownerRepair: ownerRepairPreset !== undefined })
  const preparation = await api.readRsiLocalUpdateLocked({ dshHome: homePath, profile, root: preparationRoot })
  if (preparation.extension !== undefined) fail('unsupported source preparation extension')
  let preOwner, ownerRepair, candidateCreation
  if (ownerRepairPreset !== undefined) {
    const helper = await import('./owner-source-repair.mjs')
    ownerRepair = await helper.captureOwnerSourceRepair({ homePath, profile, installer,
      permissionPreset: ownerRepairPreset, dshPath, dshEnvironment })
    const source = await api.readRsiSourceWorkspace({ dshHome: preparation.candidateHome, profile,
      sourceRepository: preparation.source.repository })
    const sourceBuild = await api.readRsiBuildEnvironment({ dshHome: preparation.candidateHome, profile, source })
    candidateCreation = await helper.prepareOwnerRepairCreation({ ownerRepair, candidateHome: preparation.candidateHome,
      source, sourceBuild, installer })
  } else {
    preOwner = await api.assertRsiPreOwnerInstallation({ logicalHome: homePath, physicalHome: homePath,
      profile, preparedCoordinator: true })
    if (!preOwner.preparedCoordinator) fail('prepared coordinator is absent')
  }
  const source = await api.readRsiSourceMaintenance({ logicalHome: homePath, physicalHome: homePath, profile })
  const cohort = await api.readRsiLocalCohort({ dshHome: homePath, profile })
  if (cohort.receiptDigest !== preparation.originalCohortDigest || cohort.version !== source.workspace.version
    || preOwner && (!same(source.anchor, preOwner.anchor) || !same(source.records, preOwner.records))) fail('original source evidence differs')
  const profileRoots = await allProfileRoots(homePath, preparation.cohort)
  if (profileRoots.missing.length && !exact(auxiliaryRoot)) fail('missing enhanced roots require an explicit auxiliary preparation root')
  const auxiliary = profileRoots.missing.length ? await prepareHostLocalArtifacts({ homePath, profile,
    sourcePreparationRoot: preparationRoot, installerRoot, root: auxiliaryRoot, bundles: profileRoots.missing }) : null
  const authorityRuntime = await api.readRsiAuthorityRuntimeReceipt({ logicalHome: homePath,
    physicalHome: homePath, profile })
  const proof = { protocol: ownerRepair ? repairProtocol : 'dsh-enhanced/host-local-source-update/v1', homePath, profile, preparationRoot,
    preparationDigest: preparation.receiptDigest, installer, profileRoots, auxiliary,
    ...(ownerRepair ? { ownerRepair, candidateCreation } : {}),
    original: { ...(preOwner ? { preOwner, ownerInventory: await ownerInventory(homePath, profile) } : {}),
      source, authorityRuntime, cohortDigest: cohort.receiptDigest, version: cohort.version,
      profileInventory: await profileInventory(homePath, profile) },
    candidate: { cohortDigest: preparation.cohort.receiptDigest, version: preparation.cohort.version,
      sourceCommit: preparation.source.sourceCommit },
    candidateArtifacts: artifactMap(preparation.cohort, homePath, profile, preparation.candidateHome) }
  await readOriginal(proof, homePath, api)
  return proof
}

export async function stageResourcesForPreparation({ proof, homePath, disposableHome }) {
  assertProtocol(proof)
  await assertLocalSourceInstaller(proof.installer)
  const api = await loadLocalSourceInstaller(proof.installer, { ownerRepair: repairMode(proof) })
  await readOriginal(proof, homePath, api)
  await privateHome(disposableHome)
  if (disposableHome === homePath || disposableHome.startsWith(`${homePath}${sep}`)
    || homePath.startsWith(`${disposableHome}${sep}`)) fail('disposable Home overlaps the original')
  const resources = await api.stageRsiLocalUpdateResources({ logicalHome: homePath, stagePhysicalHome: disposableHome,
    profile: proof.profile, preparationRoot: proof.preparationRoot })
  assertCandidateResources(resources, proof, disposableHome)
  const additional = proof.auxiliary ? (await materializeHostLocalArtifacts({ proof: proof.auxiliary,
    homePath, physicalHome: disposableHome })).artifacts : undefined
  return { resources: resources.proof, cohort: resources.cohort,
    candidateArtifacts: mergeArtifacts(artifactMap(resources.cohort, homePath, proof.profile, disposableHome), additional) }
}

export async function stageHostLocalSourceUpdate({ proof, homePath, stageHome }) {
  assertProtocol(proof)
  await assertLocalSourceInstaller(proof.installer)
  const api = await loadLocalSourceInstaller(proof.installer, { ownerRepair: repairMode(proof) })
  const { preparation, source, cohort } = await readOriginal(proof, homePath, api)
  await privateHome(stageHome)
  if (stageHome === homePath || stageHome.startsWith(`${homePath}${sep}`)
    || homePath.startsWith(`${stageHome}${sep}`)) fail('stage Home overlaps the original')
  const resources = await api.stageRsiLocalUpdateResources({ logicalHome: homePath, stagePhysicalHome: stageHome,
    profile: proof.profile, preparationRoot: proof.preparationRoot })
  assertCandidateResources(resources, proof, stageHome)
  const additional = proof.auxiliary ? (await materializeHostLocalArtifacts({ proof: proof.auxiliary,
    homePath, physicalHome: stageHome })).artifacts : undefined
  const record = await api.produceRsiLocalSourceMaintenance({ logicalHome: homePath, profile: proof.profile,
    preparation, stagePhysicalHome: stageHome, live: source, nextCohort: resources.cohort,
    ...(repairMode(proof) ? { maintenanceMode: 'owner-ledger' }
      : { maintenanceMode: 'pre-owner', preparedCoordinator: true }) })
  if (record.host !== null || record.before.cohortDigest !== cohort.receiptDigest
    || record.after.cohortDigest !== resources.cohort.receiptDigest) fail('source maintenance record is not pre-owner')
  await api.applyRsiSourceMaintenanceInStage({ logicalHome: homePath, physicalHome: stageHome, profile: proof.profile,
    sourceRepository: cohort.sourceRepository, candidateRoot: preparation.source.root,
    records: [...source.records, record] })
  if (repairMode(proof)) {
    const { appendOwnerSourceRepairMaintenance } = await import('./owner-source-repair.mjs')
    await appendOwnerSourceRepairMaintenance({ ownerRepair: proof.ownerRepair, homePath, stageHome, record, installer: proof.installer })
  }
  const staged = await api.readRsiSourceMaintenance({ logicalHome: homePath, physicalHome: stageHome,
    profile: proof.profile })
  if (!same(staged.records, [...source.records, record]) || staged.workspace.sourceCommit !== proof.candidate.sourceCommit
    || staged.workspace.version !== proof.candidate.version || !same(staged.anchor, source.anchor)) fail('staged source chain differs')
  const sourceProof = { ...proof, record, resources: resources.proof,
    ...(repairMode(proof) ? { candidateBuild: { sourceBuild: resources.sourceBuild, releaseBuild: resources.releaseBuild } } : {}),
    stagedCohortDigest: resources.cohort.receiptDigest,
    stagedArtifacts: mergeArtifacts(artifactMap(resources.cohort, homePath, proof.profile, stageHome), additional),
    candidateSource: { workspace: staged.workspace, originalBootstrapDigest: staged.originalBootstrapDigest,
      records: staged.records, anchor: staged.anchor } }
  await verifyHostLocalSourceUpdate({ proof: sourceProof, homePath, physicalHome: stageHome, selection: 'candidate' })
  return sourceProof
}

export async function finalizeHostLocalSourceUpdate({ proof, homePath, stageHome, stageNativeEffective,
  coordinatorBase, unitProperties, transactionId }) {
  if (proof.candidateRuntime) fail('candidate authority runtime is already finalized')
  await verifyHostLocalSourceUpdate({ proof, homePath, physicalHome: stageHome, selection: 'candidate' })
  const api = await loadLocalSourceInstaller(proof.installer, { ownerRepair: repairMode(proof) })
  const packageRoot = await realpath(join(stageHome, 'profiles', proof.profile,
    'node_modules', '@dsh-enhanced', 'plugin-control-plane'))
  if (!packageRoot.startsWith(`${stageHome}${sep}`)) fail('candidate control-plane package escaped the stage')
  const runtime = await api.replaceRsiAuthorityRuntimeInStage({ logicalHome: homePath,
    physicalHome: stageHome, profile: proof.profile }, { packageRoot, nodePath: await realpath(process.execPath) })
  const candidateRuntime = await api.readRsiAuthorityRuntimeReceipt({ logicalHome: homePath,
    physicalHome: stageHome, profile: proof.profile })
  if (!same(candidateRuntime.runtime, runtime)) fail('candidate authority runtime receipt differs')
  let ownerRepairNext
  if (repairMode(proof)) {
    const { stageOwnerSourceRepair } = await import('./owner-source-repair.mjs')
    const resources = await api.prepareRsiAuthorityResources({ dshHome: homePath, profile: proof.profile, existingOnly: true })
    ownerRepairNext = await stageOwnerSourceRepair({ ownerRepair: proof.ownerRepair, homePath, stageHome,
      record: proof.record, resources, runtime, source: proof.candidateSource.workspace,
      sourceBuild: proof.candidateBuild.sourceBuild, releaseBuild: proof.candidateBuild.releaseBuild,
      candidateCreation: proof.candidateCreation, stageNativeEffective, coordinatorBase, unitProperties,
      installer: proof.installer, transactionId })
  }
  const finalized = { ...proof, candidateRuntime, ...(ownerRepairNext ? { ownerRepairNext } : {}) }
  await verifyHostLocalSourceUpdate({ proof: finalized, homePath, physicalHome: stageHome, selection: 'candidate' })
  return finalized
}

export async function verifyHostLocalSourceUpdate({ proof, homePath, physicalHome, selection, checkLedger = false }) {
  assertProtocol(proof)
  if (!['original', 'candidate'].includes(selection) || proof.homePath !== homePath) fail('source proof selection differs')
  await assertLocalSourceInstaller(proof.installer)
  const api = await loadLocalSourceInstaller(proof.installer, { ownerRepair: repairMode(proof) })
  if (selection === 'original') { await readOriginal(proof, homePath, api); return }
  await privateHome(physicalHome)
  if (!proof.resources || !proof.candidateSource || !proof.record || proof.record.host !== null
    || proof.resources.preparationDigest !== proof.preparationDigest) fail('candidate source proof is incomplete')
  if (proof.record.after.cohortDigest !== proof.stagedCohortDigest
    || proof.record.before.cohortDigest !== proof.original.cohortDigest) fail('staged cohort record differs')
  await api.verifyRsiLocalUpdateResources({ physicalHome, proof: proof.resources })
  const cohortPath = join(physicalHome, 'rsi-local-cohorts', proof.profile, 'receipt.json')
  await privateFileDigest(cohortPath)
  const cohort = JSON.parse((await readFile(cohortPath)).toString('utf8'))
  if (cohort.receiptDigest !== proof.stagedCohortDigest) fail('candidate cohort receipt differs')
  const primary = artifactMap(cohort, homePath, proof.profile, physicalHome)
  if (proof.auxiliary) {
    const additional = await verifyHostLocalArtifactsInHome({ proof: proof.auxiliary, homePath, physicalHome,
      skipOriginal: physicalHome === homePath })
    if (!same(artifactIdentity(mergeArtifacts(primary, additional.artifacts)), artifactIdentity(proof.stagedArtifacts))) {
      fail('staged auxiliary artifacts changed')
    }
  } else if (!same(artifactIdentity(primary), artifactIdentity(proof.stagedArtifacts))) fail('staged candidate artifacts changed')
  const source = await api.readRsiSourceMaintenance({ logicalHome: homePath, physicalHome,
    profile: proof.profile })
  if (!same(source, proof.candidateSource) || !same(source.records, [...proof.original.source.records, proof.record])
    || !same(source.anchor, proof.original.source.anchor)
    || source.workspace.sourceCommit !== proof.candidate.sourceCommit
    || source.workspace.version !== proof.candidate.version) fail('candidate signed source chain differs')
  if (repairMode(proof)) {
    const { verifyOwnerSourceRepair } = await import('./owner-source-repair.mjs')
    await verifyOwnerSourceRepair({ ownerRepair: proof.ownerRepair, ownerRepairNext: proof.ownerRepairNext,
      record: proof.record, homePath, physicalHome, installer: proof.installer,
      phase: proof.ownerRepairNext ? 'after-finalize' : 'before-finalize', checkLedger })
  } else {
    const inventory = await ownerInventory(physicalHome, proof.profile)
    if (inventory.authorityTree !== proof.original.ownerInventory.authorityTree
      || inventory.marker !== proof.original.ownerInventory.marker
      || inventory.authorityBootstrap !== proof.original.ownerInventory.authorityBootstrap
      || inventory.sourceBootstrap !== proof.original.ownerInventory.sourceBootstrap) fail('candidate authority or bootstrap changed')
  }
  const runtime = await api.readRsiAuthorityRuntimeReceipt({ logicalHome: homePath, physicalHome,
    profile: proof.profile })
  if (!same(runtime, proof.candidateRuntime ?? proof.original.authorityRuntime)) fail('candidate authority runtime changed')
}
