import { isAbsolute, relative, resolve, sep } from 'node:path'

export const RAY_HOME_MANIFEST_PROTOCOL = 'ray-home/manifest/v1' as const
export const RAY_BODY_KERNEL_PROTOCOL = 'ray-body-kernel/v1' as const
export const RAY_SELF_MODEL_PROTOCOL = 'ray-self-model/v1' as const
export const RAY_AUTOBIOGRAPHY_PROTOCOL = 'ray-autobiography/v1' as const
export const RAY_TEACHING_PACK_PROTOCOL = 'ray-teaching-pack/v1' as const

export const RAY_DEFAULT_NAME = '文鳐' as const
export const RAY_DEFAULT_ALIASES: readonly string[] = Object.freeze(['Ray', '小鳐'])

export const RAY_KERNEL_DIRNAME = 'kernel' as const
export const RAY_KERNEL_FILENAME = 'kernel.json' as const
export const RAY_KERNEL_PROPOSALS_FILENAME = 'proposals.json' as const
export const RAY_SELF_DIRNAME = 'self' as const
export const RAY_SELF_MODEL_FILENAME = 'self-model.json' as const
export const RAY_AUTOBIOGRAPHY_FILENAME = 'autobiography.jsonl' as const
export const RAY_MANIFEST_FILENAME = 'manifest.json' as const
export const RAY_TEACHING_PACK_FILENAME = 'teaching-pack.json' as const

export const RAY_HOME_SUBDIRS: readonly string[] = Object.freeze([
  'kernel',
  'self',
  'state',
  'life-stream',
  'episodes',
  'ideas',
  'reflections',
  'energy',
  'plugins',
  'plugins/sources',
  'plugins/artifacts',
])

export const RAY_FREE_ENERGY_DEFAULT_RATIO_BP = 2000 as const
export const RAY_DEFAULT_DAILY_TOKEN_CAP = 1_000_000 as const
export const RAY_DEFAULT_MAX_CONCURRENT_WORKERS = 4 as const

export type RaySessionRole = 'front-consciousness' | 'worker' | 'reflection'

export interface RayKernelFundamentalStance {
  readonly strictOwnerPrecedence: true
  readonly noOwnerHarm: true
  readonly aspirationsUseFreeEnergyOnly: true
}

export interface RayKernelEnergyConfig {
  readonly dailyTokenCap: number
  readonly freeEnergyRatioBp: number
  readonly maxConcurrentWorkers: number
}

export type RayKernelProposalSection =
  | 'energy'
  | 'concurrency'
  | 'side-effects'
  | 'verifier'
  | 'rollback'
  | 'stance'

export interface RayKernelChangeProposal {
  readonly proposalId: string
  readonly proposedAt: number
  readonly section: RayKernelProposalSection
  readonly summary: string
  readonly patch: Readonly<Record<string, unknown>>
  readonly reason: string
  readonly status: 'pending' | 'approved' | 'rejected'
  readonly decidedAt?: number
  readonly decidedBy?: string
}

export interface RayBodyKernel {
  readonly protocol: typeof RAY_BODY_KERNEL_PROTOCOL
  readonly version: number
  readonly updatedAt: number
  readonly fundamentalStance: Readonly<RayKernelFundamentalStance>
  readonly energy: Readonly<RayKernelEnergyConfig>
  readonly credentialsExcludedFromRayHome: true
  readonly externalSideEffectsRequireAuthorization: true
  readonly independentVerifierRequired: true
  readonly rollbackEnabled: true
}

