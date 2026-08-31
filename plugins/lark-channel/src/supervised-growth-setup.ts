#!/usr/bin/env node

import { chmod, open, readFile, rename, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { OwnerRouteAuthority } from '@dsh-enhanced/assistant-delivery'
import type {
  RecoveryBootstrapAttestation,
  RecoveryHealth,
} from '@dsh-enhanced/assistant-recovery'
import { isMap, isSeq, parseDocument, type Node, type YAMLMap } from 'yaml'
import { installDshResidentService, residentServiceKind, type InstalledResidentService } from './resident.js'
import { isMainEntry } from './setup.js'
import {
  assertEffectiveSupervisedGrowthConfig,
  configureSupervisedGrowthProfilePatch,
  supervisedGrowthDatabasePaths,
  supervisedGrowthBindingQuery,
  supervisedGrowthAnalystRuntimeConfig,
  supervisedGrowthRecoveryRuntimeConfig,
  type SupervisedGrowthActivationState,
  type SupervisedGrowthBinding,
} from './supervised-growth-profile.js'

export interface SupervisedGrowthSetupArgs {
  profile: string
  timeoutMs: number
  ackExistingAutomations: boolean
  help: boolean
}

const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

function argumentValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`supervised-growth setup: ${option} requires a value`)
  return value
}

export function parseSupervisedGrowthSetupArgs(argv: readonly string[]): SupervisedGrowthSetupArgs {
  const result: SupervisedGrowthSetupArgs = {
    profile: 'web', timeoutMs: 300_000, ackExistingAutomations: false, help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!
    if (option === '--help' || option === '-h') result.help = true
    else if (option === '--profile') result.profile = argumentValue(argv, index++, option)
    else if (option === '--timeout-ms') result.timeoutMs = Number(argumentValue(argv, index++, option))
    else if (option === '--ack-existing-automations') result.ackExistingAutomations = true
    else throw new Error(`supervised-growth setup: unknown option: ${option}`)
  }
  if (!keyPattern.test(result.profile)) throw new Error('supervised-growth setup: invalid profile')
  if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 30_000 || result.timeoutMs > 900_000) {
    throw new Error('supervised-growth setup: timeout-ms must be an integer from 30000 to 900000')
  }
  return result
}

export interface AutomationGuardRecord { id: string; owner?: string; status: string; definition?: unknown }

export function assertSupervisedGrowthAutomationGuard(
  records: readonly AutomationGuardRecord[],
  acknowledged: boolean,
): void {
  // Enabling the scheduler would start every durable active row.  A legacy
  // heartbeat is not intrinsically safe: it may carry broad tools or a
  // different route.  Keep the guard stricter than necessary until an exact
  // managed-definition hash can prove a pre-existing row is this overlay.
  // The exact legacy managed job is migrated with scheduler=false, its execute
  // grant removed, and its Heartbeat profile reconciled to paused before the
  // active scheduler is restored. Other durable active rows remain an explicit
  // operator decision.
  const existing = records.filter(record => record.status === 'active'
    && !(record.id === 'heartbeat:supervised-growth' && record.owner === 'assistant-heartbeat')
    && !(record.id === 'heartbeat:supervised-growth-analyst' && record.owner === 'assistant-heartbeat')
    && !(record.id === 'recovery:supervised-growth'
      && record.owner === 'dsh-enhanced-assistant-recovery'))
  if (existing.length > 0 && !acknowledged) {
    throw new Error('supervised-growth setup: active automations already exist; rerun with --ack-existing-automations to leave them untouched')
  }
}

export function selectUniqueOwnerBinding<T extends SupervisedGrowthBinding>(bindings: readonly T[]): T {
  if (bindings.length === 0) {
    throw new Error('supervised-growth setup: no matching owner DM binding; send the bot a new direct message, then retry')
  }
  if (bindings.length > 1) {
    throw new Error('supervised-growth setup: multiple matching owner DM bindings found; revoke stale bindings before enabling growth')
  }
  return bindings[0]!
}

