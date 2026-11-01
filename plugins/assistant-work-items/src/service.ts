import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { WorkItemAdmission } from './admission.js'
import { ConfigSchema, isActive, normalizeConfig, text, type Config, type NormalizedConfig } from './config.js'
import { WorkItemDispatch } from './dispatch.js'
import { WorkItemLedger } from './ledger.js'
import type {
  PeerAutomationsService,
  PeerDeliveryService,
  PeerOwnerRouteReceipt,
  PeerPolicyService,
} from './peers.js'
import { WorkItemStore } from './store.js'
import {
  WorkItemSignalIntake,
  type WorkItemSignalRegistration,
  type WorkItemSignalSweepReport,
} from './signals.js'
import { registerWorkItemTools } from './tools.js'
import type {
  WorkItemAdmitInput,
  WorkItemAdmitResult,
  WorkItemClaimRecord,
  WorkItemHealth,
  WorkItemRecord,
  WorkItemReportRecord,
  WorkItemReportStatus,
} from './types.js'
import { WorkItemError } from './types.js'
import { WorkItemWorkspace } from './workspace.js'

function fail(code: ConstructorParameters<typeof WorkItemError>[0], message: string, detail?: string): never {
  throw new WorkItemError(code, message, detail)
}

/** Bounded, model-facing view of one successful claim. */
export interface WorkItemClaimView {
  readonly itemId: string
  readonly runId: string
  readonly state: string
  readonly kind: string
  readonly externalId: string
  readonly title: string
  readonly brief: string
  readonly briefTruncated: boolean
  readonly acceptanceRef: string | null
  readonly workDir: string
  readonly attempt: number
  readonly maxAttempts: number
  readonly leaseUntil: number | null
  readonly replayed: boolean
}

/** Bounded, model-facing view of one appended report. */
export interface WorkItemReportView {
  readonly itemId: string
  readonly revision: number
  readonly status: WorkItemReportStatus
  readonly state: string
  readonly truncated: boolean
  readonly artifactPaths: readonly string[]
  readonly delivery: string
  readonly replayed: boolean
  readonly notified: boolean
}

/** Bounded, read-only view of the current run's item. */
export interface WorkItemStatusView {
  readonly item: WorkItemRecord
  readonly claim: WorkItemClaimRecord | undefined
  readonly reports: readonly WorkItemReportRecord[]
  readonly openItems: number
}

/** One lazy persistence stack; absent while the intake is disabled. */
interface Components {
  readonly workspace: WorkItemWorkspace
  readonly store: WorkItemStore
  readonly ledger: WorkItemLedger
  readonly admission: WorkItemAdmission
  readonly dispatch: WorkItemDispatch
  readonly signals: WorkItemSignalIntake
}

export interface WorkItemReportInput {
  readonly status: WorkItemReportStatus
  readonly summary: string
  readonly artifactPaths?: readonly string[]
  readonly idempotencyKey: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    assistantWorkItems: AssistantWorkItemsService
  }
}

/**
 * Work-item intake kernel.
 *
 * This service owns configuration, the private ledger and identity resolution;
 * it deliberately owns no agent loop, timer, outbox, budget or session. Every
 * side effect is a call into an existing peer plugin (`assistant-automations`
 * for the worker run, `assistant-delivery` for the owner notification), and the
 * disabled default opens no file at all.
 */
export class AssistantWorkItemsService extends Service {
  static Config = ConfigSchema

  readonly #config: NormalizedConfig
  #components: Components | undefined
  #closed = false

