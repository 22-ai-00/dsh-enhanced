#!/usr/bin/env node

import { chmod, open, readFile, rename } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { installDshResidentService, residentServiceKind, type InstalledResidentService } from './resident.js'
import { isMainEntry } from './setup.js'
import {
  assertEffectiveSupervisedGrowthConfig,
  configureSupervisedGrowthProfilePatch,
  supervisedGrowthDatabasePaths,
  supervisedGrowthBindingQuery,
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
  const existing = records.filter(record => record.status === 'active')
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
  const updatedPatch = configureSupervisedGrowthProfilePatch({
    profilePatch: originalPatch,
    effectiveConfig: effectiveBefore,
    dshHome,
    binding,
  })
  await assertSelectedOwnerBindingCurrent({
    databasePath: databases.deliveryDatabasePath,
    query,
    selected: binding,
  })
  let service: InstalledResidentService | undefined
  await activateSupervisedGrowthPatch({
    patchPath,
    originalPatch,
    updatedPatch,
    validate: () => dumpProfile(args.profile),
    afterCommit: async effectiveConfig => {
      assertEffectiveSupervisedGrowthConfig({ effectiveConfig, dshHome, binding })
      const effectiveDatabases = supervisedGrowthDatabasePaths(effectiveConfig, dshHome)
      if (effectiveDatabases.deliveryDatabasePath !== databases.deliveryDatabasePath
        || effectiveDatabases.automationsDatabasePath !== databases.automationsDatabasePath) {
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
      service = await restartAndVerifySupervisedGrowthResident({ dshHome, profile: args.profile })
    },
    restore: async () => {
      dumpProfile(args.profile)
      await restartAndVerifySupervisedGrowthResident({ dshHome, profile: args.profile })
    },
  })
  if (service === undefined) throw new Error('supervised-growth setup: resident restart did not return a service')
  process.stdout.write(`supervised-growth 已启用：owner binding ${binding.id}，每日运行次数上限 7；每轮最多 1024 输出 token。\n`
  + `DSH Host 已由 ${service.kind} 重启并通过健康检查。状态：${service.statusCommand}\n日志：${service.logCommand}\n`)
}

if (process.argv[1] !== undefined && isMainEntry(import.meta.url, process.argv[1])) {
  void runSupervisedGrowthSetup().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