/** Compare the complete durable route snapshot, including its optimistic version. */
export function sameSupervisedGrowthBinding(
  left: SupervisedGrowthBinding,
  right: SupervisedGrowthBinding,
): boolean {
  return left.id === right.id
    && left.conversation.channel === right.conversation.channel
    && left.conversation.account === right.conversation.account
    && left.conversation.tenant === right.conversation.tenant
    && left.conversation.kind === right.conversation.kind
    && left.conversation.chat === right.conversation.chat
    && left.conversation.thread === right.conversation.thread
    && left.principal.channel === right.principal.channel
    && left.principal.account === right.principal.account
    && left.principal.tenant === right.principal.tenant
    && left.principal.user === right.principal.user
    && left.workspace === right.workspace
    && left.agentPreset === right.agentPreset
    && left.sessionId === right.sessionId
    && left.generation === right.generation
    && left.policyRef === right.policyRef
    && left.status === right.status
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
    && left.version === right.version
}

function help(): string {
  return [
    'Usage: dsh-supervised-growth-setup [options]',
    '',
    'Activates the bounded supervised-growth overlay only after one exact owner Lark DM binding is present.',
    '  --profile <name>                  DSH profile (default: web)',
    '  --timeout-ms <30000..900000>      bounded wait for the owner DM (default: 300000)',
    '  --ack-existing-automations        acknowledge active jobs may run when the scheduler is enabled',
  ].join('\n')
}

async function atomicWrite(path: string, value: string): Promise<void> {
  const temporary = join(dirname(path), `.cordis.patch.yml.supervised-growth-${process.pid}`)
  const file = await open(temporary, 'w', 0o600)
  try {
    await file.writeFile(value, 'utf8')
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temporary, path)
  await chmod(path, 0o600)
}

function dumpProfile(profile: string): string {
  const result = spawnSync('dsh', ['--profile', profile, '--dump-config'], {
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim().slice(0, 2_000) : ''
    throw new Error(`supervised-growth setup: DSH rejected the updated profile${detail === '' ? '' : `: ${detail}`}`)
  }
  return typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? '')
}

export async function commitSupervisedGrowthPatch<T>(input: {
  patchPath: string
  originalPatch: string
  updatedPatch: string
  validate: () => T
}): Promise<T> {
  await atomicWrite(input.patchPath, input.updatedPatch)
  try {
    return input.validate()
  } catch (error) {
    await atomicWrite(input.patchPath, input.originalPatch)
    throw error
  }
}

/**
 * Keep the post-write activation sequence transactional from the operator's
 * point of view: a failed readiness, binding re-read, restart, or health check
 * rewrites the original profile and asks the host to restore its old resident
 * service before reporting failure.
 */
export async function activateSupervisedGrowthPatch<T>(input: {
  patchPath: string
  originalPatch: string
  updatedPatch: string
  validate: () => T
  afterCommit: (effectiveConfig: T) => Promise<void>
  restore: () => Promise<void>
}): Promise<T> {
  const effectiveConfig = await commitSupervisedGrowthPatch(input)
  try {
    await input.afterCommit(effectiveConfig)
    return effectiveConfig
  } catch (error) {
    await atomicWrite(input.patchPath, input.originalPatch)
    try {
      await input.restore()
    } catch (rollbackError) {
      throw new Error(
        `supervised-growth setup: activation failed and rollback service restore also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause: error },
      )
    }
    throw error
  }
}

/**
 * Transactional two-restart activation. Preview and production deliberately
 * share one nonce and catalog digest, but production is not even written until
 * the caller has attested the restarted preview bootstrap. Any failure restores
 * the exact original patch bytes and restarts that original profile.
 */
export async function activateSupervisedGrowthRecoveryStages<T>(input: {
  patchPath: string
  originalPatch: string
  previewPatch: string
  validate: (stage: SupervisedGrowthActivationState) => T
  buildActivePatch: (previewEffective: T) => string
  afterStage: (stage: SupervisedGrowthActivationState, effectiveConfig: T) => Promise<void>
  restore: () => Promise<void>
}): Promise<T> {
  try {
    await atomicWrite(input.patchPath, input.previewPatch)
    const previewEffective = input.validate('preview')
    await input.afterStage('preview', previewEffective)

    const activePatch = input.buildActivePatch(previewEffective)
    await atomicWrite(input.patchPath, activePatch)
    const activeEffective = input.validate('active')
    await input.afterStage('active', activeEffective)
    return activeEffective
  } catch (error) {
    await atomicWrite(input.patchPath, input.originalPatch)
    try {
      await input.restore()
    } catch (rollbackError) {
      throw new Error(
        `supervised-growth setup: activation failed and rollback service restore also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause: error },
      )
    }
    throw error
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

export interface ResidentHealthCommandResult {
  status: number | null
  stdout: string
  stderr: string
}

export interface SupervisedGrowthResidentHealthDependencies {
  run?: (command: string, args: readonly string[]) => ResidentHealthCommandResult
  wait?: (milliseconds: number) => Promise<void>
  attempts?: number
  retryDelayMs?: number
}

function residentHealthCommand(command: string, args: readonly string[]): ResidentHealthCommandResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8', maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? ''),
    stderr: typeof result.stderr === 'string' ? result.stderr : String(result.stderr ?? ''),
  }
}

