import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createHash, createPublicKey, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import type { ActiveLarkOwnerBindingsSnapshot } from '@dsh-enhanced/assistant-delivery'
import { compileRsiProfiles, type RsiSetupManifest } from './rsi-profile.js'
import { withDshHomeLifecycleLock } from './setup.js'
import { supervisedGrowthBindingQuery, supervisedGrowthDatabasePaths } from './supervised-growth-profile.js'
import { installDshResidentService } from './resident.js'
import { prepareRsiSourceWorkspace } from './rsi-source.js'
import { prepareRsiBuildEnvironment, RsiBuildUnavailableError } from './rsi-build.js'
import { prepareRsiReleaseBuildEnvironment, RsiReleaseBuildUnavailableError } from './rsi-release-build.js'
import { prepareRsiAuthorityRuntime } from './rsi-authority-runtime.js'
import { prepareRsiAuthorityResources } from './rsi-authority-resources.js'
import { version } from './version.js'
import { renderDshSystemdService, systemdServicePaths } from './systemd.js'
import { rsiServiceEnvironmentPath, type RsiServiceEnvironment } from './rsi-service-environment.js'
import { resolveRsiServiceEnvironments } from './rsi-service-setup.js'
import { validateRsiHostAuthorities } from './rsi-host-authorities.js'

const MAX_BYTES = 2_097_152
const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
function fail(message: string): never { throw new Error(`rsi setup: ${message}`) }

// Compare semantic YAML nodes, including executable !!js tags, without depending
// on comments or formatting retained by the profile patch serializer.
function yamlValue(node: unknown): unknown {
  if (isScalar(node)) return { tag: node.tag, value: node.value }
  if (isSeq(node)) return { tag: node.tag, items: node.items.map(yamlValue) }
  if (isMap(node)) return { tag: node.tag, entries: node.items.map(item => [yamlValue(item.key), yamlValue(item.value)])
    .sort((left, right) => JSON.stringify(left[0]).localeCompare(JSON.stringify(right[0]))) }
  return node
}
export function assertRsiEffectivePatch(patch: string, effective: string): void {
  const expected = parseDocument(patch), actual = parseDocument(effective)
  if (expected.errors.length || actual.errors.length || !isSeq(expected.contents) || !isSeq(actual.contents)) fail('invalid final profile composition')
  for (const row of expected.contents.items) {
    if (!isMap(row) || !row.has('config')) continue
    const matches = actual.contents.items.filter(item => isMap(item) && item.get('id') === row.get('id'))
    const resolved = matches[0]
    if (matches.length !== 1 || !isMap(resolved) || (resolved.get('disabled') as unknown) === true && (row.get('disabled') as unknown) !== true
      || !isDeepStrictEqual(yamlValue(row.get('config', true)), yamlValue(resolved.get('config', true)))) fail(`effective profile overrides compiled config for ${String(row.get('id'))}`)
  }
}

