import { validateGoalArtifactAdmission, validateTaskAcceptanceContract, type GoalArtifactAdmission, type TaskAcceptanceContract } from '@dsh-ray/task-acceptance-contract'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@dsh-ray/assistant-delivery'
import type {} from '@dsh-ray/assistant-policy'
import { fork, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { lstat, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config, validateConfig } from './config.js'
import { isPrivateDirectoryStats } from './fs-ownership.js'
import { IsolationLedger, IsolationLedgerError, type IsolationControllerAuthority } from './ledger.js'
import { normalizeRequest, stageWorkspace } from './workspace.js'
import { registerIsolationTools } from './tools.js'
import { plannedStorageBytes } from './storage-policy.js'
import { maintainIsolationStorage, observeStorage } from './storage.js'
import type { IsolationBackend, IsolationIdentity, IsolationJob, IsolationRequest, IsolationResult } from './types.js'
import { inspectIsolationGrant } from './diagnostics.js'
import { linuxExecutionContractDigest, linuxJobResourceReservation, validateLinuxExecutionContract, type LinuxExecutionContract } from './linux-execution-contract.js'
import { linuxRuntimeDigest, verifyLinuxRuntime } from './linux-runtime.js'
import { linuxExecutionReceiptBinding, prepareLinuxExecutionIntent, readLinuxExecutionPartialCleanupProof, readLinuxExecutionReceipt, runLinuxExecution } from './linux-execution.js'
import { reconcileLinuxJob } from './linux-job-recovery.js'
import { runMacosSeatbeltCommand, verifyMacosSandboxExec, type MacosSeatbeltAdapter } from './macos-command.js'
import { readNativeReceipt, reconcileNativeReceiptJob, writeNativeReceiptSync } from './native-job-recovery.js'
import { verifyNativeMacRuntime } from './native-runtime.js'
import { runWindowsJobProcess, verifyWindowsJobRunner, type WindowsJobAdapter } from './windows-job.js'

export { Config }
export const isolationPrincipalDigest = (principal: string): string => createHash('sha256').update(principal).digest('hex')
export interface IsolationGrantDiscovery {
  readonly id: string; readonly expiresAt: number; readonly remainingRuns: number; readonly remainingDurationMs: number
  readonly limits: Readonly<{ maxDurationMs: number; maxInputBytes: number; maxOutputBytes: number; maxArtifactBytes: number; maxFiles: number }>
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// Keep prompt visibility and the Host execution guard on the exact same named surface.
const isolatedScopeTools = new Set(['isolation_run', 'isolation_grants', 'goal_context', 'goal_checkpoint'])
const preauthorizedScopedTools = new Set(['skill_run', 'skill_status', 'action_github_grants', 'action_github_deliver', 'action_github_delivery_status', 'action_github_commit', 'action_github_branch', 'action_github_pr', 'action_github_inspect', 'action_github_compensate', 'action_github_compensation_status', 'goal_create', 'goal_schedule', 'goal_strategy', 'goal_wait_event'])
const isolatedPromptTools = new Set([...isolatedScopeTools, ...preauthorizedScopedTools])
const restrictedScopeSection = 'Environment capability constraint: this authenticated workspace uses isolated execution. Host filesystem and shell tools are unavailable. The user request and explicitly supplied inline files are the only starting material; do not look for a Host project, pre-existing task file, or Host path. isolation_run starts a fresh scratch workspace with no Host project mount and no network. isolation_grants can show an existing finite grant; it cannot create or extend one.'
const controllerTtlMs = 30_000
const controllerStartupDeadlineMs = 31_000
const macosSupervisor = fileURLToPath(new URL('../runtime/native-macos-supervisor.mjs', import.meta.url))
const windowsSupervisor = fileURLToPath(new URL('../runtime/windows-job-supervisor.mjs', import.meta.url))

export interface AssistantIsolationServiceOptions {
  platform?: NodeJS.Platform
  uid?: number
  allowHostPaths?: boolean
  macosAdapter?: MacosSeatbeltAdapter
  windowsAdapter?: WindowsJobAdapter
}

function waitForControllerRetry(signal: AbortSignal, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason ?? new Error('assistant-isolation: controller startup aborted')); return }
    const done = () => { signal.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(done, timeout)
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('assistant-isolation: controller startup aborted')) }
    signal.addEventListener('abort', abort, { once: true })
  })
}
declare module '@deepseek-ai/cordis' { interface Context { assistantIsolation: AssistantIsolationService } }

/** Trusted Host broker. Only bounded inline inputs cross into the isolated workspace. */
export class AssistantIsolationService extends Service {
  static { Object.defineProperty(this, 'name', { value: 'dsh-ray-assistant-isolation' }) }
  static Config = Config
  readonly #config: ReturnType<typeof validateConfig>
  readonly #backend: IsolationBackend
  readonly #options: AssistantIsolationServiceOptions
  readonly #ledger: IsolationLedger
  readonly #linuxContract: LinuxExecutionContract | undefined
  readonly #executionRoot: string
  #authority: IsolationControllerAuthority | undefined
  readonly #ready: Promise<void>
  readonly #jobs = new Map<string, { abort: AbortController; done: Promise<IsolationResult> }>()
  readonly #recoveryAbort = new AbortController()
  #sweep: Promise<void> | undefined
  #cursor = ''
  #storageCursor = ''
  #lastMaintenance = 0
  #active = true
  #timer: NodeJS.Timeout | undefined