function residentHealthy(service: InstalledResidentService, run: NonNullable<SupervisedGrowthResidentHealthDependencies['run']>): boolean {
  if (service.kind === 'systemd') {
    return run('/usr/bin/systemctl', ['--user', 'is-active', '--quiet', service.target]).status === 0
  }
  if (service.kind === 'launchd') {
    const result = run('/bin/launchctl', ['print', service.target])
    return result.status === 0 && /(?:^|\n)\s*state = running\s*(?:\n|$)/u.test(result.stdout)
  }
  // schtasks' status text is localized and its successful Query does not prove
  // the task process is alive.  Do not report an unverifiable Windows task as
  // a healthy unattended supervisor.
  throw new Error('supervised-growth setup: Windows does not provide a verifiable resident health gate for this activation')
}

/** Bounded post-restart health check; registration alone is not sufficient. */
export async function verifySupervisedGrowthResidentService(
  service: InstalledResidentService,
  dependencies: SupervisedGrowthResidentHealthDependencies = {},
): Promise<void> {
  const run = dependencies.run ?? residentHealthCommand
  const wait = dependencies.wait ?? delay
  const attempts = dependencies.attempts ?? 3
  const retryDelayMs = dependencies.retryDelayMs ?? 250
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5
    || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 5_000) {
    throw new Error('supervised-growth setup: invalid resident health check bounds')
  }
  let lastFailure: unknown
  for (let index = 0; index < attempts; index += 1) {
    try {
      if (residentHealthy(service, run)) return
      lastFailure = new Error('resident service did not report a running state')
    } catch (error) {
      lastFailure = error
    }
    if (index + 1 < attempts) await wait(retryDelayMs)
  }
  throw new Error(
    `supervised-growth setup: resident service is not healthy after restart${lastFailure instanceof Error ? `: ${lastFailure.message}` : ''}`,
  )
}

export async function restartAndVerifySupervisedGrowthResident(input: {
  dshHome: string
  profile: string
  install?: (input: { dshHome: string; profile: string }) => Promise<InstalledResidentService>
  verify?: (service: InstalledResidentService) => Promise<void>
}): Promise<InstalledResidentService> {
  const service = await (input.install ?? installDshResidentService)({ dshHome: input.dshHome, profile: input.profile })
  await (input.verify ?? verifySupervisedGrowthResidentService)(service)
  return service
}

interface AutomationSnapshot extends AutomationGuardRecord {
  owner?: string
  definition?: unknown
}

export interface SupervisedGrowthRecoveryBootstrapExpectation {
  attestations: readonly RecoveryBootstrapAttestation[]
  attestationSetDigest: string
}

export interface SupervisedGrowthRecoveryStageDependencies {
  inspectRecovery?: (databasePath: string) => Promise<RecoveryHealth>
  /** Complete inventory, including paused managed rows. */
  listAutomations?: (databasePath: string) => Promise<readonly AutomationSnapshot[]>
  /** @deprecated compatibility test seam; active rows alone cannot prove preview pause. */
  listActiveAutomations?: (databasePath: string) => Promise<readonly AutomationSnapshot[]>
  expectedProductionDefinition?: (effectiveConfig: string, recoveryDatabasePath: string) => Promise<unknown>
  expectedAnalystDefinition?: (effectiveConfig: string) => Promise<unknown>
  expectedBootstrap?: (
    effectiveConfig: string,
    recoveryDatabasePath: string,
  ) => Promise<SupervisedGrowthRecoveryBootstrapExpectation>
  wait?: (milliseconds: number) => Promise<void>
  retryDelayMs?: number
}

