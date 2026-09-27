import { createHash, createPublicKey } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { defaultHostAttestationPolicy, type LiveQualificationAuthorityConfig, type PluginControlTrustConfig,
  type SourceAdoptionAuthorityConfig, type SourceApprovalAuthorityConfig, type SourceReleaseAuthorityConfig,
  type SourceReleasePhase, type SystemdHostAuthorityConfig, type TaskObservationAuthorityConfig } from '@dsh-enhanced/plugin-control-plane'

import { rsiAuthorityRoles, type RsiAuthorityResources } from './rsi-authority-resources.js'
import type { Pin, RsiAuthorityRuntime } from './rsi-authority-runtime.js'
import type { RsiSetupManifest } from './rsi-profile.js'
import type { RsiReleaseBuildConfig } from './rsi-release-build.js'
import type { RsiSourceWorkspace } from './rsi-source.js'

const phases = ['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'] as const satisfies readonly SourceReleasePhase[]
const digest = (source: string): string => createHash('sha256').update(source).digest('hex')
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`
function fail(message: string): never { throw new Error(`rsi authority config: ${message}`) }
function path(value: string, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value === '/' || resolve(value) !== value
    || value.includes('\0') || /[\r\n]/u.test(value)) fail(`${label} must be a canonical absolute path`)
  return value
}
function within(root: string, value: string, label: string): string {
  path(root, 'config root'); path(value, label)
  const child = relative(root, value)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) fail(`${label} must be inside the authority config root`)
  return value
}
function finite(value: number, now: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= now) fail(`${label} has expired`)
  return value
}
function positive(value: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail(`${label} is outside its finite limit`)
  return value
}
function checkedPin(value: Pin, label: string): Pin {
  path(value.path, label)
  if (!/^[a-f0-9]{64}$/u.test(value.sha256)) fail(`${label} digest is invalid`)
  return value
}

export interface RsiAuthorityConfigInput {
  manifest: RsiSetupManifest
  resources: RsiAuthorityResources
  runtime: RsiAuthorityRuntime
  source: RsiSourceWorkspace
  releaseBuild: RsiReleaseBuildConfig
  executor: PluginControlTrustConfig['executor']
  systemctl: Pin & { interpreter: Pin | null }
  unitProperties: SystemdHostAuthorityConfig['template']['unitProperties']
  policies: SourceReleaseAuthorityConfig['grant']['policies']
  now: number
}

/** Compile immutable configuration bytes. The caller creates private directories,
 * writes files atomically, opens the Control Plane ledger, and runs the real
 * filesystem and executable validators before any service is enabled. */
export function compileRsiAuthorityConfigs(input: RsiAuthorityConfigInput): {
  files: Record<string, string>; directories: string[]; trust: PluginControlTrustConfig
} {
  const { manifest, resources, runtime, source, releaseBuild, executor, now } = input
  const cp = manifest.controlPlane, reviews = manifest.sourceReviews, env = manifest.serviceEnvironment?.target
  const jobs = cp.sourceJobs, approvals = cp.sourceApprovals, releases = cp.sourceReleases
  const adoption = cp.sourceAdoptions, observations = cp.taskObservations, qualification = cp.liveQualification
  if (manifest.schemaVersion !== 1 || resources.schemaVersion !== 1 || runtime.schemaVersion !== 1 || source.schemaVersion !== 1
    || !Number.isSafeInteger(now) || now < 1 || !jobs || !approvals || !releases || !adoption || !observations || !qualification
    || !cp.runtimeObserver || !cp.foregroundDeployments || !cp.sourceReleaseExecution || !env
    || !adoption.liveQualification || !adoption.handoff || !adoption.hostDeploymentInputs) fail('complete bounded-live deployment input is required')
  const home = path(dirname(dirname(resources.root)), 'DSH_HOME')
  if (resources.root !== join(home, 'rsi-authorities', manifest.targetProfile)
    || resources.configRoot !== join(resources.root, 'config') || resources.stateRoot !== join(resources.root, 'state')
    || runtime.root !== join(home, 'rsi-authority-runtimes', manifest.targetProfile)
    || cp.runtimeObserver.profilePath !== join(home, 'profiles', manifest.targetProfile)
    || adoption.profile !== manifest.targetProfile || observations.profilePath !== cp.runtimeObserver.profilePath
    || qualification.profilePath !== cp.runtimeObserver.profilePath
    || cp.catalogPath !== resources.catalog.path || jobs.repository !== source.repository
    || source.baseline.targetBranch !== 'repairs' || !isDeepStrictEqual(jobs.baseline, source.baseline)
    || reviews.repository !== source.baseline.remote || cp.sourceReleaseExecution.reviewDecisionRoot !== reviews.decisionRoot
    || cp.sourceReleaseExecution.independentReview !== true || cp.sourceBuild?.versioning !== 'patch'
    || reviews.owner.authorityId !== jobs.ownerRouteId || reviews.owner.principalId !== jobs.principalId
    || reviews.owner.workspace !== jobs.workspace || reviews.owner.agentPreset !== jobs.preset
    || !isDeepStrictEqual(reviews.plugins, input.policies.map(policy => policy.candidateId))
    || adoption.liveQualification.authority !== resources.identities.qualification.authority
    || adoption.liveQualification.keyId !== resources.identities.qualification.keyId
    || manifest.serviceEnvironment?.coordinator?.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG !== env.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG) fail('source, profile, owner, or policy binding differs')
  for (const [name, client] of [['approval', approvals], ['release', releases], ['adoption', adoption.authority],
    ['observation', observations.authority], ['qualification', qualification.authority]] as const) {
    if (!isDeepStrictEqual(client.executable, runtime.executables[name])
      || !isDeepStrictEqual(client.interpreter, runtime.node)) fail(`${name} client differs from prepared authority runtime`)
  }
  const ledgerPath = join(path(cp.statePath, 'Control Plane state'), 'control.sqlite')
  const worktreeRoot = join(cp.statePath, 'source-worktrees')
  const root = path(resources.configRoot, 'authority config root')
  const trustPath = within(root, cp.trustPath, 'trust path')
  const resolverPath = join(root, 'host-authority.json')
  const hostWrapperPath = within(root, env.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG!, 'Host wrapper path')
  const approvalPath = within(root, approvals.configPath, 'approval config path')
  const releasePath = within(root, releases.configPath, 'release config path')
  const adoptionPath = within(root, adoption.authority.configPath, 'adoption config path')
  const observationPath = within(root, observations.authority.configPath, 'observation config path')
  const qualificationPath = within(root, qualification.authority.configPath, 'qualification config path')
  const expiry = Math.min(finite(jobs.expiresAt, now, 'source jobs'), finite(reviews.expiresAt, now, 'source reviews'),
    finite(observations.policy.expiresAt, now, 'task observation policy'))
  positive(jobs.maxSubmissions, 10_000, 'source submissions')
  positive(reviews.maxReviews, 10_000, 'source reviews')
  positive(observations.policy.maximumObservations, 1_000, 'task observations')
  if (input.policies.length < 1 || input.policies.length > 32 || new Set(input.policies.map(policy => policy.candidateId)).size !== input.policies.length
    || new Set(reviews.plugins).size !== reviews.plugins.length) fail('source policies must be distinct and finite')
  for (const policy of input.policies) {
    if (policy.targetBranch !== source.baseline.targetBranch || policy.dshBaseline !== executor.version
      || policy.packageName !== `@dsh-enhanced/${policy.candidateId}` || policy.packagePath !== `plugins/${policy.candidateId}`
      || policy.registryId !== resources.registry.id || policy.registryLocator !== resources.registry.locator
      || policy.catalogId !== resources.catalog.id || policy.catalogPath !== resources.catalog.path
      || policy.minimumReproducibleBuilds < 2) fail(`release policy differs from deployment: ${policy.candidateId}`)
  }
  const role = (name: typeof rsiAuthorityRoles[number]) => resources.identities[name]
  const key = (name: typeof rsiAuthorityRoles[number]) => {
    const identity = role(name)
    if (identity.keyPath !== join(resources.root, 'identities', `${name}.pem`)
      || identity.authority !== `${name}-${resources.installationId}` || identity.keyId !== `${identity.authority}-key`) fail(`identity differs: ${name}`)
    try { if (createPublicKey(identity.publicKeyPem).asymmetricKeyType !== 'ed25519') fail(`identity is not Ed25519: ${name}`) }
    catch { fail(`identity is invalid: ${name}`) }
    return { authority: identity.authority, keyId: identity.keyId, publicKeyPem: identity.publicKeyPem }
  }
  if (new Set(rsiAuthorityRoles.map(name => role(name).publicKeyPem)).size !== rsiAuthorityRoles.length) fail('authority keys must be independent')
  const files: Record<string, string> = {}
  const directories = new Set<string>([root, join(root, 'public-keys'), resources.stateRoot, cp.statePath, worktreeRoot,
    reviews.decisionRoot, join(resources.stateRoot, 'reviews'), join(resources.stateRoot, 'release'),
    join(resources.stateRoot, 'host-attestor'), join(resources.stateRoot, 'registry-download')])
  const add = (filename: string, value: unknown) => {
    if (Object.hasOwn(files, filename)) fail(`config paths collide: ${filename}`)
    files[filename] = json(value)
    directories.add(dirname(filename))
  }
  const publicPath = (name: typeof rsiAuthorityRoles[number]) => join(root, 'public-keys', `${name}.pem`)
  for (const name of rsiAuthorityRoles) {
    const filename = publicPath(name)
    if (Object.hasOwn(files, filename)) fail(`public key paths collide: ${name}`)
    files[filename] = role(name).publicKeyPem
  }
  const identity = (name: typeof rsiAuthorityRoles[number]) => ({ authority: role(name).authority, keyId: role(name).keyId,
    publicKeyPath: publicPath(name) })
  const base = (name: typeof rsiAuthorityRoles[number]) => ({ schemaVersion: 1 as const, authority: role(name).authority,
    keyId: role(name).keyId, keyPath: role(name).keyPath, statePath: join(resources.stateRoot, `${name}.json`), controlDatabasePath: ledgerPath })
  const common = { repository: source.repository, worktreeRoot, owner: reviews.owner, plugins: [...reviews.plugins],
    maxChangedFiles: positive(reviews.maxChangedFiles, 256, 'changed files'),
    maxChangedBytes: positive(reviews.maxInputBytes, 16 * 1024 * 1024, 'changed bytes'), receiptTtlMs: 60_000 }
  const approvalConfig: SourceApprovalAuthorityConfig = { ...base('approval'), grant: { id: `approval-${resources.installationId}`,
    expiresAt: expiry, maxApprovals: Math.min(jobs.maxSubmissions, reviews.maxReviews), ...common, versioning: 'patch' } }
  const releaseConfig: SourceReleaseAuthorityConfig = { ...base('release'), grant: { id: `release-${resources.installationId}`,
    expiresAt: expiry, maxReleases: Math.min(jobs.maxSubmissions, reviews.maxReviews), ...common, versioning: 'patch', policies: input.policies } }
  const ledger = { id: resources.ledgerId, path: ledgerPath }
  const profilePath = join(home, 'profiles', manifest.targetProfile)
  const packages = reviews.plugins.map(name => `@dsh-enhanced/${name}`)
  const adoptionPolicies = input.policies.map(({ candidateId, packageName, dshBaseline, capabilities, authorities, requires, registryId, registryLocator }) =>
    ({ candidateId, packageName, dshBaseline, capabilities, authorities, requires, registryId, registryLocator }))
  const adoptionConfig: SourceAdoptionAuthorityConfig = { ...base('adoption'), grant: { id: `adoption-${resources.installationId}`,
    expiresAt: expiry, maxAdoptions: Math.min(jobs.maxSubmissions, reviews.maxReviews), owner: reviews.owner,
    installationId: resources.installationId, ledger, target: { dshHome: home, profile: manifest.targetProfile, profilePath },
    executor: { id: executor.id, version: executor.version, path: executor.path, sha256: executor.sha256 },
    catalogPath: resources.catalog.path, receiptTtlMs: 60_000, handoff: adoption.handoff,
    liveQualification: adoption.liveQualification, hostDeploymentInputs: adoption.hostDeploymentInputs, policies: adoptionPolicies } }
  const observationConfig: TaskObservationAuthorityConfig = { ...base('observation'), grant: { policy: observations.policy,
    owner: reviews.owner, installationId: resources.installationId, ledger, profilePath, packages, receiptTtlMs: 60_000 } }
  const qualificationConfig: LiveQualificationAuthorityConfig = { ...base('qualification'), grant: { id: `qualification-${resources.installationId}`,
    expiresAt: expiry, maxQualifications: Math.min(jobs.maxSubmissions, observations.policy.maximumObservations, 1_000),
    owner: reviews.owner, installationId: resources.installationId, ledger, profilePath, packages,
    terms: adoption.liveQualification, receiptTtlMs: 60_000 } }
  add(approvalPath, approvalConfig); add(releasePath, releaseConfig); add(adoptionPath, adoptionConfig)
  add(observationPath, observationConfig); add(qualificationPath, qualificationConfig)

  const releaseAdapters = {} as NonNullable<PluginControlTrustConfig['releaseAdapters']>
  for (const phase of phases) {
    const envName = `DSH_RELEASE_${phase.toUpperCase().replaceAll('-', '_')}_CONFIG`
    const configPath = within(root, env[envName]!, `${phase} adapter path`)
    const executable = checkedPin(runtime.releaseAdapters[phase], `${phase} adapter`)
    const stateRoot = join(resources.stateRoot, 'release', phase)
    directories.add(stateRoot)
    const adapter = { schemaVersion: 1, id: `release-${phase}-${resources.installationId}`, phase,
      executablePath: executable.path, authority: role(phase).authority, keyId: role(phase).keyId,
      privateKeyPath: role(phase).keyPath, authorizationAuthority: identity('release'), stateRoot,
      git: { executable: checkedPin(reviews.git, 'review Git'), remote: source.baseline.remote,
        targetBranch: source.baseline.targetBranch, authorName: 'DSH self iteration',
        authorEmail: `agent-${resources.installationId}@dsh.invalid`, reviewStore: join(resources.stateRoot, 'reviews'),
        reviewDecisionRoot: reviews.decisionRoot, reviewAuthority: identity('review') },
      build: releaseBuild,
      registry: { ...resources.registry, downloadRoot: join(resources.stateRoot, 'registry-download'), signer: identity('sign') },
      catalog: { ...resources.catalog, helper: checkedPin(runtime.catalogValidator, 'catalog validator'),
        interpreter: checkedPin(runtime.node, 'catalog Node') },
      ...(phase === 'catalog-admission' ? { registryVerifier: identity('registry-verify') } : {}) }
    add(configPath, adapter)
    releaseAdapters[phase] = { id: adapter.id, version: 'dsh-local-release-adapter-1', ...executable,
      interpreter: checkedPin(runtime.node, 'adapter Node'), authority: role(phase).authority, keyId: role(phase).keyId,
      timeoutMs: 300_000, environmentAllowlist: [envName] }
  }

  const hostTemplate: SystemdHostAuthorityConfig['template'] = {
    authority: role('host').authority, keyId: role('host').keyId, privateKeyPath: role('host').keyPath,
    stateRoot: join(resources.stateRoot, 'host-attestor'), executable: checkedPin(runtime.executables.hostAttestor, 'Host attestor'),
    interpreter: checkedPin(runtime.node, 'Host Node'), processHelper: checkedPin(runtime.processHelper, 'process helper'),
    systemctl: { ...checkedPin(input.systemctl, 'systemctl'), interpreter: input.systemctl.interpreter === null ? null
      : checkedPin(input.systemctl.interpreter, 'systemctl interpreter') }, scope: 'user',
    unit: `dsh-profile-${manifest.targetProfile}.service`, unitProperties: input.unitProperties,
    timeoutMs: 20_000, stableWindowMs: 1_000, pollIntervalMs: 100,
    readiness: { client: checkedPin(runtime.observerClient, 'observer client'), observer: cp.runtimeObserver },
    recoveryReadiness: { client: checkedPin(runtime.observerClient, 'recovery observer client'), observer: cp.runtimeObserver },
  }
  const hostConfig: SystemdHostAuthorityConfig = { schemaVersion: 1, statePath: join(resources.stateRoot, 'host-authority.json'),
    controlDatabasePath: ledgerPath, trustPath, grant: { id: `host-${resources.installationId}`, notBefore: now,
      expiresAt: expiry, maximumReloads: Math.min(jobs.maxSubmissions, 1_000), owner: reviews.owner,
      profile: { name: manifest.targetProfile, path: profilePath }, packages,
      coordinatorId: adoption.handoff.coordinatorId, hostDeploymentInputs: adoption.hostDeploymentInputs,
      liveQualification: adoption.liveQualification }, template: hostTemplate }
  const resolverSource = json(hostConfig)
  add(resolverPath, hostConfig)
  add(hostWrapperPath, { schemaVersion: 4, template: hostTemplate,
    resolver: { executable: checkedPin(runtime.executables.hostAuthority, 'Host resolver'),
      interpreter: checkedPin(runtime.node, 'resolver Node'), configPath: resolverPath,
      configSha256: digest(resolverSource), timeoutMs: 10_000 } })

  const trust: PluginControlTrustConfig = { schemaVersion: 4, installationId: resources.installationId, dshHome: home, ledger,
    executor, hostPolicy: defaultHostAttestationPolicy,
    hostAttestor: { id: `host-attestor-${resources.installationId}`, version: 'dsh-systemd-host-attestor-6',
      ...checkedPin(runtime.executables.hostAttestor, 'Host attestor'), interpreter: checkedPin(runtime.node, 'Host Node'),
      environmentAllowlist: ['DSH_SYSTEMD_HOST_ATTESTOR_CONFIG'], authority: role('host').authority, keyId: role('host').keyId,
      timeoutMs: 60_000 }, catalog: resources.catalog,
    releaseRegistry: { id: resources.registry.id, locator: resources.registry.locator, protocol: 'dsh', caPins: [], tokenEnvironment: null },
    releaseReceiptTtlMs: 60_000, releaseAdapters,
    approvalKeys: [key('approval'), key('adoption')], hostAttestationKeys: [key('host'), key('observation'), key('qualification')],
    releaseKeys: phases.map(name => key(name)), releaseAuthorizationKeys: [key('release')] }
  // Local file registries carry no CA or token fields on disk. The trust
  // loader normalizes both to []/null after applying the schema-4 contract.
  add(trustPath, { ...trust, releaseRegistry: { id: resources.registry.id, locator: resources.registry.locator, protocol: 'dsh' } })
  if (new Set(Object.keys(files)).size !== rsiAuthorityRoles.length + 5 + phases.length + 2 + 1) fail('generated config path collision')
  return { files, directories: [...directories].sort(), trust }
}