  constructor(ctx: Context, input: Config, options: AssistantIsolationServiceOptions = {}) {
    super(ctx, 'assistantIsolation')
    this.#options = options
    const platform = options.platform ?? process.platform
    const uid = options.uid ?? process.getuid?.()
    const allowHostPaths = options.allowHostPaths ?? ((options.macosAdapter !== undefined || options.windowsAdapter !== undefined) && process.platform !== platform)
    this.#config = validateConfig(input, { platform, ...(uid !== undefined ? { uid } : {}), allowHostPaths })
    this.#backend = this.#config.backend
    const root = this.#config.stateRoot
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const rootInfo = lstatSync(root)
    if (realpathSync(root) !== root || !isPrivateDirectoryStats(rootInfo)) throw new Error('assistant-isolation: private owned state root required')
    chmodSync(root, 0o700)
    this.#executionRoot = join(root, 'linux-executions')
    if (this.#backend === 'linux-native') {
      const linux = this.#config.linux!
      this.#linuxContract = validateLinuxExecutionContract({ schemaVersion: 1, backend: 'linux-native',
        runtimeDigest: linuxRuntimeDigest(linux.runtime), profile: 'ordinary', limits: this.#config.limits,
        keeperLimits: { memoryMiB: 128, pidsLimit: 64, cpus: 0.5 }, cgroupRoots: linux.cgroupRoots })
      mkdirSync(this.#executionRoot, { recursive: true, mode: 0o700 })
      const native = lstatSync(this.#executionRoot)
      if (realpathSync(this.#executionRoot) !== this.#executionRoot || !isPrivateDirectoryStats(native)) throw new Error('assistant-isolation: private owned Linux execution root required')
    } else {
      this.#linuxContract = undefined
    }
    this.#ledger = new IsolationLedger(join(root, 'ledger.sqlite'), {
      schemaVersion: this.#backend === 'windows-job' ? 10 : 9,
    })
    ctx.on('internal/plugin', fiber => { if (fiber === ctx.fiber && fiber.uid === null) this.#abortStartup() })
    ctx.on('internal/status', fiber => { if (fiber === ctx.fiber && (fiber.state === 5 || fiber.state === 4)) this.#abortStartup() })
    ctx.on('tools/execute', async (execution, next) => {
      const header = execution.agent?.session.header
      if (header !== undefined && this.#config.grants.some(grant => grant.workspace === header.cwd && grant.agentPreset === header.agentPreset)
        && !isolatedScopeTools.has(execution.name)
        && !(preauthorizedScopedTools.has(execution.name) && this.ctx.get('assistantPolicy')?.isPreauthorizedTool?.(execution))) throw new Error('assistant-isolation: this scope requires isolated execution')
      return await next()
    })
    this.#ready = this.#startController()
    // Store the failure for run() without an unhandled background rejection.
    void this.#ready.catch(() => { this.#active = false })
    ctx.effect(() => async () => {
      this.#abortStartup()
      await Promise.allSettled([this.#ready, this.#sweep, ...Array.from(this.#jobs.values(), job => job.done)])
      if (this.#timer) clearInterval(this.#timer)
      try { if (this.#authority) this.#ledger.releaseController(this.#authority) } finally { this.#ledger.close() }
    }, 'assistant-isolation.controller')
  }

  get ready(): Promise<void> { return this.#ready }

  async [Service.init](): Promise<void> { await this.#ready }

  #isActive(): boolean {
    const fiber = this.ctx?.fiber
    // Cordis 4.1.0 transitions fiber.state to UNLOADING (5) before dependents unload or uid clears.
    return this.#active && fiber?.uid !== null && fiber?.state !== 5 && fiber?.state !== 4
  }

  #abortStartup(): void {
    this.#active = false
    this.#recoveryAbort.abort()
    for (const job of this.#jobs.values()) job.abort.abort()
  }

  async #startController(): Promise<void> {
    const ownerId = randomUUID(), deadline = Date.now() + controllerStartupDeadlineMs
    let authority: IsolationControllerAuthority
    for (;;) {
      this.#recoveryAbort.signal.throwIfAborted()
      try { authority = this.#ledger.claimController(ownerId, controllerTtlMs); break } catch (error) {
        if (!(error instanceof IsolationLedgerError) || error.code !== 'unauthorized') throw error
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw error
        await waitForControllerRetry(this.#recoveryAbort.signal, Math.min(250, remaining))
      }
    }
    if (!this.#active) { this.#ledger.releaseController(authority); this.#recoveryAbort.signal.throwIfAborted() }
    this.#authority = authority
    this.#ledger.syncGrants(this.#config.grants, authority)
    this.#timer = setInterval(() => {
      try { if (this.#authority && this.#ledger.renewController(this.#authority, controllerTtlMs)) { this.#scheduleSweep(); return } } catch { /* Losing the fence stops execution. */ }
      this.#abortStartup()
    }, 5000)
    this.#timer.unref()
    await this.#recover()
    await this.#verifyBackendReady()
    this.#recoveryAbort.signal.throwIfAborted()
    this.#registerRuntime()
  }

  async #verifyBackendReady(): Promise<void> {
    if (this.#backend === 'linux-native') {
      await verifyLinuxRuntime(this.#config.linux!.runtime)
      return
    }
    if (this.#backend === 'macos-seatbelt') {
      if (this.#config.macos?.runtime && !this.#options.macosAdapter) {
        await verifyNativeMacRuntime(this.#config.macos.runtime)
      }
      const sandboxExec = this.#options.macosAdapter?.sandboxExecPath ?? this.#config.macos?.sandboxExecPath
      if (!await verifyMacosSandboxExec(sandboxExec, this.#options.macosAdapter)) {
        throw new Error('assistant-isolation: macOS sandbox-exec unavailable')
      }
      return
    }
    const powershellPath = this.#options.windowsAdapter?.powershellPath ?? this.#config.windows?.powershellPath
    if (!await verifyWindowsJobRunner(powershellPath, this.#options.windowsAdapter)) {
      throw new Error('assistant-isolation: Windows Job runner unavailable')
    }
  }

  #registerRuntime(): void {
    this.ctx.inject(['systemPrompt'], runtime => runtime.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
      const assembly = await next()
      if (!this.#configuredOwnerScope(agent)) return assembly
      // Model-facing tool declarations are restricted via agent.ctx.tools.restrict;
      // filter matching tool prompt sections and append the isolated capability notice.
      return { ...assembly,
        // Append a capability fact without replacing deployment persona or safety sections.
        sections: [...assembly.sections.filter(section => !section.name.startsWith('tools:') || isolatedPromptTools.has(section.name.slice('tools:'.length))),
          { name: 'assistant-isolation:restricted-scope', text: restrictedScopeSection }],
      }
    }))
    this.ctx.inject(['agents', 'assistantDelivery', 'assistantPolicy', 'tools'], runtime => {
      registerIsolationTools(runtime, this)
      const restrictions = new Map<Agent, () => void>()
      let syncing = false
      const syncAgent = (agent: Agent): void => {
        restrictions.get(agent)?.()
        restrictions.delete(agent)
        const header = agent.session.header
        if (!this.#config.grants.some(grant => grant.workspace === header.cwd && grant.agentPreset === header.agentPreset)) return
        const candidates = runtime.tools.schemas(agent).map(schema => schema.name).filter(name => !isolatedPromptTools.has(name))
        if (candidates.length === 0) return
        try {
          restrictions.set(agent, agent.ctx.tools.restrict({ deny: candidates }))
        } catch {
          // If the agent owns a scope-local registration, restrict() refuses that
          // name; fall back to restricting all global non-isolated tools instead.
          const globalDenied = runtime.tools.schemas().map(schema => schema.name).filter(name => !isolatedPromptTools.has(name))
          if (globalDenied.length > 0) restrictions.set(agent, agent.ctx.tools.restrict({ deny: globalDenied }))
        }
      }
      const syncAll = (): void => {
        if (syncing) return
        syncing = true
        try {
          for (const agent of runtime.agents.list()) syncAgent(agent)
        } finally { syncing = false }
      }
      syncAll()
      runtime.on('agent/created', ({ agent }) => {
        if (syncing) return
        syncing = true
        try { syncAgent(agent) } finally { syncing = false }
      })
      runtime.on('agent/disposed', ({ agent }) => {
        restrictions.get(agent)?.()
        restrictions.delete(agent)
      })
      runtime.on('tools/change', () => syncAll())
      runtime.effect(() => () => {
        syncing = true
        try {
          for (const dispose of restrictions.values()) dispose()
          restrictions.clear()
        } finally { syncing = false }
      }, 'assistant-isolation.scoped-tool-restrictions')
    })
  }

  #scheduleSweep(): void {
    if (!this.#active || this.#sweep) return
    this.#sweep = this.#ready.then(async () => {
      const page = this.#ledger.recoverable(this.#cursor).slice(0, 16)
      this.#cursor = page.at(-1)?.id ?? ''
      for (const job of page) {
        if (!this.#active) break
        if (this.#jobs.has(job.id)) continue
        const signal = AbortSignal.any([this.#recoveryAbort.signal, AbortSignal.timeout(30_000)])
        await this.#reconcileJob(job, signal)
      }
      if (this.#active && Date.now() - this.#lastMaintenance >= 60_000) {
        this.#lastMaintenance = Date.now()
        const report = await maintainIsolationStorage(this.#ledger, this.#controller(), this.#config.stateRoot, this.#config.storage, this.#storageCursor)
        this.#storageCursor = report.cursor
      }
    }).catch(() => { /* Keep reservations and retry only with a live controller. */ }).finally(() => { this.#sweep = undefined })
  }

  #controller(): IsolationControllerAuthority {
    if (!this.#authority) throw new Error('assistant-isolation: controller unavailable')
    return this.#authority
  }

  #ownerIdentity(agent: Agent | undefined): IsolationIdentity {
    if (!this.#isActive() || !this.#ledger.hasController(this.#controller())) throw new Error('assistant-isolation: controller unavailable')
    if (agent === undefined || this.ctx.get('agents')?.get(agent.id) !== agent) throw new Error('assistant-isolation: exact live agent required')
    const owner = this.ctx.get('assistantDelivery')?.preferencePrincipalForAgent(agent)
    if (owner === undefined || owner.scope.workspace !== agent.session.header.cwd || owner.scope.preset !== agent.session.header.agentPreset) throw new Error('assistant-isolation: authenticated owner required')
    return { principalDigest: isolationPrincipalDigest(owner.principalId), ...owner.principalLineage,
      workspace: owner.scope.workspace, agentPreset: owner.scope.preset }
  }
  /** Presentation is scoped only after live owner authentication, but remains restricted after grant revoke/expiry. */
  #configuredOwnerScope(agent: Agent | undefined): boolean {
    try {
      const identity = this.#ownerIdentity(agent)
      return this.#config.grants.some(grant => grant.workspace === identity.workspace && grant.agentPreset === identity.agentPreset)
    } catch { return false }
  }

  #identity(agent: Agent | undefined, grantId: string): IsolationIdentity {
    const identity = this.#ownerIdentity(agent)
    if (this.ctx.get('assistantPolicy')?.evaluateAgent(agent, 'execute', { kind: 'tool', id: `isolation:${grantId}` }).effect !== 'allow') throw new Error('assistant-isolation: policy denied')
    return identity
  }

  /** Model-visible read-only discovery for grants already authorized to this exact live owner scope. */
  discover = async (agent: Agent | undefined): Promise<readonly IsolationGrantDiscovery[]> => {
    await this.#ready
    const identity = this.#ownerIdentity(agent)
    if (this.ctx.get('assistantPolicy')?.evaluateAgent(agent!, 'execute', { kind: 'tool', id: 'isolation_grants' }).effect !== 'allow') throw new Error('assistant-isolation: policy denied')
    const now = Date.now()
    const grants: IsolationGrantDiscovery[] = []
    for (const grant of this.#config.grants) {
      if (!this.#ledger.permitsGrant(identity, grant.id)
        || this.ctx.get('assistantPolicy')?.evaluateAgent(agent!, 'execute', { kind: 'tool', id: `isolation:${grant.id}` }).effect !== 'allow') continue
      const diagnostic = inspectIsolationGrant({ stateRoot: this.#config.stateRoot, grant, now })
      if (diagnostic.status !== 'available' || diagnostic.remainingRuns === null || diagnostic.remainingDurationMs === null) continue
      grants.push(Object.freeze({ id: grant.id, expiresAt: grant.expiresAt, remainingRuns: diagnostic.remainingRuns,
        remainingDurationMs: diagnostic.remainingDurationMs, limits: Object.freeze({ maxDurationMs: this.#config.limits.maxDurationMs,
          maxInputBytes: this.#config.limits.maxInputBytes, maxOutputBytes: this.#config.limits.maxOutputBytes,
          maxArtifactBytes: this.#config.limits.maxArtifactBytes, maxFiles: this.#config.limits.maxFiles }) }))
    }
    return Object.freeze(grants)
  }

  async #reconcileJob(job: IsolationJob, signal: AbortSignal): Promise<void> {
    if (job.backend === 'linux-native') {
      await reconcileLinuxJob(this.#ledger, this.#controller(), job, this.#executionRoot, signal)
    } else if (job.backend === 'macos-seatbelt' || job.backend === 'windows-job') {
      const uid = process.getuid?.()
      await reconcileNativeReceiptJob(this.#ledger, this.#controller(), job, this.#config.stateRoot, {
        signal,
        maxOutputBytes: this.#config.limits.maxOutputBytes,
        platform: process.platform,
        ...(uid !== undefined ? { uid } : {}),
      })
    }
  }

  async #recover(): Promise<void> {
    let cursor = ''
    for (;;) {
      const page = this.#ledger.recoverable(cursor)
      if (page.length === 0) break
      cursor = page.at(-1)!.id
      for (const job of page) {
        if (!this.#active) return
        await this.#reconcileJob(job, this.#recoveryAbort.signal)
      }
    }
  }

  /** Private Host readback; never exposed as a model tool or filesystem path. */
  readAcceptedArtifact = (input: TaskAcceptanceContract, path: string) => {
    if (!this.#isActive() || !this.#ledger.hasController(this.#controller())) throw new Error('assistant-isolation: artifact source unavailable')
    const contract = validateTaskAcceptanceContract(input)
    if (contract.protocol !== 'task-acceptance/v4' || contract.task.kind !== 'goal-step') throw new Error('assistant-isolation: artifact source must be a goal step')
    const job = this.#ledger.acceptedArtifactJob(contract.id, contract.digest, path)
    if (!job || job.artifactBinding?.admission.runId !== contract.task.ref || job.sessionId !== contract.task.goal.sessionId
      || job.identity.principalRecordId !== contract.owner.principalRecordId || job.identity.principalVersion !== contract.owner.principalVersion
      || job.identity.workspace !== contract.scope.workspace || job.identity.agentPreset !== contract.scope.preset
      || !job.dispatchAttempted || job.createdAt < contract.issuedAt || job.updatedAt >= contract.expiresAt || job.status !== 'succeeded'
      || job.result?.quiescent !== true || job.result.retention !== undefined) throw new Error('assistant-isolation: accepted artifact unavailable')
    const artifacts = job.result.artifacts.filter(artifact => artifact.path === path)
    if (artifacts.length !== 1) throw new Error('assistant-isolation: accepted artifact unavailable')
    const artifact = artifacts[0]!
    return Object.freeze({ jobId: job.id, requestDigest: job.requestDigest, admission: job.artifactBinding.admission,
      path, content: artifact.content, sha256: createHash('sha256').update(artifact.content).digest('hex') })
  }

  /** Only the trusted registered isolation tool may skip a redundant risk prompt. */
  preauthorize = (execution: ToolExecution): boolean => {
    try {
      if (execution.signal.aborted || !execution.arguments || typeof execution.arguments !== 'object' || Array.isArray(execution.arguments)) return false
      const args = execution.arguments as Record<string, unknown>
      if (Object.keys(args).some(key => !['grant_id', 'idempotency_key', 'command', 'files', 'artifacts', 'timeout_ms'].includes(key))) return false
      const request = normalizeRequest({ grantId: args.grant_id, idempotencyKey: args.idempotency_key, command: args.command,
        ...(args.files === undefined ? {} : { files: args.files }), ...(args.artifacts === undefined ? {} : { artifacts: args.artifacts }),
        ...(args.timeout_ms === undefined ? {} : { timeoutMs: args.timeout_ms }),
      } as IsolationRequest, this.#config.limits)
      return this.#ledger.permitsGrant(this.#identity(execution.agent, request.grantId), request.grantId)
    } catch { return false }
  }

  /**
   * A grant discovery is harmless only while it can report a grant usable by
   * this exact live owner. Keep the presentation query behind the same live
   * owner, Policy, expiry and revocation boundaries as isolation_run.
   */
  preauthorizeDiscovery = (execution: ToolExecution): boolean => {
    try {
      if (execution.signal.aborted || !execution.arguments || typeof execution.arguments !== 'object'
        || Array.isArray(execution.arguments) || Object.keys(execution.arguments).length !== 0) return false
      const agent = execution.agent
      const identity = this.#ownerIdentity(agent)
      if (this.ctx.get('assistantPolicy')?.evaluateAgent(agent!, 'execute', { kind: 'tool', id: 'isolation_grants' }).effect !== 'allow') return false
      return this.#config.grants.some(grant => this.#ledger.permitsGrant(identity, grant.id)
        && this.ctx.get('assistantPolicy')?.evaluateAgent(agent!, 'execute', { kind: 'tool', id: `isolation:${grant.id}` }).effect === 'allow')
    } catch { return false }
  }

  run = async (agent: Agent | undefined, input: IsolationRequest, signal: AbortSignal): Promise<IsolationResult> => {
    await this.#ready
    signal.throwIfAborted()
    const request = normalizeRequest(input, this.#config.limits)
    const identity = this.#identity(agent, request.grantId)
    const producer = this.ctx.get('assistantGoals' as never, false) as { currentArtifactAdmission?(agent: Agent): GoalArtifactAdmission | undefined } | undefined
    const admission = producer?.currentArtifactAdmission?.(agent!)
    const requestDigest = this.#backend === 'linux-native'
      ? digest({ request, backend: 'linux-native', contract: linuxExecutionContractDigest(this.#linuxContract!) })
      : this.#backend === 'macos-seatbelt'
        ? digest({ request, backend: 'macos-seatbelt', macos: this.#config.macos ?? null, limits: this.#config.limits })
        : digest({ request, backend: 'windows-job', windows: this.#config.windows ?? null, limits: this.#config.limits })
    const existing = this.#ledger.findJobByKey(identity, String(agent!.session.id), request.grantId, request.idempotencyKey)
    if (existing) {
      if (existing.backend !== this.#backend || existing.requestDigest !== requestDigest
        || this.#linuxContract && (!existing.linuxContract || linuxExecutionContractDigest(existing.linuxContract) !== linuxExecutionContractDigest(this.#linuxContract))) {
        throw new IsolationLedgerError('conflict', 'idempotency key has a different request or backend')
      }
      const result = await this.#jobs.get(existing.id)?.done ?? existing.result ?? {
        jobId: existing.id, status: 'unknown' as const, quiescent: false, stdout: '', stderr: '', artifacts: [], reason: 'job-in-progress-no-replay',
      }
      if (digest(this.#identity(agent, request.grantId)) !== digest(identity)) throw new Error('assistant-isolation: owner changed')
      return structuredClone(result)
    }
    if (this.#backend === 'linux-native') await verifyLinuxRuntime(this.#config.linux!.runtime)
    else await this.#verifyBackendReady()
    const observation = await observeStorage(this.#config.stateRoot)
    signal.throwIfAborted()
    if (digest(this.#identity(agent, request.grantId)) !== digest(identity)) throw new Error('assistant-isolation: owner changed')
    const resources = this.#linuxContract ? linuxJobResourceReservation(this.#linuxContract) : undefined
    const prepared = this.#ledger.prepare({
      ...(admission ? { artifactBinding: { admission: validateGoalArtifactAdmission(admission), paths: request.artifacts ?? [] } } : {}),
      identity,
      sessionId: String(agent!.session.id),
      grantId: request.grantId,
      idempotencyKey: request.idempotencyKey,
      requestDigest,
      backend: this.#backend,
      ...(this.#linuxContract ? { linuxContract: this.#linuxContract } : {}),
      ...(this.#backend === 'linux-native'
        ? {
            resourceReservation: {
              memoryMiB: resources!.memoryMiB,
              workspaceInodes: resources!.workspaceInodes,
              maxMemoryMiB: this.#config.maxReservedMemoryMiB,
              maxWorkspaceInodes: this.#config.maxReservedWorkspaceInodes,
            },
          }
        : this.#backend === 'windows-job'
          ? {
              resourceReservation: {
                memoryMiB: this.#config.limits.memoryMiB + this.#config.limits.workspaceMiB + 32,
                workspaceInodes: 0,
                maxMemoryMiB: this.#config.maxReservedMemoryMiB,
                maxWorkspaceInodes: this.#config.maxReservedWorkspaceInodes,
              },
            }
          : {}),
      storageBudget: {
        maxStateBytes: this.#config.storage.maxStateBytes,
        maxJobRecords: this.#config.storage.maxJobRecords,
        reservedBytes: resources?.storageBytes ?? 3 * plannedStorageBytes(this.#config.limits),
        ...(observation ? { observation } : {}),
      },
      durationMs: request.timeoutMs!,
      maxActiveJobs: this.#config.maxConcurrentJobs,
      authority: this.#controller(),
    })
    if (!prepared.created) {
      const current = this.#jobs.get(prepared.job.id)
      const result = current ? await current.done : prepared.job.result ?? {
        jobId: prepared.job.id, status: 'unknown' as const, quiescent: false, stdout: '', stderr: '', artifacts: [], reason: 'job-in-progress-no-replay',
      }
      if (digest(this.#identity(agent, request.grantId)) !== digest(identity)) throw new Error('assistant-isolation: owner changed')
      return structuredClone(result)
    }
    const authorization = this.ctx.get('assistantPolicy')?.authorizeAgent(agent, 'execute', { kind: 'tool', id: `isolation:${request.grantId}` }, {
      idempotencyKey: `isolation:${prepared.job.id}`,
    })
    if (authorization?.effect !== 'allow') {
      const result: IsolationResult = { jobId: prepared.job.id, status: 'failed', quiescent: true, stdout: '', stderr: '', artifacts: [], reason: 'policy-denied-before-dispatch' }
      this.#ledger.settle(prepared.job.id, prepared.job.version, result, this.#authority)
      throw new Error('assistant-isolation: policy denied')
    }
    const abort = new AbortController()
    const combined = AbortSignal.any([signal, abort.signal])
    const done = this.#execute(agent!, identity, prepared.job, request, combined)
    this.#jobs.set(prepared.job.id, { abort, done })
    try {
      const result = await done
      if (digest(this.#identity(agent, request.grantId)) !== digest(identity)) throw new Error('assistant-isolation: owner changed')
      return structuredClone(result)
    } finally { this.#jobs.delete(prepared.job.id) }
  }

  async #executeLinux(initial: IsolationJob, request: IsolationRequest, signal: AbortSignal,
    authorized: () => boolean, update: (job: IsolationJob) => void): Promise<IsolationResult> {
    let job = initial
    const contract = this.#linuxContract!
    const current = (next: IsolationJob): void => { job = next; update(next) }
    let result: IsolationResult = { jobId: job.id, status: 'failed', quiescent: true,
      stdout: '', stderr: '', artifacts: [], reason: 'preparation-failed' }
    try {
      if (!authorized()) throw new Error('authorization-denied-before-create')
      const intent = await prepareLinuxExecutionIntent({ stateRoot: this.#executionRoot, contract,
        job: { id: job.id, requestDigest: job.requestDigest, nativeResourceId: job.nativeResourceId!, nativeNonce: job.nativeNonce!, deadline: job.deadline } })
      if (!authorized()) throw new Error('authorization-denied-before-create')
      current(this.#ledger.markLinuxCreateIntent(job.id, job.version, intent, this.#controller()))
      current(this.#ledger.markDispatched(job.id, job.version, this.#controller()))
      await runLinuxExecution({ stateRoot: this.#executionRoot, contract, intent,
        argv: ['/bin/sh', '-c', 'PATH=/runtime/0/bin:/runtime/0/pnpm-native:/usr/bin:/bin; export PATH; exec /bin/sh -c "$1"', 'dsh-isolation', request.command],
        files: request.files ?? [], artifacts: request.artifacts ?? [], readOnlyRoots: [this.#config.linux!.runtime.root.path], signal,
        recordResources: async resources => {
          if (!authorized()) throw new Error('authorization-denied-before-create')
          current(this.#ledger.recordLinuxResources(job.id, job.version, resources, this.#controller()))
        }, authorizeStart: () => {
          if (!authorized()) return false
          current(this.#ledger.start(job.id, job.version, this.#controller()))
          return true
        } })
      const ctx = { stateRoot: this.#executionRoot, contract, intent }
      const receipt = await readLinuxExecutionReceipt(ctx)
      if (!receipt) {
        const proof = await readLinuxExecutionPartialCleanupProof(ctx)
        if (proof) return this.#ledger.settleLinuxPrestartCleanup(job.id, job.version, proof, this.#controller()).result!
        throw new Error('Linux execution receipt unavailable')
      }
      if (!job.linuxResources) current(this.#ledger.recordLinuxResources(job.id, job.version, receipt.resources, this.#controller()))
      return this.#ledger.settleLinuxReceipt(job.id, job.version, linuxExecutionReceiptBinding(receipt), receipt.result, this.#controller()).result!
    } catch {
      if (job.dispatchAttempted) result = { ...result, status: 'unknown', quiescent: false, reason: 'runner-exception-no-replay' }
      try { return this.#ledger.settle(job.id, job.version, result, this.#controller()).result! }
      catch { return { ...result, status: 'unknown', quiescent: false, reason: 'settlement-unconfirmed' } }
    }
  }

  async #executeNativeCommand(
    backend: 'macos-seatbelt' | 'windows-job',
    initial: IsolationJob,
    request: IsolationRequest,
    signal: AbortSignal,
    authorized: () => boolean,
    update: (job: IsolationJob) => void,
  ): Promise<IsolationResult> {
    let job = initial
    const current = (next: IsolationJob): void => { job = next; update(next) }
    let result: IsolationResult = {
      jobId: job.id,
      status: 'failed',
      quiescent: true,
      stdout: '',
      stderr: '',
      artifacts: [],
      reason: 'preparation-failed',
    }
    const workspaceRoot = join(this.#config.stateRoot, 'workspaces', job.id)
    try {
      if (!authorized()) throw new Error('authorization-denied-before-create')
      const workspacePath = await stageWorkspace(this.#config.stateRoot, job.id, request)
      const tmpPath = join(workspaceRoot, 'tmp')
      await mkdir(tmpPath, { recursive: true, mode: 0o700 })
      const receipts = join(this.#config.stateRoot, 'receipts')
      await mkdir(receipts, { recursive: true, mode: 0o700 })
      const receiptInfo = await lstat(receipts)
      if (!isPrivateDirectoryStats(receiptInfo)) throw new Error('invalid native receipt directory')
      if (!authorized()) throw new Error('authorization-denied-before-create')

      current(this.#ledger.markDispatched(job.id, job.version, this.#controller()))

      const adapter = backend === 'macos-seatbelt' ? this.#options.macosAdapter : this.#options.windowsAdapter
      if (adapter) {
        current(this.#ledger.start(job.id, job.version, this.#controller()))
        let outcome
        if (backend === 'macos-seatbelt') {
          const sandboxExecPath = this.#config.macos?.sandboxExecPath
          outcome = await runMacosSeatbeltCommand({
            workspacePath,
            tmpPath,
            command: request.command,
            readOnlyRoots: [
              ...(this.#config.macos?.readOnlyRoots ?? []),
              ...(this.#config.macos?.runtime ? this.#config.macos.runtime.roots.map(r => r.path) : []),
            ],
            workspaceWritable: true,
            allowNetwork: false,
            artifacts: request.artifacts ?? [],
            maxArtifactBytes: this.#config.limits.maxArtifactBytes,
            deadline: job.deadline,
            maxOutputBytes: this.#config.limits.maxOutputBytes,
            ...(sandboxExecPath !== undefined ? { sandboxExecPath } : {}),
            signal,
          }, adapter as MacosSeatbeltAdapter)
        } else {
          outcome = await runWindowsJobProcess({
            workspacePath,
            tmpPath,
            command: request.command,
            ...(this.#config.windows?.shell !== undefined ? { shell: this.#config.windows.shell } : {}),
            ...(this.#config.windows?.shellPath !== undefined ? { shellPath: this.#config.windows.shellPath } : {}),
            ...(this.#config.windows?.powershellPath !== undefined ? { powershellPath: this.#config.windows.powershellPath } : {}),
            networkMode: 'none',
            artifacts: request.artifacts ?? [],
            maxArtifactBytes: this.#config.limits.maxArtifactBytes,
            deadline: job.deadline,
            maxOutputBytes: this.#config.limits.maxOutputBytes,
            limits: {
              memoryMiB: this.#config.limits.memoryMiB,
              pidsLimit: this.#config.limits.pidsLimit,
              cpus: this.#config.limits.cpus,
            },
            signal,
          }, adapter as WindowsJobAdapter)
        }

        if (outcome.quiescent) {
          writeNativeReceiptSync(receipts, {
            schemaVersion: 1,
            backend,
            jobId: job.id,
            requestDigest: job.requestDigest,
            nonce: job.nativeNonce!,
            nativeResourceId: job.nativeResourceId!,
            closed: true,
            closedAt: Date.now(),
            result: { ...outcome, quiescent: true },
          })
        }
      } else {
        const supervisorPath = backend === 'macos-seatbelt' ? macosSupervisor : windowsSupervisor
        const supervisorInput = backend === 'macos-seatbelt'
          ? {
              workspacePath,
              tmpPath,
              command: request.command,
              readOnlyRoots: [
                ...(this.#config.macos?.readOnlyRoots ?? []),
                ...(this.#config.macos?.runtime ? this.#config.macos.runtime.roots.map(r => r.path) : []),
              ],
              workspaceWritable: true,
              allowNetwork: false,
              artifacts: request.artifacts ?? [],
              maxArtifactBytes: this.#config.limits.maxArtifactBytes,
              deadline: job.deadline,
              maxOutputBytes: this.#config.limits.maxOutputBytes,
              sandboxExecPath: this.#config.macos?.sandboxExecPath,
            }
          : {
              workspacePath,
              tmpPath,
              command: request.command,
              shell: this.#config.windows?.shell,
              shellPath: this.#config.windows?.shellPath,
              powershellPath: this.#config.windows?.powershellPath,
              networkMode: 'none' as const,
              artifacts: request.artifacts ?? [],
              maxArtifactBytes: this.#config.limits.maxArtifactBytes,
              deadline: job.deadline,
              maxOutputBytes: this.#config.limits.maxOutputBytes,
              limits: {
                memoryMiB: this.#config.limits.memoryMiB,
                pidsLimit: this.#config.limits.pidsLimit,
                cpus: this.#config.limits.cpus,
              },
            }

        const child = fork(supervisorPath, [], {
          detached: true,
          cwd: this.#config.stateRoot,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        })
        try {
          current(this.#ledger.start(job.id, job.version, this.#controller()))
        } catch (error) {
          child.disconnect()
          child.unref()
          throw error
        }
        await this.#waitNativeSupervisor(child, job, receipts, supervisorInput, signal)
      }

      const settled = await readNativeReceipt(this.#config.stateRoot, job, this.#config.limits.maxOutputBytes, process.platform, process.getuid?.())
      if (!settled) throw new Error('native execution receipt unavailable')
      const finalJob = this.#ledger.settleNativeReceipt(job.id, job.version, {
        requestDigest: job.requestDigest,
        nonce: job.nativeNonce!,
        nativeResourceId: job.nativeResourceId!,
      }, settled, this.#controller())
      await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
      return finalJob.result!
    } catch {
      if (job.dispatchAttempted) result = { ...result, status: 'unknown', quiescent: false, reason: 'runner-exception-no-replay' }
      else await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
      try { return this.#ledger.settle(job.id, job.version, result, this.#controller()).result! }
      catch { return { ...result, status: 'unknown', quiescent: false, reason: 'settlement-unconfirmed' } }
    }
  }

  async #waitNativeSupervisor(
    child: ChildProcess,
    job: IsolationJob,
    receipts: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<'receipt' | 'unconfirmed'> {
    return await new Promise(resolveOutcome => {
      let done = false
      const finish = (value: 'receipt' | 'unconfirmed') => {
        if (done) return
        done = true
        clearTimeout(grace)
        signal.removeEventListener('abort', cancel)
        child.removeAllListeners('message')
        child.removeAllListeners('exit')
        child.removeAllListeners('error')
        if (child.connected) child.disconnect()
        child.unref()
        resolveOutcome(value)
      }
      const cancel = () => { if (child.connected) child.send({ kind: 'cancel' }) }
      const grace = setTimeout(() => finish('unconfirmed'), Math.max(1, job.deadline - Date.now()) + 8_000)
      signal.addEventListener('abort', cancel, { once: true })
      child.on('message', message => {
        if (message && typeof message === 'object' && 'kind' in message && message.kind === 'receipt') finish('receipt')
        else if (message && typeof message === 'object' && 'kind' in message && message.kind === 'unconfirmed') finish('unconfirmed')
      })
      child.on('exit', () => finish('unconfirmed'))
      child.on('error', () => finish('unconfirmed'))
      if (signal.aborted) cancel()
      child.send({
        kind: 'command',
        jobId: job.id,
        requestDigest: job.requestDigest,
        nonce: job.nativeNonce,
        nativeResourceId: job.nativeResourceId,
        receiptRoot: receipts,
        input,
      }, error => {
        if (error) finish('unconfirmed')
      })
    })
  }

  async #execute(agent: Agent, identity: IsolationIdentity, initial: IsolationJob, request: IsolationRequest, signal: AbortSignal): Promise<IsolationResult> {
    let job = initial
    const abort = new AbortController()
    const authorized = (): boolean => {
      try {
        if (job.artifactBinding) {
          const producer = this.ctx.get('assistantGoals' as never, false) as { currentArtifactAdmission?(agent: Agent): GoalArtifactAdmission | undefined } | undefined
          const admission = producer?.currentArtifactAdmission?.(agent)
          if (!admission || digest(admission) !== digest(job.artifactBinding.admission)) return false
        }
        return !signal.aborted && this.#ledger.usable(job.id)
        && digest(this.#identity(agent, job.grantId)) === digest(identity) } catch { return false }
    }
    const timer = setInterval(() => { if (!authorized()) abort.abort() }, 250)
    timer.unref()
    const combinedSignal = AbortSignal.any([signal, abort.signal])
    try {
      if (job.backend === 'linux-native') {
        return await this.#executeLinux(job, request, combinedSignal, authorized, next => { job = next })
      }
      if (job.backend === 'macos-seatbelt' || job.backend === 'windows-job') {
        return await this.#executeNativeCommand(job.backend, job, request, combinedSignal, authorized, next => { job = next })
      }
      return { jobId: job.id, status: 'failed', quiescent: true, stdout: '', stderr: '', artifacts: [], reason: `unsupported-backend:${job.backend}` }
    } finally {
      clearInterval(timer)
    }
  }
}