async function inspectRecoveryBootstrap(databasePath: string): Promise<RecoveryHealth> {
  const { RecoveryStore } = await import('@dsh-enhanced/assistant-recovery')
  const store = new RecoveryStore({ path: databasePath })
  try {
    return store.health()
  } finally {
    store.close()
  }
}

async function recoveryBootstrapGenerationBeforeRestart(databasePath: string): Promise<number> {
  try {
    await stat(databasePath)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: unknown }).code === 'ENOENT') return 0
    throw error
  }
  const generation = (await inspectRecoveryBootstrap(databasePath)).bootstrapGeneration
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('supervised-growth setup: persisted Recovery bootstrap generation is invalid before restart')
  }
  return generation
}

async function automationSnapshots(databasePath: string): Promise<readonly AutomationSnapshot[]> {
  const { listAutomationsLocally } = await import('@dsh-enhanced/assistant-automations')
  return listAutomationsLocally(databasePath)
}

function effectiveOwnerRoutes(effectiveConfig: string): readonly Record<string, unknown>[] {
  const document = parseDocument(effectiveConfig, { uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new Error(`supervised-growth setup: invalid effective profile YAML: ${document.errors[0]!.message}`)
  }
  if (!isSeq(document.contents)) {
    throw new Error('supervised-growth setup: effective profile must be a YAML sequence')
  }
  const rows = document.contents.items.filter(item => isMap(item)
    && (item.get('id') as unknown) === 'dsh-enhanced-assistant-delivery') as YAMLMap[]
  if (rows.length !== 1 || rows[0]!.get('disabled') === true) {
    throw new Error('supervised-growth setup: effective assistant-delivery row must be uniquely enabled')
  }
  const configNode = rows[0]!.get('config', true) as Node | undefined
  if (!isMap(configNode)) {
    throw new Error('supervised-growth setup: effective assistant-delivery config must be a YAML mapping')
  }
  const routesNode = configNode.get('ownerRoutes', true) as Node | undefined
  if (routesNode === undefined) return Object.freeze([])
  if (!isSeq(routesNode)) {
    throw new Error('supervised-growth setup: effective assistant-delivery.ownerRoutes must be a YAML sequence')
  }
  return Object.freeze(routesNode.items.map((item, index) => {
    if (!isMap(item)) {
      throw new Error(`supervised-growth setup: effective ownerRoutes[${index}] must be a YAML mapping`)
    }
    const value = item.toJSON()
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`supervised-growth setup: effective ownerRoutes[${index}] must be a YAML mapping`)
    }
    return value as Record<string, unknown>
  }))
}

/**
 * Rebuild Recovery's complete content-free bootstrap proof from the final DSH
 * config. The same Delivery authority hash and Recovery activation-plan digest
 * algorithms used by the live service are deliberately reused here.
 */
export async function expectedSupervisedGrowthRecoveryBootstrap(
  effectiveConfig: string,
  recoveryDatabasePath: string,
): Promise<SupervisedGrowthRecoveryBootstrapExpectation> {
  const [delivery, recovery] = await Promise.all([
    import('@dsh-enhanced/assistant-delivery'),
    import('@dsh-enhanced/assistant-recovery'),
  ])
  const normalized = recovery.normalizeRecoveryConfig({
    ...supervisedGrowthRecoveryRuntimeConfig(effectiveConfig),
    databasePath: recoveryDatabasePath,
  } as never)
  const authorityHash = (delivery as unknown as {
    ownerRouteAuthorityHash: (input: OwnerRouteAuthority) => string
  }).ownerRouteAuthorityHash
  const authorities = new Map<string, string>()
  for (const raw of effectiveOwnerRoutes(effectiveConfig)) {
    const rawId = raw.id
    if (typeof rawId !== 'string') {
      throw new Error('supervised-growth setup: effective owner route id is invalid')
    }
    const id = rawId.normalize('NFC').trim()
    const authority = raw as unknown as OwnerRouteAuthority
    const digest = authorityHash(authority)
    if (authorities.has(id)) {
      throw new Error(`supervised-growth setup: effective owner route ${id} is duplicated`)
    }
    authorities.set(id, digest)
  }
  const attestations = recovery.canonicalRecoveryBootstrapAttestationSet(normalized.jobs.map(job => {
    const route = authorities.get(job.ownerRouteId)
    if (route === undefined) {
      throw new Error(`supervised-growth setup: Recovery job ${job.id} has no effective owner route`)
    }
    return Object.freeze({
      automationId: recovery.recoveryAutomationId(job.id),
      activationState: job.activationState,
      activationNonce: job.activationNonce,
      activationPlanDigest: recovery.recoveryActivationPlanDigest(
        job,
        normalized.maxStepDurationMs,
        route,
      ),
    })
  }))
  return Object.freeze({
    attestations,
    attestationSetDigest: recovery.recoveryBootstrapAttestationSetDigest(attestations),
  })
}