export interface RsiSetupArgs {
  manifestPath: string; dshHome: string; apply: boolean; rollback: boolean; start: boolean; confirmStopped: boolean; help: boolean
  prepareSource?: boolean; profile?: string; sourceRepository?: string
  prepareBuild?: boolean; optionalBuild?: boolean; dockerPath?: string
  prepareAuthorities?: boolean
  installOwner?: boolean
  installLocalCohort?: boolean; bundles?: string[]
}
export function parseRsiSetupArgs(argv: readonly string[]): RsiSetupArgs {
  const result: RsiSetupArgs = { manifestPath: '', dshHome: process.env.DSH_HOME || join(homedir(), '.dsh'),
    apply: false, rollback: false, start: false, confirmStopped: false, help: false }
  const seen = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!
    if (key !== '--bundle' && seen.has(key)) fail(`duplicate option ${key}`)
    seen.add(key)
    if (key === '--help' || key === '-h') result.help = true
    else if (key === '--apply') result.apply = true
    else if (key === '--rollback') result.rollback = true
    else if (key === '--start') result.start = true
    else if (key === '--confirm-hosts-stopped') result.confirmStopped = true
    else if (key === '--prepare-source') result.prepareSource = true
    else if (key === '--prepare-build') result.prepareBuild = true
    else if (key === '--prepare-authorities') result.prepareAuthorities = true
    else if (key === '--install-owner') result.installOwner = true
    else if (key === '--install-local-cohort') result.installLocalCohort = true
    else if (key === '--bundle') {
      const value = argv[++i]
      if (!value || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value)) fail('--bundle requires a plugin slug')
      ;(result.bundles ??= []).push(value)
    }
    else if (key === '--optional-build') result.optionalBuild = true
    else if (key === '--manifest' || key === '--dsh-home' || key === '--profile' || key === '--source-repository' || key === '--docker-path') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) fail(`${key} needs a value`)
      if (key === '--manifest') result.manifestPath = resolve(value!)
      else if (key === '--profile') result.profile = value
      else if (key === '--source-repository') result.sourceRepository = value
      else if (key === '--docker-path') result.dockerPath = value
      else result.dshHome = value!
    } else fail(`unknown option ${key}`)
  }
  if (result.help) return result
  if (result.bundles && !result.installLocalCohort) fail('--bundle requires --install-local-cohort')
  if (result.installLocalCohort) {
    if (result.installOwner || result.prepareSource || result.prepareBuild || result.prepareAuthorities || result.manifestPath
      || result.apply || result.rollback || result.start || result.confirmStopped || result.optionalBuild || result.dockerPath) fail('local cohort installation cannot be combined with other operations')
    if (!isAbsolute(result.dshHome) || !result.profile || !profilePattern.test(result.profile)
      || !result.sourceRepository || !isAbsolute(result.sourceRepository) || !result.bundles?.length
      || new Set(result.bundles).size !== result.bundles.length) fail('local cohort installation requires a profile, absolute source repository and unique bundles')
    return result
  }
  if ((result.optionalBuild || result.dockerPath) && !result.prepareBuild) fail('--optional-build and --docker-path require --prepare-build')
  if (result.installOwner) {
    if (result.prepareSource || result.prepareBuild || result.prepareAuthorities || result.manifestPath || result.apply
      || result.rollback || result.start || result.confirmStopped || result.optionalBuild || result.dockerPath) fail('owner installation cannot be combined with other operations')
    if (!isAbsolute(result.dshHome) || !result.profile || !profilePattern.test(result.profile)) fail('owner installation requires --profile and absolute DSH_HOME')
    if (result.sourceRepository && !isAbsolute(result.sourceRepository)) fail('--source-repository must be absolute')
    return result
  }
  if (result.prepareSource || result.prepareBuild || result.prepareAuthorities) {
    if ([result.prepareSource, result.prepareBuild, result.prepareAuthorities].filter(Boolean).length > 1) fail('resource preparation modes cannot be combined')
    if (result.manifestPath || result.apply || result.rollback || result.start || result.confirmStopped) fail('resource preparation cannot be combined with profile configuration operations')
    if (!isAbsolute(result.dshHome) || !result.profile || !profilePattern.test(result.profile)) fail('resource preparation requires --profile and absolute DSH_HOME')
    if (result.prepareAuthorities && result.sourceRepository) fail('--source-repository requires --prepare-source or --prepare-build')
    if (result.sourceRepository && !isAbsolute(result.sourceRepository)) fail('--source-repository must be absolute')
    if (result.dockerPath && !isAbsolute(result.dockerPath)) fail('--docker-path must be absolute')
    return result
  }
  if (result.profile || result.sourceRepository) fail('--profile and --source-repository require --prepare-source, --prepare-build or --prepare-authorities')
  if (!result.manifestPath || !isAbsolute(result.dshHome)) fail('--manifest and absolute DSH_HOME are required')
  if (result.rollback && (result.apply || result.start)) fail('--rollback cannot be combined with --apply or --start')
  if (result.start && !result.apply) fail('--start requires --apply')
  if ((result.apply || result.rollback) && !result.confirmStopped) fail('stop both Hosts and pass --confirm-hosts-stopped')
  return result
}