  constructor(ctx: Context, input: Config) {
    super(ctx, 'assistantWorkItems')
    this.#config = Object.freeze(normalizeConfig(input, Date.now()))
    ctx.effect(() => () => this.close(), 'assistant-work-items.store')
    ctx.inject(['tools'], toolsCtx => registerWorkItemTools(toolsCtx, this))
    // The disabled default must not create a directory, lock a file or open a
    // database, so persistence starts only for an explicitly enabled intake.
    if (this.#config.enabled) this.#open()
  }

  get enabled(): boolean {
    return this.#config.enabled
  }

  get mode(): 'observe' | 'active' {
    return this.#config.mode
  }

  /**
   * Admit one external work signal.
   *
   * Host-side entry point for a future external source plugin. It performs no
   * dispatch work beyond the same bounded wake the ledger does on recovery, so
   * observe mode stays free of external effects.
   */
  admit(input: WorkItemAdmitInput): WorkItemAdmitResult {
    const components = this.#available()
    const result = components.admission.admit(input)
    if (result.created && isActive(this.#config)) {
      try {
        components.dispatch.wake(result.item)
      } catch (error) {
        // The item is durable evidence; a failed wake is recorded on the
        // dispatch row and retried by the next bounded recovery pass.
        this.ctx.logger.warn(`assistant-work-items: worker wake failed: ${describe(error)}`)
      }
      const dispatch = components.store.getDispatch(result.item.id)
      if (dispatch !== undefined) return Object.freeze({ ...result, dispatch })
    }
    return result
  }

  /**
   * Claim the item bound to the calling automation occurrence.
   *
   * Identity comes exclusively from the frozen, production automation
   * execution context installed by `assistant-automations`; a foreground
   * session, a preview run and another automation all fail closed.
   *
   * An armed signal source is swept here (bounded by the persisted
   * `sweepIntervalMs`) so ordinary use keeps producing work without a timer or
   * developer orchestration. A sweep failure never fails the claim.
   */
  claim(agent: Agent | undefined): WorkItemClaimView {
    const components = this.#required()
    this.#sweepQuietly(components)
    const occurrenceId = this.#occurrenceId(agent)
    components.ledger.recover()
    const item = components.store.findItemByOccurrence(occurrenceId)
    if (item === undefined) fail('not-found', 'no work item is bound to this automation occurrence')
    this.#assertOwnerRoute(item)
    const runId = occurrenceId
    const result = components.ledger.claim({ itemId: item.id, runId, occurrenceId })
    return Object.freeze({
      itemId: result.item.id,
      runId: result.claim.runId,
      state: result.item.state,
      kind: result.item.kind,
      externalId: result.item.externalId,
      title: result.item.title,
      brief: result.item.brief,
      briefTruncated: result.item.briefTruncated,
      acceptanceRef: result.item.acceptanceRef,
      workDir: result.item.workDir,
      attempt: result.item.attempt,
      maxAttempts: result.item.maxAttempts,
      leaseUntil: result.item.leaseUntil,
      replayed: result.replayed,
    })
  }

  /**
   * Append one report revision under the caller's active claim.
   *
   * Reporting is the only worker write path. A terminal status additionally
   * enqueues one owner notification through `assistant-delivery`; a delivery
   * failure is recorded against the report instead of erasing report evidence.
   */
  async report(agent: Agent | undefined, input: WorkItemReportInput): Promise<WorkItemReportView> {
    const components = this.#required()
    const occurrenceId = this.#occurrenceId(agent)
    components.ledger.recover()
    const item = components.store.findItemByOccurrence(occurrenceId)
    if (item === undefined) fail('not-found', 'no work item is bound to this automation occurrence')
    const result = components.ledger.report({
      itemId: item.id,
      runId: occurrenceId,
      status: input.status,
      summary: input.summary,
      artifactPaths: input.artifactPaths ?? [],
      idempotencyKey: input.idempotencyKey,
    })
    let notified = false
    if (!result.replayed) {
      try {
        notified = await components.dispatch.notify(result.item, result.report)
      } catch (error) {
        // `notify` already persisted the failed/unknown delivery state. Report
        // evidence must survive a notification failure, so surface it in the
        // log and keep the appended revision.
        this.ctx.logger.warn(`assistant-work-items: owner notification failed: ${describe(error)}`)
      }
    }
    const stored = components.store.reports(item.id).find(report => report.revision === result.report.revision)
    return Object.freeze({
      itemId: result.item.id,
      revision: result.report.revision,
      status: result.report.status,
      state: result.item.state,
      truncated: result.report.truncated,
      artifactPaths: result.report.artifactPaths,
      delivery: (stored ?? result.report).deliveryState ?? 'pending',
      replayed: result.replayed,
      notified,
    })
  }

  /**
   * Register one additional automatic source and return an idempotent disposer.
   *
   * This is the public extension point for an external signal producer (a
   * repository watcher, a chat bridge, a scheduler): the producer supplies a
   * read-only `WorkItemSignalSource`, gets the same bounded sweep, provenance,
   * dedupe, cooldown and settled-item fence as the built-in adapter, and can be
   * withdrawn by disposing the registration. Registration fails closed when the
   * intake is disabled or already disposed, and never admits retroactively.
   */
  registerSignalSource(registration: WorkItemSignalRegistration): () => void {
    const components = this.#available()
    const dispose = components.signals.register(registration)
    return () => {
      dispose()
    }
  }

  /**
   * Sweep every armed automatic source once and report what it did.
   *
   * Explicit host entry point; `force` ignores the persisted interval. The
   * disabled default and a missing optional peer both return an empty report,
   * so a caller never has to special-case activation.
   */
  sweepSignals(force = true): WorkItemSignalSweepReport {
    if (!this.#config.enabled || this.#closed) return Object.freeze({ sources: [] })
    try {
      return this.#open().signals.sweep(force)
    } catch (error) {
      this.ctx.logger.warn(`assistant-work-items: signal sweep unavailable: ${describe(error)}`)
      return Object.freeze({ sources: [] })
    }
  }

  /** Read-only status of the item bound to the calling occurrence. */
  status(agent: Agent | undefined): WorkItemStatusView {
    const components = this.#required()
    const occurrenceId = this.#occurrenceId(agent)
    components.ledger.recover()
    const item = components.store.findItemByOccurrence(occurrenceId)
    if (item === undefined) fail('not-found', 'no work item is bound to this automation occurrence')
    return Object.freeze({
      item,
      claim: components.store.activeClaim(item.id),
      reports: components.store.reports(item.id),
      openItems: components.store.countOpenItems(),
    })
  }

  /** Bounded health projection; never creates the ledger when disabled. */
  health(): WorkItemHealth {
    const config = this.#config
    const empty: WorkItemHealth = Object.freeze({
      enabled: config.enabled,
      mode: config.mode,
      openItems: 0,
      lastAdmitAt: null,
      lastDispatchAt: null,
      dispatchUnknown: 0,
      workerConnected: config.enabled && this.#automations() !== undefined,
      ownerRouteValid: false,
    })
    if (!config.enabled || this.#closed) return empty
    let components: Components
    try {
      components = this.#open()
    } catch (error) {
      this.ctx.logger.warn(`assistant-work-items: ledger unavailable: ${describe(error)}`)
      return empty
    }
    return Object.freeze({
      enabled: true,
      mode: config.mode,
      openItems: components.store.countOpenItems(),
      lastAdmitAt: components.store.lastAdmitAt(),
      lastDispatchAt: components.store.lastDispatchedAt(),
      dispatchUnknown: components.store.countDispatchUnknown(),
      workerConnected: workerIsConnected(this.#automations()),
      ownerRouteValid: this.#ownerRouteValid(),
    })
  }

  /** Close the ledger exactly once; safe on an intake that never opened. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    const components = this.#components
    this.#components = undefined
    if (components === undefined) return
    try {
      components.store.close()
    } catch (error) {
      this.ctx.logger.warn(`assistant-work-items: ledger close failed: ${describe(error)}`)
    }
  }

  #available(): Components {
    if (!this.#config.enabled) fail('disabled', 'the work-item intake is disabled')
    return this.#open()
  }

  /** Best-effort bounded sweep; log and continue on any failure. */
  #sweepQuietly(components: Components): void {
    if (!components.signals.armed()) return
    try {
      components.signals.sweep()
    } catch (error) {
      this.ctx.logger.warn(`assistant-work-items: signal sweep failed: ${describe(error)}`)
    }
  }

  #required(): Components {
    const config = this.#config
    if (!config.enabled) fail('disabled', 'the work-item intake is disabled')
    if (!isActive(config)) fail('observe-mode', 'the work-item intake is in observe mode; claim and report require mode: active')
    return this.#open()
  }

  #open(): Components {
    const existing = this.#components
    if (existing !== undefined) return existing
    if (this.#closed) fail('storage', 'the work-item intake is disposed')
    const config = this.#config
    const workspace = new WorkItemWorkspace(config.workRoot)
    workspace.prepare()
    const store = new WorkItemStore(config.databasePath)
    const ledger = new WorkItemLedger({ store, workspace, limits: config.limits })
    // Admission and dispatch both take the same ledger and the same resolved
    // peers, so one construction order keeps a single writer per durable file.
    const admission = new WorkItemAdmission({
      config,
      store,
      ledger,
      workspace,
      policy: this.#policy(),
      delivery: this.#delivery(),
    })
    const dispatch = new WorkItemDispatch({
      config,
      store,
      ledger,
      automations: this.#automations(),
      delivery: this.#delivery(),
    })
    // Signal sources are optional peers resolved lazily on every sweep, so a
    // deployment without `assistant-delivery` (or with the source disabled)
    // stays a no-op instead of failing activation or a claim.
    const signals = new WorkItemSignalIntake({
      config,
      store,
      admission,
      delivery: () => this.#delivery(),
      dispatch,
      warn: message => this.ctx.logger.warn(message),
    })
    const installed: Components = { workspace, store, ledger, admission, dispatch, signals }
    this.#components = installed
    try {
      // Bounded startup reconcile: lease reclaim is lazy forever, so a host that
      // was down catches up on the first touch instead of on a timer.
      installed.ledger.recover()
      if (isActive(config)) {
        try {
          installed.dispatch.wakePending()
        } catch (error) {
          this.ctx.logger.warn(`assistant-work-items: pending wake failed: ${describe(error)}`)
        }
      }
    } catch (error) {
      this.#components = undefined
      store.close()
      throw error
    }
    return installed
  }

  /** Resolve the exact production automation occurrence for this agent. */
  #occurrenceId(agent: Agent | undefined): string {
    if (agent === undefined) fail('identity-mismatch', 'work-item tools require the worker automation run')
    const execution = (agent.ctx as unknown as { get(name: string): unknown }).get('assistantAutomationExecution')
    if (typeof execution !== 'object' || execution === null || Array.isArray(execution)
      || !Object.isFrozen(execution)
      || Object.keys(execution).sort().join(',') !== 'automationId,mode,occurrenceId') {
      fail('identity-mismatch', 'work-item tools require the immutable automation execution context')
    }
    const installed = execution as { mode?: unknown; automationId?: unknown; occurrenceId?: unknown }
    if (installed.mode !== 'production'
      || typeof installed.automationId !== 'string'
      || typeof installed.occurrenceId !== 'string') {
      fail('identity-mismatch', 'work-item tools are restricted to a production automation run')
    }
    const automationId = text(installed.automationId, 'automationId', 500)
    const occurrenceId = text(installed.occurrenceId, 'occurrenceId', 500)
    if (automationId !== this.#config.workerAutomationId) {
      fail('identity-mismatch', 'this automation is not the configured work-item worker')
    }
    return occurrenceId
  }

  /** Re-anchor a claim against the live owner route above the stored receipt. */
  #assertOwnerRoute(item: WorkItemRecord): void {
    const config = this.#config
    const delivery = this.#delivery()
    if (delivery === undefined) fail('owner-route-unavailable', 'assistantDelivery is required to validate the owner route')
    const scope = item.scope
    if (scope.expiresAt <= Date.now()) fail('owner-route-expired', 'the work-item owner scope expired')
    let receipt: Readonly<PeerOwnerRouteReceipt>
    try {
      receipt = delivery.validateOwnerRoute({
        authorityId: scope.ownerRouteId,
        principalId: scope.principalId,
        workspace: scope.workspace,
        agentPreset: scope.preset,
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const missing = error !== null && typeof error === 'object' && 'code' in error && error.code === 'missing-binding'
      fail(missing ? 'owner-route-invalid' : 'owner-route-unavailable', 'owner route validation failed', detail)
    }
    if (receipt.receiptVersion !== 2
      || receipt.workspace !== scope.workspace
      || receipt.agentPreset !== scope.preset
      || receipt.principalId !== scope.principalId
      || receipt.authorityId !== scope.ownerRouteId) {
      fail('owner-route-invalid', 'owner route receipt does not match the admitted scope')
    }
    if (receipt.principalRecordId !== item.owner.principalRecordId) {
      fail('owner-route-invalid', 'owner principal changed since admission')
    }
    if (config.workerAutomationId !== item.workerAutomationId) {
      fail('identity-mismatch', 'item was dispatched to a different worker automation')
    }
  }

  #ownerRouteValid(): boolean {
    const config = this.#config
    const scope = config.scope
    if (scope === null) return false
    const delivery = this.#delivery()
    if (delivery === undefined) return false
    if (scope.expiresAt <= Date.now()) return false
    try {
      const receipt = delivery.validateOwnerRoute({
        authorityId: scope.ownerRouteId,
        principalId: scope.principalId,
        workspace: scope.workspace,
        agentPreset: scope.preset,
      })
      return receipt.receiptVersion === 2 && receipt.workspace === scope.workspace
    } catch {
      return false
    }
  }

  #policy(): PeerPolicyService | undefined {
    return this.ctx.get('assistantPolicy') as PeerPolicyService | undefined
  }

  #delivery(): PeerDeliveryService | undefined {
    return this.ctx.get('assistantDelivery') as PeerDeliveryService | undefined
  }

  #automations(): PeerAutomationsService | undefined {
    return this.ctx.get('assistantAutomations') as PeerAutomationsService | undefined
  }
}

function workerIsConnected(automations: PeerAutomationsService | undefined): boolean {
  return automations !== undefined
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