async function expectedRecoveryProductionDefinition(
  effectiveConfig: string,
  recoveryDatabasePath: string,
): Promise<unknown> {
  const recovery = await import('@dsh-enhanced/assistant-recovery')
  const runtimeConfig = supervisedGrowthRecoveryRuntimeConfig(effectiveConfig)
  const normalized = recovery.normalizeRecoveryConfig(
    { ...runtimeConfig, databasePath: recoveryDatabasePath } as never,
  )
  const job = normalized.jobs.find(candidate => candidate.id === 'supervised-growth')
  if (job === undefined) {
    throw new Error('supervised-growth setup: effective Recovery job is missing during runtime attestation')
  }
  return recovery.recoveryAutomationDefinition(job, normalized.maxStepDurationMs, 'production')
}

/**
 * Rebuild the exact analyst definition from final config and its private,
 * managed scratch. Drifted scratch bytes fail activation instead of silently
 * changing what the unattended analyst will do.
 */
async function expectedSupervisedGrowthAnalystDefinition(effectiveConfig: string): Promise<unknown> {
  const heartbeatRuntime = supervisedGrowthAnalystRuntimeConfig(effectiveConfig)
  const heartbeat = await import('@dsh-enhanced/assistant-heartbeat')
  const normalized = heartbeat.normalizeHeartbeatConfig({
    heartbeats: [heartbeatRuntime.heartbeat as never],
    maxScratchBytes: heartbeatRuntime.maxScratchBytes,
  })
  const profile = normalized.heartbeats[0]
  if (profile === undefined || profile.id !== 'supervised-growth-analyst') {
    throw new Error('supervised-growth setup: normalized analyst heartbeat is missing')
  }
  const raw = await readFile(profile.scratchPath, 'utf8')
  const content = raw.normalize('NFC').replace(/\r\n?/gu, '\n').trim()
  if (content !== profile.initialScratch.normalize('NFC').replace(/\r\n?/gu, '\n').trim()) {
    throw new Error('supervised-growth setup: managed analyst scratch drifted from the attested contract')
  }
  if (Buffer.byteLength(content, 'utf8') > heartbeatRuntime.maxScratchBytes) {
    throw new Error('supervised-growth setup: managed analyst scratch exceeds its configured bound')
  }
  const revision = createHash('sha256').update(content, 'utf8').digest('hex')
  return heartbeat.heartbeatDefinition(profile, content, revision)
}

/**
 * Persisted plugin bootstrap, not merely OS process state, is the stage gate.
 * Preview additionally proves both model-free jobs are paused; active proves the
 * exact compiled production definition is the sole active managed replacement.
 */
