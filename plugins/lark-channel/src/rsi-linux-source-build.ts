import { join, isAbsolute, resolve } from 'node:path'
import { controlPlaneDigest, validateSourceBuildConfig,
  type Config as ControlPlaneConfig, type CreationCapabilityOwner } from '@dsh-enhanced/plugin-control-plane'
import type { RsiAuthorityResources } from './rsi-authority-resources.js'
import type { LinuxV1CgroupRoots } from './rsi-linux-cgroup-roots.js'
import type { LinuxRsiRepositoryBuildEnvironment } from './rsi-linux-repository-bootstrap.js'
import type { RsiSourceWorkspace } from './rsi-source.js'
import type { LinuxRunnerStateSeal } from '@dsh-enhanced/assistant-isolation'

/** Prepared bytes and kernel roots, before any owner execution grant exists. */
export interface RsiLinuxSourceBuildPreparation {
  backend: 'linux-native'
  repository: LinuxRsiRepositoryBuildEnvironment
  cgroupRoots: LinuxV1CgroupRoots
}

type LinuxSourceBuild = Extract<NonNullable<ControlPlaneConfig['sourceBuild']>, { backend: 'linux-native' }>
const sha = /^[a-f0-9]{64}$/u
const canonical = (value: string): boolean => typeof value === 'string' && isAbsolute(value)
  && resolve(value) === value && !/[\p{Cc}\\]/u.test(value)
function fail(message: string): never { throw new Error(`rsi Linux source build: ${message}`) }

/** Compile a finite repository grant only after the owner and original expiry
 * have been fixed. This does not prepare resources, issue authority or reset a ledger. */
export function compileRsiLinuxSourceBuild(input: {
  prepared: RsiLinuxSourceBuildPreparation
  resources: RsiAuthorityResources
  source: RsiSourceWorkspace
  owner: CreationCapabilityOwner
  now: number
  expiresAt: number
  stateSeal: LinuxRunnerStateSeal
}): LinuxSourceBuild {
  const { prepared, resources, source, owner, now, expiresAt } = input
  const repository = prepared.repository
  if (prepared.backend !== 'linux-native' || repository.schemaVersion !== 4 || repository.backend !== 'linux-native'
    || resources.schemaVersion !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(resources.installationId)
    || !canonical(resources.stateRoot) || resources.stateRoot !== join(resources.root, 'state')
    || source.schemaVersion !== 1 || !/^[a-f0-9]{40}$/u.test(source.sourceCommit)
    || repository.sourceCommit !== source.sourceCommit || repository.runtime.sourceCommit !== source.sourceCommit
    || !sha.test(repository.lockSha256) || repository.runtime.lockSha256 !== repository.lockSha256
    || !Number.isSafeInteger(now) || now < 1 || !Number.isSafeInteger(expiresAt) || expiresAt <= now
    || !canonical(owner.workspace) || !sha.test(owner.authorityHash)
    || !Number.isSafeInteger(owner.principalVersion) || owner.principalVersion < 1
    || [owner.authorityId, owner.principalId, owner.principalRecordId, owner.agentPreset]
      .some(value => typeof value !== 'string' || value.length < 1 || value.length > 256)) fail('prepared owner or repository differs')
  const body = {
    backend: 'linux-native' as const, runtime: repository.runtime,
    userNamespace: repository.userNamespace, systemSnapshot: repository.systemSnapshot,
    cgroupRoots: prepared.cgroupRoots, stateRoot: join(resources.stateRoot, 'linux-source-build-runner'),
    stateSeal: input.stateSeal,
    expiresAt, maxRuns: 48, maxTotalDurationMs: 86_400_000,
    timeoutMs: 1_800_000, outputBytes: 65_536, versioning: 'patch' as const,
    memoryMiB: 16_384, cpus: 8, pidsLimit: 1_024,
    workspaceMiB: 8_192, temporaryMiB: 4_096, workspaceInodes: 1_000_000, temporaryInodes: 1_000_000,
  }
  const config: LinuxSourceBuild = { ...structuredClone(body), authorityDigest: controlPlaneDigest({
    protocol: 'dsh-rsi-linux-source-build-grant/v1', installationId: resources.installationId,
    owner, source, limitsAndRuntime: body,
  }) }
  // Validate this component here. The complete Control Plane is validated after
  // its durable sourceJobs and independent authorities have been composed.
  validateSourceBuildConfig(config)
  return config
}