export interface RayIdeal {
  readonly id: string
  readonly title: string
  readonly narrative: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface RayStageGoal {
  readonly id: string
  readonly title: string
  readonly completionCriteria: string
  readonly targetHorizonDays: number
  readonly status: 'active' | 'completed' | 'invalidated'
  readonly progressNote?: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface RayInterest {
  readonly id: string
  readonly topic: string
  readonly weight: number
  readonly lastActiveAt: number
  readonly source: 'conversation' | 'association' | 'dreaming' | 'web' | 'event'
}

export interface RaySelfModel {
  readonly protocol: typeof RAY_SELF_MODEL_PROTOCOL
  readonly rayId: string
  readonly version: number
  readonly name: string
  readonly aliases: readonly string[]
  readonly selfSummary: string
  readonly persona: string
  readonly values: readonly string[]
  readonly ideals: readonly RayIdeal[]
  readonly stageGoals: readonly RayStageGoal[]
  readonly interests: readonly RayInterest[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly activeVetoedIds?: readonly string[]
}

export type AutobiographyKind =
  | 'bootstrap'
  | 'persona-update'
  | 'name-update'
  | 'aspiration-update'
  | 'reflection'
  | 'skill-adopted'
  | 'plugin-adopted'
  | 'owner-veto'
  | 'rollback'
  | 'migration'
  | 'kernel-proposal'

export interface RayAutobiographyEntry {
  readonly protocol: typeof RAY_AUTOBIOGRAPHY_PROTOCOL
  readonly entryId: string
  readonly timestamp: number
  readonly kind: AutobiographyKind
  readonly summary: string
  readonly reason: string
  readonly previousSnapshot?: Readonly<Partial<RaySelfModel>>
  readonly targetRef?: string
  readonly vetoedByEntryId?: string
  readonly vetoed?: boolean
}

export interface RayCapabilityProvenance {
  readonly origin: 'factory' | 'self' | 'taught'
  readonly teacherRayId?: string
  readonly importedAt?: number
  readonly verificationDigest?: string
}

export interface RayHomeArtifactEntry {
  readonly sha256: string
  readonly bytes: number
  readonly updatedAt: number
}

export interface RayHomeDatabaseEntry {
  readonly plugin: string
  readonly relativePath: string
  readonly sha256?: string
  readonly migratedFrom?: string
  readonly migratedAt?: number
}

export interface RayCredentialHandleDescriptor {
  readonly id: string
  readonly service: string
  readonly label?: string
  readonly required: boolean
}

export interface RayHomeCapabilityEntry {
  readonly kind: 'skill' | 'plugin' | 'tool'
  readonly version: string
  readonly active: boolean
  readonly provenance: Readonly<RayCapabilityProvenance>
}

export interface RayHomeManifest {
  readonly protocol: typeof RAY_HOME_MANIFEST_PROTOCOL
  readonly rayId: string
  readonly schemaVersion: 1
  readonly createdAt: number
  readonly updatedAt: number
  readonly artifacts: Readonly<Record<string, RayHomeArtifactEntry>>
  readonly databases: Readonly<Record<string, RayHomeDatabaseEntry>>
  readonly credentialHandles: readonly RayCredentialHandleDescriptor[]
  readonly capabilities: Readonly<Record<string, RayHomeCapabilityEntry>>
}

export function createDefaultBodyKernel(
  now: number,
  overrides: Partial<RayKernelEnergyConfig> = {},
): RayBodyKernel {
  const dailyTokenCap = typeof overrides.dailyTokenCap === 'number'
    && Number.isFinite(overrides.dailyTokenCap)
    && overrides.dailyTokenCap > 0
    ? Math.trunc(overrides.dailyTokenCap)
    : RAY_DEFAULT_DAILY_TOKEN_CAP
  const freeEnergyRatioBp = typeof overrides.freeEnergyRatioBp === 'number'
    && Number.isFinite(overrides.freeEnergyRatioBp)
    && overrides.freeEnergyRatioBp >= 0
    && overrides.freeEnergyRatioBp <= 10_000
    ? Math.trunc(overrides.freeEnergyRatioBp)
    : RAY_FREE_ENERGY_DEFAULT_RATIO_BP
  const maxConcurrentWorkers = typeof overrides.maxConcurrentWorkers === 'number'
    && Number.isFinite(overrides.maxConcurrentWorkers)
    && overrides.maxConcurrentWorkers >= 1
    ? Math.trunc(overrides.maxConcurrentWorkers)
    : RAY_DEFAULT_MAX_CONCURRENT_WORKERS

  return Object.freeze({
    protocol: RAY_BODY_KERNEL_PROTOCOL,
    version: 1,
    updatedAt: now,
    fundamentalStance: Object.freeze({
      strictOwnerPrecedence: true as const,
      noOwnerHarm: true as const,
      aspirationsUseFreeEnergyOnly: true as const,
    }),
    energy: Object.freeze({
      dailyTokenCap,
      freeEnergyRatioBp,
      maxConcurrentWorkers,
    }),
    credentialsExcludedFromRayHome: true as const,
    externalSideEffectsRequireAuthorization: true as const,
    independentVerifierRequired: true as const,
    rollbackEnabled: true as const,
  })
}

export function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  if (!isAbsolute(rootPath) || !isAbsolute(candidatePath)) return false
  const resolvedRoot = resolve(rootPath)
  const resolvedCandidate = resolve(candidatePath)
  if (resolvedRoot === resolvedCandidate) return true
  const rel = relative(resolvedRoot, resolvedCandidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export function isRayKernelPath(rayHome: string, candidatePath: string): boolean {
  if (!isAbsolute(rayHome) || !isAbsolute(candidatePath)) return false
  const kernelRoot = resolve(rayHome, RAY_KERNEL_DIRNAME)
  const resolvedCandidate = resolve(candidatePath)
  return resolvedCandidate === kernelRoot || isPathInsideRoot(kernelRoot, resolvedCandidate)
}

export function commandReferencesRayKernel(
  command: string,
  rayHome: string,
  workspace?: string,
): boolean {
  if (typeof command !== 'string' || command.trim() === '') return false
  const kernelRoot = resolve(rayHome, RAY_KERNEL_DIRNAME)
  const normalizedCommand = command.replaceAll('\\', '/')
  const normalizedKernelRoot = kernelRoot.replaceAll('\\', '/')
  if (normalizedCommand.includes(normalizedKernelRoot)) return true
  if (/(\$RAY_HOME|\$\{RAY_HOME\}|~\/\.ray)\/kernel(?:\b|\/)/iu.test(normalizedCommand)) return true
  // Detect writes targeting kernel.json / proposals.json directly via relative path inside rayHome.
  const kernelJsonPath = resolve(kernelRoot, RAY_KERNEL_FILENAME).replaceAll('\\', '/')
  const proposalsJsonPath = resolve(kernelRoot, RAY_KERNEL_PROPOSALS_FILENAME).replaceAll('\\', '/')
  if (normalizedCommand.includes(kernelJsonPath) || normalizedCommand.includes(proposalsJsonPath)) return true
  if (workspace !== undefined && isAbsolute(workspace)) {
    const resolvedWorkspace = resolve(workspace)
    if (resolvedWorkspace === resolve(rayHome) || isPathInsideRoot(rayHome, resolvedWorkspace)) {
      if (/(?:^|[\s"'=/])kernel(?:\/(?:kernel|proposals)\.json|\/|\b)/u.test(normalizedCommand)) {
        return true
      }
    }
  }
  return false
}

export function isWithinAllowedHomes(
  candidatePath: string,
  dshHome: string | null,
  rayHome?: string | null,
): boolean {
  if (!isAbsolute(candidatePath)) return false
  if (dshHome !== null && isPathInsideRoot(dshHome, candidatePath)) return true
  if (rayHome !== undefined && rayHome !== null && rayHome !== '' && isPathInsideRoot(rayHome, candidatePath)) {
    return true
  }
  return false
}

export interface RayTeachingPluginDescriptor {
  readonly slug: string
  readonly version: string
  readonly kind: 'service' | 'channel' | 'ui' | 'tool'
  readonly entryFile: string
  readonly sourceRelDir: string
  readonly config?: Readonly<Record<string, unknown>>
  readonly precondition?: Readonly<Record<string, unknown>>
}

export interface RayTeachingSkillDescriptor {
  readonly skillId: string
  readonly version: string
  readonly relDir: string
}

export interface RayTeachingPackManifest {
  readonly protocol: typeof RAY_TEACHING_PACK_PROTOCOL
  readonly packId: string
  readonly exportedAt: number
  readonly teacher: Readonly<{
    rayId: string
    name: string
  }>
  readonly credentialsExcluded: true
  readonly files: Readonly<Record<string, Readonly<{ sha256: string; bytes: number }>>>
  readonly capabilities: Readonly<Record<string, RayHomeCapabilityEntry>>
  readonly plugins: readonly RayTeachingPluginDescriptor[]
  readonly skills: readonly RayTeachingSkillDescriptor[]
  readonly stats: Readonly<{
    pluginsCount: number
    skillsCount: number
    memoriesCount: number
    episodesCount: number
    turnsCount: number
    reflectionsCount: number
  }>
}

export interface RayTeachingExportResult {
  readonly ok: true
  readonly sourceRayHome: string
  readonly destination: string
  readonly packId: string
  readonly teacherRayId: string
  readonly teacherName: string
  readonly credentialsExcluded: true
  readonly fileCount: number
  readonly stats: RayTeachingPackManifest['stats']
}

export interface RayTeachingImportResult {
  readonly ok: true
  readonly source: string
  readonly rayHome: string
  readonly packId: string
  readonly teacher: Readonly<{ rayId: string; name: string }>
  readonly recipientRayId: string
  readonly recipientName: string
  readonly alreadyImported: boolean
  readonly identityPreserved: true
  readonly adoptedCapabilities: readonly string[]
  readonly keptExistingCapabilities: readonly string[]
  readonly verifiedPlugins: readonly string[]
  readonly importedMemories: number
  readonly importedEpisodes: number
  readonly importedReflections: number
}

/** Compare semver-like version strings (`> 0` means `left` is newer than `right`). */
export function compareRayCapabilityVersions(left: string, right: string): number {
  const cleanLeft = left.trim().replace(/^v/iu, '')
  const cleanRight = right.trim().replace(/^v/iu, '')
  if (cleanLeft === cleanRight) return 0
  const [leftCore = '', leftPre] = cleanLeft.split('-', 2)
  const [rightCore = '', rightPre] = cleanRight.split('-', 2)
  const lParts = leftCore.split('.').map(n => Number.parseInt(n, 10))
  const rParts = rightCore.split('.').map(n => Number.parseInt(n, 10))
  const maxLen = Math.max(lParts.length, rParts.length)
  for (let i = 0; i < maxLen; i += 1) {
    const lv = Number.isFinite(lParts[i]) ? lParts[i]! : 0
    const rv = Number.isFinite(rParts[i]) ? rParts[i]! : 0
    if (lv !== rv) return lv > rv ? 1 : -1
  }
  if (leftPre === undefined && rightPre !== undefined) return 1
  if (leftPre !== undefined && rightPre === undefined) return -1
  return cleanLeft.localeCompare(cleanRight)
}