export async function verifySupervisedGrowthRecoveryStage(input: {
  stage: SupervisedGrowthActivationState
  effectiveConfig: string
  recoveryDatabasePath: string
  automationsDatabasePath: string
  previousBootstrapGeneration: number
  timeoutMs: number
}, dependencies: SupervisedGrowthRecoveryStageDependencies = {}): Promise<number> {
  const inspect = dependencies.inspectRecovery ?? inspectRecoveryBootstrap
  const listAll = dependencies.listAutomations
    ?? dependencies.listActiveAutomations
    ?? automationSnapshots
  const expectedBootstrap = await (dependencies.expectedBootstrap
    ?? expectedSupervisedGrowthRecoveryBootstrap)(
      input.effectiveConfig,
      input.recoveryDatabasePath,
    )
  const expectedDefinition = input.stage === 'active'
    ? await (dependencies.expectedProductionDefinition ?? expectedRecoveryProductionDefinition)(
        input.effectiveConfig,
        input.recoveryDatabasePath,
      )
    : undefined
  const expectedAnalystDefinition = await (
    dependencies.expectedAnalystDefinition ?? expectedSupervisedGrowthAnalystDefinition
  )(input.effectiveConfig)
  const wait = dependencies.wait ?? delay
  const retryDelayMs = dependencies.retryDelayMs ?? 250
  if (!Number.isSafeInteger(input.previousBootstrapGeneration) || input.previousBootstrapGeneration < 0
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 900_000
    || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1 || retryDelayMs > 5_000) {
    throw new Error('supervised-growth setup: invalid Recovery bootstrap verification bounds')
  }
  let remaining = input.timeoutMs
  let highestObservedGeneration = input.previousBootstrapGeneration
  let lastFailure: unknown
  for (;;) {
    try {
      const health = await inspect(input.recoveryDatabasePath)
      const generation = health.bootstrapGeneration
      if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new Error('supervised-growth setup: Recovery bootstrap generation is invalid')
      }
      if (generation < highestObservedGeneration) {
        throw new Error(
          `supervised-growth setup: Recovery bootstrap generation regressed from ${highestObservedGeneration} to ${generation}`,
        )
      }
      highestObservedGeneration = generation
      if (generation > input.previousBootstrapGeneration) {
        if (health.bootstrapStatus === 'failed') {
          throw new Error(
            `supervised-growth setup: Recovery ${input.stage} bootstrap failed${health.bootstrapFailureCode === undefined ? '' : `: ${health.bootstrapFailureCode}`}`,
          )
        }
        if (health.bootstrapStatus === 'succeeded') {
          if (!health.bootstrapAttestationValid) {
            throw new Error(`supervised-growth setup: Recovery ${input.stage} bootstrap attestation is invalid`)
          }
          if (!isDeepStrictEqual(health.bootstrapAttestations, expectedBootstrap.attestations)) {
            throw new Error(`supervised-growth setup: Recovery ${input.stage} exact bootstrap attestation set does not match the effective plan`)
          }
          if (health.bootstrapAttestationSetDigest !== expectedBootstrap.attestationSetDigest) {
            throw new Error(`supervised-growth setup: Recovery ${input.stage} bootstrap attestation set digest does not match the effective plan`)
          }
          const automations = await listAll(input.automationsDatabasePath)
          const stableHealth = await inspect(input.recoveryDatabasePath)
          const stableGeneration = stableHealth.bootstrapGeneration
          if (!Number.isSafeInteger(stableGeneration) || stableGeneration < 0) {
            throw new Error('supervised-growth setup: Recovery bootstrap generation is invalid')
          }
          if (stableGeneration < highestObservedGeneration) {
            throw new Error(
              `supervised-growth setup: Recovery bootstrap generation regressed from ${highestObservedGeneration} to ${stableGeneration}`,
            )
          }
          highestObservedGeneration = stableGeneration
          if (stableGeneration !== generation) {
            lastFailure = new Error('Recovery bootstrap generation changed while attesting Automations')
          } else {
            if (stableHealth.bootstrapStatus !== 'succeeded'
              || !stableHealth.bootstrapAttestationValid
              || stableHealth.bootstrapAttestationSetDigest !== expectedBootstrap.attestationSetDigest
              || !isDeepStrictEqual(stableHealth.bootstrapAttestations, expectedBootstrap.attestations)) {
              throw new Error(
                `supervised-growth setup: Recovery ${input.stage} bootstrap attestation changed while attesting Automations`,
              )
            }
            const legacyActive = automations.find(record => record.id === 'heartbeat:supervised-growth'
              && record.status === 'active')
            const recoveries = automations.filter(record => record.id === 'recovery:supervised-growth'
              && record.status === 'active')
            const analysts = automations.filter(record => record.id === 'heartbeat:supervised-growth-analyst')
            const analyst = analysts.length === 1 ? analysts[0] : undefined
            const expectedAnalystStatus = input.stage === 'active' ? 'active' : 'paused'
            const analystExact = analyst !== undefined
              && analyst.owner === 'assistant-heartbeat'
              && analyst.status === expectedAnalystStatus
              && isDeepStrictEqual(analyst.definition, expectedAnalystDefinition)
            if (!analystExact) {
              throw new Error(
                `supervised-growth setup: ${input.stage} analyst automation does not match its exact attested definition`,
              )
            }
            if (legacyActive === undefined && input.stage === 'preview' && recoveries.length === 0) {
              return generation
            }
            if (legacyActive === undefined && input.stage === 'active' && recoveries.length === 1) {
              const record = recoveries[0]!
              if (record.owner === 'dsh-enhanced-assistant-recovery'
                && isDeepStrictEqual(record.definition, expectedDefinition)) return generation
              throw new Error('supervised-growth setup: active Recovery automation definition does not match the compiled plan')
            }
            lastFailure = new Error(input.stage === 'preview'
              ? 'legacy/recovery/analyst preview automations have not reached their attested paused state'
              : 'exact Recovery and analyst production automations are not active')
          }
        }
      } else if (health.bootstrapStatus === 'succeeded'
        && health.bootstrapAttestationValid
        && health.bootstrapAttestationSetDigest === expectedBootstrap.attestationSetDigest
        && isDeepStrictEqual(health.bootstrapAttestations, expectedBootstrap.attestations)) {
        throw new Error(
          `supervised-growth setup: Recovery ${input.stage} bootstrap reused generation ${generation}`,
        )
      } else {
        lastFailure = new Error(`waiting for a Recovery bootstrap generation newer than ${input.previousBootstrapGeneration}`)
      }
    } catch (error) {
      // A current-generation explicit bootstrap failure or definition mismatch
      // is terminal. Missing/busy DB state and not-yet-reconciled paused rows are
      // retried within the same bounded gate.
      if (error instanceof Error
        && (/Recovery (?:preview|active) bootstrap failed/u.test(error.message)
          || /bootstrap (?:attestation|generation)/u.test(error.message)
          || /bootstrap reused generation/u.test(error.message)
          || /analyst automation/u.test(error.message)
          || /definition does not match/u.test(error.message))) throw error
      lastFailure = error
    }
    if (remaining <= 0) {
      throw new Error(
        `supervised-growth setup: Recovery ${input.stage} bootstrap did not become ready${lastFailure instanceof Error ? `: ${lastFailure.message}` : ''}`,
      )
    }
    const waitFor = Math.min(retryDelayMs, remaining)
    await wait(waitFor)
    remaining -= waitFor
  }
}