async function readOwnedFile(path: string, privateFile = true, allowRoot = false): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) fail(`noncanonical file: ${path}`)
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const entry = await descriptor.stat(), linked = await lstat(path)
    if (!entry.isFile() || (!allowRoot && entry.nlink !== 1) || (entry.uid !== process.getuid?.() && !(allowRoot && entry.uid === 0)) || entry.size > MAX_BYTES
      || (entry.mode & (privateFile ? 0o077 : 0o022)) !== 0 || linked.ino !== entry.ino || linked.dev !== entry.dev) fail(`unsafe file: ${path}`)
    return await descriptor.readFile('utf8')
  } finally { await descriptor.close() }
}
async function safeDirectory(path: string): Promise<void> {
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid?.()
    || (entry.mode & 0o022) !== 0 || await realpath(path) !== path) fail(`unsafe directory: ${path}`)
}
async function syncDirectory(path: string): Promise<void> {
  const descriptor = await open(path, constants.O_RDONLY)
  try { await descriptor.sync() } finally { await descriptor.close() }
}
async function atomicWrite(path: string, value: string): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`
  const descriptor = await open(temporary, 'wx', 0o600)
  try { await descriptor.writeFile(value); await descriptor.sync() } finally { await descriptor.close() }
  try { await rename(temporary, path); await chmod(path, 0o600); await syncDirectory(dirname(path)) }
  finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }) }
}

interface JournalEntry { profile: string; before: string; after: string }
interface AuxiliaryEntry { profile: string; before: string | null; after: string | null }
interface Journal { schemaVersion: 1 | 2; manifestDigest: string; stage: 'prepared' | 'applied'; entries: [JournalEntry, JournalEntry]
  environments?: [AuxiliaryEntry, AuxiliaryEntry]; units?: [AuxiliaryEntry, AuxiliaryEntry] }
function profiles(manifest: Pick<RsiSetupManifest, 'targetProfile' | 'coordinatorProfile'>): [string, string] {
  const values: [string, string] = [manifest.targetProfile, manifest.coordinatorProfile]
  if (!values.every(value => typeof value === 'string' && profilePattern.test(value)) || values[0] === values[1]) fail('profiles must be distinct canonical names')
  return values
}
function patchPath(home: string, profile: string): string { return join(home, 'profiles', profile, 'cordis.patch.yml') }
async function readJournal(path: string, expected: readonly string[]): Promise<Journal | undefined> {
  let content: string
  try { content = await readOwnedFile(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  const value = JSON.parse(content) as Journal
  if (![1, 2].includes(value.schemaVersion) || !['prepared', 'applied'].includes(value.stage) || !/^[a-f0-9]{64}$/u.test(value.manifestDigest)
    || !Array.isArray(value.entries) || value.entries.length !== 2
    || value.entries.some((entry, index) => entry.profile !== expected[index] || typeof entry.before !== 'string' || typeof entry.after !== 'string')) fail('journal does not match this profile pair')
  if (value.schemaVersion === 2) {
    for (const entries of [value.environments, value.units]) {
      if (!Array.isArray(entries) || entries.length !== 2 || entries.some((entry, index) => entry.profile !== expected[index]
        || (entry.before !== null && typeof entry.before !== 'string') || (entry.after !== null && typeof entry.after !== 'string'))) fail('invalid service environment journal')
    }
  } else if (value.environments || value.units) fail('legacy journal cannot contain service resources')
  return value
}
async function readOptionalFile(path: string, privateFile = true): Promise<string | null> {
  try { return await readOwnedFile(path, privateFile) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // realpath also reports ENOENT for dangling links; those are not absent files.
    try { await lstat(path) }
    catch (linkedError) { if ((linkedError as NodeJS.ErrnoException).code === 'ENOENT') return null; throw linkedError }
    fail(`unsafe file: ${path}`)
  }
}
async function writeOptionalFile(path: string, value: string | null): Promise<void> {
  if (value !== null) { await atomicWrite(path, value); return }
  try { await unlink(path); await syncDirectory(dirname(path)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
function auxiliary(home: string, journal: Journal, ports: RsiSetupPorts) {
  return [
    ...(journal.environments ?? []).map(entry => ({ ...entry, path: rsiServiceEnvironmentPath(home, entry.profile), privateFile: true })),
    ...(journal.units ?? []).map(entry => ({ ...entry, path: ports.serviceUnitPath(entry.profile, home), privateFile: false })),
  ]
}
async function rollback(home: string, journalPath: string, journal: Journal, ports: RsiSetupPorts): Promise<void> {
  // Check every resource before restoring any. Retry accepts a half-restored transaction.
  for (const entry of journal.entries) {
    const current = await readOwnedFile(patchPath(home, entry.profile), false)
    if (current !== entry.before && current !== entry.after) fail('profile changed outside setup; retain journal for reconciliation')
  }
  const resources = auxiliary(home, journal, ports)
  for (const entry of resources) {
    const current = await readOptionalFile(entry.path, entry.privateFile)
    if (current !== entry.before && current !== entry.after) fail('service resource changed outside setup; retain journal for reconciliation')
  }
  for (const entry of journal.entries) await atomicWrite(patchPath(home, entry.profile), entry.before)
  for (const entry of resources) await writeOptionalFile(entry.path, entry.before)
  if (journal.units) ports.reloadServices()
  await unlink(journalPath); await syncDirectory(home)
}

export interface RsiSetupPorts {
  dump(profile: string, home: string): string
  base(profile: string, home: string): Promise<string>
  snapshot(effective: string, home: string): Promise<ActiveLarkOwnerBindingsSnapshot>
  compile: typeof compileRsiProfiles
  validateAuthorities(manifest: RsiSetupManifest, owner: ActiveLarkOwnerBindingsSnapshot['bindings'][number], environment?: RsiServiceEnvironment): Promise<void>
  resolveEnvironments: typeof resolveRsiServiceEnvironments
  serviceUnitPath(profile: string, home: string): string
  renderServiceUnit(profile: string, home: string, environment: RsiServiceEnvironment): Promise<string>
  reloadServices(): void
  validateServiceUnits(manifest: RsiSetupManifest, environment: RsiServiceEnvironment): Promise<void>
  assertStopped(profile: string): void
  start(profile: string, home: string): Promise<void>
}

export const rsiSetupPorts: RsiSetupPorts = {
  async base(profile, home) {
    // Resolve the installed package symlink, then pin a bounded non-writable file.
    const path = await realpath(join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml'))
    return readOwnedFile(path, false, true)
  },
  dump(profile, home) {
    const result = spawnSync('dsh', ['--profile', profile, '--dump-config'], { encoding: 'utf8', timeout: 60_000,
      maxBuffer: MAX_BYTES, env: { ...process.env, DSH_HOME: home } })
    if (result.status !== 0 || result.error) fail(`cannot compose profile ${profile}`)
    return result.stdout
  },
  async snapshot(effective, home) {
    const { inspectActiveLarkOwnerBindingsLocally } = await import('@dsh-enhanced/assistant-delivery')
    return inspectActiveLarkOwnerBindingsLocally({ databasePath: supervisedGrowthDatabasePaths(effective, home).deliveryDatabasePath,
      ...supervisedGrowthBindingQuery(effective, home) })
  },
  compile: compileRsiProfiles,
  validateAuthorities: validateRsiAuthorities,
  resolveEnvironments: resolveRsiServiceEnvironments,
  serviceUnitPath: (profile, home) => systemdServicePaths({ dshHome: home, profile }).unitPath,
  async renderServiceUnit(profile, home, environment) { return (await renderDshSystemdService({ dshHome: home, profile }, { environment })).source },
  reloadServices() {
    const result = spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536 })
    if (result.status !== 0 || result.error) fail('cannot reload service definitions')
  },
  validateServiceUnits: validateRsiServiceUnitEnvironment,
  assertStopped(profile) {
    const result = spawnSync('systemctl', ['--user', 'show', `dsh-profile-${profile}.service`, '--property=ActiveState', '--value'],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536 })
    if (result.status !== 0 || result.error || !['inactive', 'failed'].includes(result.stdout.trim())) fail(`systemd profile ${profile} must be stopped`)
  },
  async start(profile, home) { await installDshResidentService({ dshHome: home, profile }) },
}

/** Read back the loaded unit after daemon-reload, before starting either Host. */
export async function validateRsiServiceUnitEnvironment(manifest: Pick<RsiSetupManifest, 'targetProfile'>, environment: RsiServiceEnvironment): Promise<void> {
  const path = environment.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG
  if (!path) return
  const wrapper = JSON.parse(await readOwnedFile(path)) as { schemaVersion: number; template?: { unitProperties?: { Environment?: string } } }
  if (wrapper.schemaVersion !== 4) return
  const result = spawnSync('systemctl', ['--user', 'show', `dsh-profile-${manifest.targetProfile}.service`, '--property=Environment', '--value'],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536 })
  if (result.status !== 0 || result.error || result.stdout.trimEnd() !== wrapper.template?.unitProperties?.Environment) fail('effective service environment differs from the Host installation grant')
}

/** Validate imported finite grants, without calling any signing/authorization method. */
export async function validateRsiAuthorities(manifest: RsiSetupManifest, binding: ActiveLarkOwnerBindingsSnapshot['bindings'][number], environment?: RsiServiceEnvironment): Promise<void> {
  const cp: typeof import('@dsh-enhanced/plugin-control-plane') = await import('@dsh-enhanced/plugin-control-plane')
  const config = manifest.controlPlane
  if (!config.sourceJobs || !config.sourceApprovals || !config.sourceReleases || !config.sourceAdoptions || !config.taskObservations) fail('source authority chain is incomplete')
  const approvals: unknown = JSON.parse(await readOwnedFile(config.sourceApprovals!.configPath))
  const releases: unknown = JSON.parse(await readOwnedFile(config.sourceReleases!.configPath))
  const adoptions: unknown = JSON.parse(await readOwnedFile(config.sourceAdoptions!.authority.configPath))
  const observations: unknown = JSON.parse(await readOwnedFile(config.taskObservations!.authority.configPath))
  cp.validateSourceApprovalAuthorityConfig(approvals); cp.validateSourceReleaseAuthorityConfig(releases)
  cp.validateSourceAdoptionAuthorityConfig(adoptions); cp.validateTaskObservationAuthorityConfig(observations)
  const expectedOwner = manifest.sourceReviews.owner
  if (expectedOwner.principalRecordId !== binding.owner.id || expectedOwner.principalVersion !== binding.owner.version) fail('grant owner has changed')
  const trust = await cp.loadTrustConfig(config.trustPath)
  if (trust.schemaVersion !== 4 || !trust.hostAttestor || !trust.releaseAdapters
    || ['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'].some(phase => !Object.hasOwn(trust.releaseAdapters!, phase))) fail('complete release and Host attestation adapters are required')
  const ledgerPath = join(config.statePath, 'control.sqlite')
  const { id, version, path, sha256 } = trust.executor
  for (const authority of [approvals, releases, adoptions, observations]) {
    if (authority.controlDatabasePath !== ledgerPath || !isDeepStrictEqual(authority.grant.owner, expectedOwner)) fail('authority owner/ledger mismatch')
  }
  if (trust.ledger.path !== ledgerPath || adoptions.grant.ledger.path !== ledgerPath
    || !isDeepStrictEqual(adoptions.grant.ledger, trust.ledger) || adoptions.grant.installationId !== trust.installationId
    || adoptions.grant.target.dshHome !== trust.dshHome || trust.catalog.path !== config.catalogPath
    || adoptions.grant.target.profile !== manifest.targetProfile || adoptions.grant.target.profilePath !== config.runtimeObserver?.profilePath
    || adoptions.grant.target.profilePath !== join(trust.dshHome, 'profiles', manifest.targetProfile)
    || !isDeepStrictEqual(adoptions.grant.executor, { id, version, path, sha256 })
    || !isDeepStrictEqual(adoptions.grant.liveQualification, config.sourceAdoptions!.liveQualification)
    || !isDeepStrictEqual(adoptions.grant.hostDeploymentInputs, config.sourceAdoptions!.hostDeploymentInputs)
    || adoptions.grant.catalogPath !== config.catalogPath || !isDeepStrictEqual(adoptions.grant.handoff, config.sourceAdoptions!.handoff)
    || approvals.grant.repository !== config.sourceJobs!.repository || releases.grant.repository !== config.sourceJobs!.repository
    || approvals.grant.worktreeRoot !== join(config.statePath, 'source-worktrees') || releases.grant.worktreeRoot !== approvals.grant.worktreeRoot
    || approvals.grant.versioning !== 'patch' || releases.grant.versioning !== 'patch'
    || !isDeepStrictEqual(observations.grant.policy, config.taskObservations!.policy)
    || observations.grant.profilePath !== config.taskObservations!.profilePath
    || observations.grant.installationId !== trust.installationId || !isDeepStrictEqual(observations.grant.ledger, trust.ledger)) fail('authority deployment terms mismatch')
  const selected = [...approvals.grant.plugins].sort()
  if (!isDeepStrictEqual([...observations.grant.packages].sort(), selected.map(plugin => `@dsh-enhanced/${plugin}`))) fail('observation package allowlist does not match')
  for (const plugins of [releases.grant.plugins, adoptions.grant.policies.map(policy => policy.candidateId), manifest.sourceReviews.plugins]) {
    if (!isDeepStrictEqual(selected, [...plugins].sort())) fail('authority plugin allowlists do not match')
  }
  for (const policy of adoptions.grant.policies) {
    const release = releases.grant.policies.find(item => item.candidateId === policy.candidateId)
    if (!release || release.catalogId !== trust.catalog.id || release.catalogPath !== trust.catalog.path
      || Object.entries(policy).some(([key, value]) => !isDeepStrictEqual(value, release[key as keyof typeof release]))) fail('release and adoption policies do not match')
  }
  for (const [authority, purpose] of [[approvals, 'approval'], [adoptions, 'approval'], [releases, 'release-authorization'], [observations, 'host-attestation']] as const) {
    const trusted = cp.resolveTrustKey(trust, purpose, authority.authority, authority.keyId)
    const configured = createPublicKey(await readOwnedFile(authority.keyPath)).export({ type: 'spki', format: 'der' })
    const registered = createPublicKey(trusted.publicKeyPem).export({ type: 'spki', format: 'der' })
    if (!configured.equals(registered)) fail('authority key does not match registered trust')
  }
  if (config.liveQualification) {
    const qualification: unknown = JSON.parse(await readOwnedFile(config.liveQualification.authority.configPath))
    cp.validateLiveQualificationAuthorityConfig(qualification)
    if (qualification.controlDatabasePath !== ledgerPath || !isDeepStrictEqual(qualification.grant.owner, expectedOwner)
      || !isDeepStrictEqual(qualification.grant.terms, config.sourceAdoptions!.liveQualification)
      || qualification.grant.installationId !== trust.installationId || !isDeepStrictEqual(qualification.grant.ledger, trust.ledger)
      || qualification.grant.profilePath !== config.liveQualification.profilePath
      || !isDeepStrictEqual([...qualification.grant.packages].sort(), selected.map(plugin => `@dsh-enhanced/${plugin}`))
      || qualification.grant.expiresAt <= Date.now()) fail('live qualification authority terms mismatch')
    const trusted = cp.resolveTrustKey(trust, 'host-attestation', qualification.authority, qualification.keyId)
    const configured = createPublicKey(await readOwnedFile(qualification.keyPath)).export({ type: 'spki', format: 'der' })
    if (!configured.equals(createPublicKey(trusted.publicKeyPem).export({ type: 'spki', format: 'der' }))) fail('live qualification authority key mismatch')
  }
  if ([approvals.grant.expiresAt, releases.grant.expiresAt, adoptions.grant.expiresAt, observations.grant.policy.expiresAt,
    manifest.sourceReviews.expiresAt].some(value => value <= Date.now())) fail('finite authority has expired')
  await validateRsiHostAuthorities({ trust, adoption: adoptions, owner: expectedOwner, ledgerPath, trustPath: config.trustPath,
    targetProfile: manifest.targetProfile,
    liveQualification: config.sourceAdoptions!.liveQualification, hostDeploymentInputs: config.sourceAdoptions!.hostDeploymentInputs,
    handoff: config.sourceAdoptions!.handoff, ...(environment === undefined ? {} : { environment }), readPrivate: path => readOwnedFile(path) })
}

export async function configureRsiSetup(args: RsiSetupArgs, ports: RsiSetupPorts = rsiSetupPorts): Promise<{ mode: string; profiles: readonly string[] }> {
  return withDshHomeLifecycleLock(args.dshHome, () => configureRsiSetupLocked(args, ports))
}

/** Internal installer entry: caller already owns the DSH_HOME lifecycle lock. */
export async function configureRsiSetupLocked(args: RsiSetupArgs, ports: RsiSetupPorts = rsiSetupPorts): Promise<{ mode: string; profiles: readonly string[] }> {
  if (args.installLocalCohort || args.bundles || args.installOwner || args.prepareSource || args.prepareBuild || args.prepareAuthorities || args.optionalBuild || args.dockerPath || args.profile || args.sourceRepository) fail('resource preparation is a separate setup operation')
  if (args.rollback && (args.apply || args.start) || args.start && !args.apply) fail('incompatible setup operations')
  const home = args.dshHome
  await safeDirectory(home)
  const manifestBytes = await readOwnedFile(args.manifestPath)
  const manifest = JSON.parse(manifestBytes) as RsiSetupManifest
  const pair = profiles(manifest)
  return (async () => {
    for (const profile of pair) await safeDirectory(join(home, 'profiles', profile))
    const journalPath = join(home, '.rsi-setup-journal.json')
    const previous = await readJournal(journalPath, pair)
    if (args.apply || args.rollback) {
      if (!args.confirmStopped) fail('both Hosts must be stopped')
      for (const profile of pair) ports.assertStopped(profile)
    }
    if (args.rollback) {
      if (!previous) fail('no setup journal to roll back')
      await rollback(home, journalPath, previous!, ports)
      return { mode: 'rolled-back', profiles: pair }
    }
    if (previous?.stage === 'prepared') fail('interrupted setup; use --rollback before continuing')
    const original = await Promise.all(pair.map(profile => readOwnedFile(patchPath(home, profile), false)))
    const effective = pair.map(profile => ports.dump(profile, home))
    const coordinatorBase = await ports.base(pair[1], home)
    const snapshot = await ports.snapshot(effective[0]!, home)
    if (snapshot.bindings.length !== 1) fail('exactly one active owner DM binding is required')
    const owner = snapshot.bindings[0]!
    const input = { manifest, dshHome: home, targetPatch: original[0]!, coordinatorPatch: original[1]!,
      targetEffective: effective[0]!, coordinatorEffective: effective[1]!, coordinatorBase, owner }
    const compiled = await ports.compile(input)
    const originalEnvironments = await Promise.all(pair.map(profile => readOptionalFile(rsiServiceEnvironmentPath(home, profile))))
    const environments = await ports.resolveEnvironments(manifest, home)
    const originalUnits = environments ? await Promise.all(pair.map(profile => readOptionalFile(ports.serviceUnitPath(profile, home), false))) : undefined
    const nextUnits = environments ? await Promise.all(pair.map((profile, index) => ports.renderServiceUnit(profile, home, index === 0 ? environments.target : environments.coordinator))) : undefined
    await ports.validateAuthorities(manifest, owner, environments?.target)
    if (!args.apply) return { mode: 'checked', profiles: pair }
    if (await readOwnedFile(args.manifestPath) !== manifestBytes || await ports.base(pair[1], home) !== coordinatorBase
      || !isDeepStrictEqual(snapshot, await ports.snapshot(effective[0]!, home))) fail('manifest or owner snapshot changed before write')
    for (let i = 0; i < pair.length; i++) {
      ports.assertStopped(pair[i]!)
      if (await readOwnedFile(patchPath(home, pair[i]!), false) !== original[i]) fail('profile changed before write')
      if (environments && (await readOptionalFile(rsiServiceEnvironmentPath(home, pair[i]!)) !== originalEnvironments[i]
        || await readOptionalFile(ports.serviceUnitPath(pair[i]!, home), false) !== originalUnits![i])) fail('service resource changed before write')
    }
    const next = [compiled.targetPatch, compiled.coordinatorPatch]
    if (previous && previous.entries.some((entry, i) => entry.after !== original[i])) fail('profile changed since previous setup; reconcile its journal first')
    const journal: Journal = { schemaVersion: environments ? 2 : 1, manifestDigest: digest(manifestBytes), stage: 'prepared',
      entries: pair.map((profile, i) => ({ profile, before: original[i]!, after: next[i]! })) as Journal['entries'],
      ...(environments ? {
        environments: pair.map((profile, i) => ({ profile, before: originalEnvironments[i]!, after: JSON.stringify({ schemaVersion: 1,
          dshHome: home, profile, environment: i === 0 ? environments.target : environments.coordinator }) + '\n' })) as NonNullable<Journal['environments']>,
        units: pair.map((profile, i) => ({ profile, before: originalUnits![i]!, after: nextUnits![i]! })) as NonNullable<Journal['units']>,
      } : {}) }
    if (previous) for (const entry of auxiliary(home, previous, ports)) {
      if (await readOptionalFile(entry.path, entry.privateFile) !== entry.after) fail('service resource changed since previous setup; reconcile its journal first')
    }
    if (Buffer.byteLength(JSON.stringify(journal)) > MAX_BYTES) fail('combined profile journal exceeds setup size limit')
    const unchanged = next.every((value, i) => value === original[i]) && auxiliary(home, journal, ports).every(entry => entry.before === entry.after)
    if (unchanged) for (let i = 0; i < pair.length; i++) assertRsiEffectivePatch(next[i]!, effective[i]!)
    if (!unchanged) {
      for (const entry of auxiliary(home, journal, ports)) {
        await mkdir(dirname(entry.path), { recursive: true, mode: 0o700 })
        await safeDirectory(dirname(entry.path))
        if (entry.privateFile && ((await lstat(dirname(entry.path))).mode & 0o077) !== 0) fail('service environment directory must be private')
      }
      await atomicWrite(journalPath, JSON.stringify(journal))
      try {
        for (const entry of journal.entries) await atomicWrite(patchPath(home, entry.profile), entry.after)
        for (const entry of auxiliary(home, journal, ports)) await writeOptionalFile(entry.path, entry.after)
        const final = pair.map(profile => ports.dump(profile, home))
        for (let i = 0; i < pair.length; i++) assertRsiEffectivePatch(next[i]!, final[i]!)
        const recompiled = await ports.compile({ ...input, targetPatch: next[0]!, coordinatorPatch: next[1]!,
          targetEffective: final[0]!, coordinatorEffective: final[1]! })
        if (!isDeepStrictEqual(recompiled, compiled)) fail('effective profile differs from the compiled deployment')
        if (environments) { ports.reloadServices(); await ports.validateServiceUnits(manifest, environments.target) }
        journal.stage = 'applied'; await atomicWrite(journalPath, JSON.stringify(journal))
      } catch (error) {
        await rollback(home, journalPath, journal, ports)
        if (previous) await atomicWrite(journalPath, JSON.stringify(previous))
        throw error
      }
    }
    if (unchanged && environments) { ports.reloadServices(); await ports.validateServiceUnits(manifest, environments.target) }
    // Starting is explicit and follows successful composition of both profiles.
    // A failed start retains the applied journal; it never rewrites a live Host.
    if (args.start) { await ports.start(pair[1], home); await ports.start(pair[0], home) }
    return { mode: args.start ? 'services-started' : 'configured', profiles: pair }
  })()
}

export async function runRsiSetup(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseRsiSetupArgs(argv)
  if (args.help) {
    process.stdout.write('Usage: dsh-rsi-setup --manifest <private.json> [--dsh-home <absolute>] [--apply --confirm-hosts-stopped [--start] | --rollback --confirm-hosts-stopped]\n       dsh-rsi-setup --prepare-source --profile <name> [--dsh-home <absolute>] [--source-repository <local-absolute>]\n       dsh-rsi-setup --prepare-build --profile <name> [--dsh-home <absolute>] [--source-repository <local-absolute>] [--docker-path <absolute>] [--optional-build]\n       dsh-rsi-setup --prepare-authorities --profile <name> [--dsh-home <absolute>]\n       dsh-rsi-setup --install-owner --profile <name> [--dsh-home <absolute>] [--source-repository <local-absolute>]\n       dsh-rsi-setup --install-local-cohort --profile <name> --source-repository <local-absolute> --bundle <slug> [--bundle <slug> ...] [--dsh-home <absolute>]\nDefault: validate installed profiles and finite authority configuration without changing profiles.\nSource preparation creates a private checkout and release repository for the installed version. Build preparation also prepares private authority tools, signing identities and local release storage on Linux, creates an offline image and exports a pinned native release toolchain/store/cache; --optional-build reports which build prerequisites are unavailable. Authority preparation alone needs neither Docker nor a source checkout and does not issue grants or start Hosts.\n')
    return
  }
  if (args.installLocalCohort) {
    const controller = new AbortController()
    const cancel = () => controller.abort(new Error('local cohort installation interrupted'))
    process.once('SIGINT',cancel); process.once('SIGTERM',cancel)
    try {
      const {installRsiLocalTarget} = await import('./rsi-local-install.js')
      process.stdout.write(`${JSON.stringify(await installRsiLocalTarget({dshHome:args.dshHome,profile:args.profile!,
        sourceRepository:args.sourceRepository!,bundles:args.bundles!,signal:controller.signal}))}\n`)
    } finally { process.off('SIGINT',cancel); process.off('SIGTERM',cancel) }
    return
  }
  if (args.installOwner) {
    if (process.platform !== 'linux') {
      process.stdout.write(`${JSON.stringify({ mode: 'not-ready', reason: 'automatic dual Host installation requires Linux systemd user services' })}\n`)
      process.exitCode = 3
      return
    }
    const controller = new AbortController()
    const cancel = () => controller.abort(new Error('owner installation interrupted'))
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
    try {
      const { installRsiOwnerDeployment } = await import('./rsi-install.js')
      const result = await installRsiOwnerDeployment({ dshHome: args.dshHome, profile: args.profile!,
        sourceRepository: args.sourceRepository, signal: controller.signal })
      process.stdout.write(`${JSON.stringify(result)}\n`)
      process.stderr.write(result.mode === 'ready' ? '自迭代双 Host 已启动并通过就绪检查。\n'
        : `普通 supervised 安装已保留；自迭代双 Host 未就绪：${result.reason}。\n`)
      if (result.mode === 'not-ready') process.exitCode = 3
    } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel) }
    return
  }
  if (args.prepareSource || args.prepareBuild || args.prepareAuthorities) {
    await safeDirectory(args.dshHome)
    const controller = new AbortController()
    const cancel = () => controller.abort(new Error('resource preparation interrupted'))
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
    try {
      const prepared = await withDshHomeLifecycleLock(args.dshHome, async () => {
        const authorities = async () => ({
          authorityRuntime: await prepareRsiAuthorityRuntime({ dshHome: args.dshHome, profile: args.profile!, signal: controller.signal }),
          authorityResources: await prepareRsiAuthorityResources({ dshHome: args.dshHome, profile: args.profile!, signal: controller.signal }),
        })
        if (args.prepareAuthorities) return authorities()
        const source = await prepareRsiSourceWorkspace({
          dshHome: args.dshHome, profile: args.profile!, version, sourceRepository: args.sourceRepository, signal: controller.signal,
        })
        if (!args.prepareBuild) return source
        const provisioned = { ...source, ...(process.platform === 'linux' ? await authorities()
          : { authorityResourcesUnavailable: 'private authority runtime currently requires Linux' }) }
        try {
          const build = await prepareRsiBuildEnvironment({ dshHome: args.dshHome, profile: args.profile!, source,
            dockerPath: args.dockerPath, signal: controller.signal })
          try {
            const release = await prepareRsiReleaseBuildEnvironment({ dshHome: args.dshHome, profile: args.profile!,
              build, signal: controller.signal })
            return { ...provisioned, sourceBuild: build.sourceBuild, releaseBuild: release.releaseBuild }
          } catch (error) {
            controller.signal.throwIfAborted()
            if (!args.optionalBuild || !(error instanceof RsiReleaseBuildUnavailableError)) throw error
            process.stderr.write(`自迭代发布构建环境未就绪：${error.message}。已保留源码与验证镜像。\n`)
            return { ...provisioned, sourceBuild: build.sourceBuild, releaseBuildUnavailable: error.message }
          }
        } catch (error) {
          controller.signal.throwIfAborted()
          if (!args.optionalBuild || !(error instanceof RsiBuildUnavailableError)) throw error
          process.stderr.write(`自迭代构建环境未就绪：${error.message}。已保留源码准备结果。\n`)
          return { ...provisioned, buildUnavailable: error.message }
        }
      })
      process.stdout.write(`${JSON.stringify(prepared)}\n`)
    } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel) }
    return
  }
  // 平台门控只属于 CLI 外壳：事务逻辑经注入的 ports 隔离 systemctl/服务安装，
  // 单测须能在任意平台跑；真实 systemd 用户服务只在 Linux 可用。
  if (process.platform !== 'linux') fail('dual Host setup currently requires Linux systemd user services')
  process.stdout.write(`${JSON.stringify(await configureRsiSetup(args))}\n`)
}