async function awaitOwnerBinding(input: {
  databasePath: string
  query: ReturnType<typeof supervisedGrowthBindingQuery>
  timeoutMs: number
}): Promise<SupervisedGrowthBinding> {
  const { findActiveOwnerDmBindingsLocally } = await import('@dsh-enhanced/assistant-delivery')
  const deadline = Date.now() + input.timeoutMs
  let prompted = false
  for (;;) {
    const bindings = findActiveOwnerDmBindingsLocally({ databasePath: input.databasePath, ...input.query })
    if (bindings.length > 1) return selectUniqueOwnerBinding(bindings)
    if (bindings.length === 1) return selectUniqueOwnerBinding(bindings)
    if (!prompted) {
      prompted = true
      process.stdout.write('未找到与当前 profile 精确匹配的 owner 私聊绑定。请 owner 再给机器人发送一条普通私聊；等待期间不会修改配置。\n')
    }
    if (Date.now() >= deadline) {
      throw new Error('supervised-growth setup: timed out waiting for an exact owner DM binding; profile was not changed')
    }
    await delay(Math.min(1_000, Math.max(1, deadline - Date.now())))
  }
}

async function assertSelectedOwnerBindingCurrent(input: {
  databasePath: string
  query: ReturnType<typeof supervisedGrowthBindingQuery>
  selected: SupervisedGrowthBinding
}): Promise<void> {
  const { findActiveOwnerDmBindingsLocally } = await import('@dsh-enhanced/assistant-delivery')
  const current = selectUniqueOwnerBinding(findActiveOwnerDmBindingsLocally({
    databasePath: input.databasePath,
    ...input.query,
  }))
  if (!sameSupervisedGrowthBinding(current, input.selected)) {
    throw new Error('supervised-growth setup: selected owner binding changed before activation; profile was not changed')
  }
}

export async function runSupervisedGrowthSetup(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseSupervisedGrowthSetupArgs(argv)
  if (args.help) {
    process.stdout.write(`${help()}\n`)
    return
  }
  if (residentServiceKind(process.platform) === 'windows-task-best-effort') {
    throw new Error('supervised-growth setup: Windows has no verifiable resident health gate; profile was not changed')
  }
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  if (!isAbsolute(dshHome)) throw new Error('supervised-growth setup: DSH_HOME must be absolute')
  const patchPath = join(dshHome, 'profiles', args.profile, 'cordis.patch.yml')
  const originalPatch = await readFile(patchPath, 'utf8')
  const effectiveBefore = dumpProfile(args.profile)
  const query = supervisedGrowthBindingQuery(effectiveBefore, dshHome)
  const databases = supervisedGrowthDatabasePaths(effectiveBefore, dshHome)
  const binding = await awaitOwnerBinding({
    databasePath: databases.deliveryDatabasePath, query, timeoutMs: args.timeoutMs,
  })
  const { listActiveAutomationsLocally } = await import('@dsh-enhanced/assistant-automations')
  assertSupervisedGrowthAutomationGuard(
    listActiveAutomationsLocally(databases.automationsDatabasePath),
    args.ackExistingAutomations,
  )
  const { RECOVERY_CATALOG_DIGEST } = await import('@dsh-enhanced/assistant-recovery')
  const activationNonce = randomUUID()
  const previewPatch = configureSupervisedGrowthProfilePatch({
    profilePatch: originalPatch,
    effectiveConfig: effectiveBefore,
    dshHome,
    binding,
    activationState: 'preview',
    activationNonce,
    recoveryCatalogDigest: RECOVERY_CATALOG_DIGEST,
  })
  await assertSelectedOwnerBindingCurrent({
    databasePath: databases.deliveryDatabasePath,
    query,
    selected: binding,
  })
  let service: InstalledResidentService | undefined
  let acceptedBootstrapGeneration: number | undefined
  await activateSupervisedGrowthRecoveryStages({
    patchPath,
    originalPatch,
    previewPatch,
    validate: stage => {
      const effectiveConfig = dumpProfile(args.profile)
      assertEffectiveSupervisedGrowthConfig({
        effectiveConfig,
        dshHome,
        binding,
        activationState: stage,
        activationNonce,
        recoveryCatalogDigest: RECOVERY_CATALOG_DIGEST,
      })
      return effectiveConfig
    },
    buildActivePatch: previewEffective => configureSupervisedGrowthProfilePatch({
      profilePatch: previewPatch,
      effectiveConfig: previewEffective,
      dshHome,
      binding,
      activationState: 'active',
      activationNonce,
      recoveryCatalogDigest: RECOVERY_CATALOG_DIGEST,
    }),
    afterStage: async (stage, effectiveConfig) => {
      const effectiveDatabases = supervisedGrowthDatabasePaths(effectiveConfig, dshHome)
      if (effectiveDatabases.deliveryDatabasePath !== databases.deliveryDatabasePath
        || effectiveDatabases.automationsDatabasePath !== databases.automationsDatabasePath
        || effectiveDatabases.recoveryDatabasePath !== databases.recoveryDatabasePath) {
        throw new Error('supervised-growth setup: a higher-priority profile layer changed a guarded local database path')
      }
      // The binding is re-read after the atomic write and again immediately
      // before restart. A rotation/revocation/version change must never become
      // a background delivery grant merely because its old snapshot was valid.
      await assertSelectedOwnerBindingCurrent({
        databasePath: databases.deliveryDatabasePath,
        query,
        selected: binding,
      })
      const previousBootstrapGeneration = acceptedBootstrapGeneration
        ?? await recoveryBootstrapGenerationBeforeRestart(databases.recoveryDatabasePath)
      service = await restartAndVerifySupervisedGrowthResident({ dshHome, profile: args.profile })
      acceptedBootstrapGeneration = await verifySupervisedGrowthRecoveryStage({
        stage,
        effectiveConfig,
        recoveryDatabasePath: databases.recoveryDatabasePath,
        automationsDatabasePath: databases.automationsDatabasePath,
        previousBootstrapGeneration,
        timeoutMs: args.timeoutMs,
      })
    },
    restore: async () => {
      dumpProfile(args.profile)
      await restartAndVerifySupervisedGrowthResident({ dshHome, profile: args.profile })
    },
  })
  if (service === undefined) throw new Error('supervised-growth setup: resident restart did not return a service')
  process.stdout.write(`supervised-growth/v2 Recovery 已启用：owner binding ${binding.id}，Recovery 每日上限 7；独立 adoption analyst 每日上限 1。\n`
  + `DSH Host 已由 ${service.kind} 重启并通过健康检查。状态：${service.statusCommand}\n日志：${service.logCommand}\n`)
}

if (process.argv[1] !== undefined && isMainEntry(import.meta.url, process.argv[1])) {
  void runSupervisedGrowthSetup().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
