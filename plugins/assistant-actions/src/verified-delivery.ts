import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-goal'
import type { AssistantAutomationsService, HostAutomationDefinition, HostAutomationExecutorInput, HostAutomationExecutorResult } from '@dsh-enhanced/assistant-automations'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ActionIdentity, ActionResult, VerifiedDeliveryRequest } from './types.js'

export const verifiedDeliveryOwner = 'assistant-actions-verified-delivery/v1'
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const catalogDigest = hash({ owner: verifiedDeliveryOwner, version: 1 })
export interface DeliverySecurity {
  principalId: string; identity: ActionIdentity; sessionId: string; goalId: string; runId: string
  definitionDigest: string; definitionVersion: number; grantId: string; grantRevision: number
  ownerRouteId: string; budgetId: string; expiresAt: number; routeReceipt: unknown
}
export interface VerifiedFiles {
  acceptance: { validUntil: number }
  files: readonly { path: string; content: string; sha256: string; jobId: string }[]
}
export interface DeliveryIntent { id: string; request: VerifiedDeliveryRequest; security: DeliverySecurity }
export interface DeliveryOutcome { commit: ActionResult; pullRequest?: ActionResult }
type State = 'awaiting-verification' | 'scheduled' | 'executing' | 'succeeded' | 'failed' | 'unknown'
interface Row { id: string; intent: string; state: State; at_ms: number | null; deadline_ms: number | null; definition_hash: string | null; result: string | null; notification_state: 'pending' | 'enqueued' }
interface Ports {
  capture(agent: Agent | undefined, request: VerifiedDeliveryRequest): DeliverySecurity
  inspect(intent: DeliveryIntent): VerifiedFiles | undefined
  deliver(intent: DeliveryIntent, snapshot: VerifiedFiles, signal: AbortSignal): Promise<DeliveryOutcome>
  notify(intent: DeliveryIntent, notification: { idempotencyKey: string; text: string; outcome: unknown }): void
}
const key = (sessionId: string, grantId: string, idempotencyKey: string) => `verified-delivery-${hash([sessionId, grantId, idempotencyKey])}`

/** A durable handoff, with scheduling and task leases owned by Automations. */
export class VerifiedDeliveryRuntime {
  readonly #db: DatabaseSync
  readonly #abort = new AbortController()
  readonly #pending = new Set<Promise<HostAutomationExecutorResult>>()
  #automations: AssistantAutomationsService | undefined
  #active = true
  #queued = false
  #failures = 0
  constructor(ctx: Context, stateRoot: string, private readonly ports: Ports) {
    const path = join(stateRoot, 'verified-delivery.sqlite')
    this.#db = new DatabaseSync(path)
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, intent TEXT NOT NULL, state TEXT NOT NULL, at_ms INTEGER, deadline_ms INTEGER, definition_hash TEXT, result TEXT, notification_state TEXT NOT NULL DEFAULT 'pending')")
    const columns = this.#db.prepare('PRAGMA table_info(deliveries)').all() as Array<{ name: string }>
    if (!columns.some(column => column.name === 'notification_state')) this.#db.exec("ALTER TABLE deliveries ADD COLUMN notification_state TEXT NOT NULL DEFAULT 'pending'")
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600)
    this.#db.prepare("UPDATE deliveries SET state='unknown', result=? WHERE state='executing'").run(JSON.stringify({ reason: 'interrupted-delivery-no-replay' }))
    ctx.inject(['assistantAutomations', 'assistantGoals', 'assistantDelivery', 'assistantPolicy'], runtime => {
      const automations = runtime.assistantAutomations
      this.#automations = automations
      const dispose = automations.registerHostExecutor({
        descriptor: { executorId: verifiedDeliveryOwner, contractVersion: 1, catalogDigest },
        accepts: spec => spec.executorId === verifiedDeliveryOwner && spec.executorContractVersion === 1
          && spec.catalogDigest === catalogDigest && spec.runbookId === 'deliver-verified-artifacts' && spec.runbookVersion === 1,
        execute: input => {
          const pending = this.#execute(input)
          this.#pending.add(pending)
          void pending.finally(() => this.#pending.delete(pending)).catch(() => {})
          return pending
        },
      })
      this.reconcile()
      return () => { dispose(); if (this.#automations === automations) this.#automations = undefined }
    })
    // Completion is emitted after the independent receipt settles. Defer past
    // all Goal projection listeners; startup also reconciles durable intents.
    ctx.on('goal/changed', () => {
      if (this.#queued) return
      this.#queued = true
      queueMicrotask(() => { this.#queued = false; if (this.#active) this.reconcile() })
    })
  }
  #row(id: string): Row | undefined { return this.#db.prepare('SELECT * FROM deliveries WHERE id=?').get(id) as unknown as Row | undefined }
  #public(row: Row) { return { deliveryId: row.id, status: row.state, ...(row.result === null ? {} : { result: JSON.parse(row.result) as unknown }) } }
  get(sessionId: string, grantId: string, idempotencyKey: string, identity?: ActionIdentity) {
    if (!this.#active) throw new Error('assistant-actions: delivery unavailable')
    const row = this.#row(key(sessionId, grantId, idempotencyKey))
    if (row && identity && hash((JSON.parse(row.intent) as DeliveryIntent).security.identity) !== hash(identity)) return undefined
    return row ? this.#public(row) : undefined
  }
  prepare(agent: Agent | undefined, request: VerifiedDeliveryRequest) {
    if (!this.#active || !this.#automations) throw new Error('assistant-actions: verified delivery requires Automations and Goals')
    const security = this.ports.capture(agent, request)
    const id = key(security.sessionId, request.grantId, request.idempotencyKey)
    const intent: DeliveryIntent = { id, request: structuredClone(request), security: structuredClone(security) }
    const existing = this.#row(id)
    if (existing) {
      if (existing.intent !== JSON.stringify(intent)) throw new Error('assistant-actions: delivery key conflict')
      return this.#public(existing)
    }
    const count = this.#db.prepare('SELECT count(*) AS n FROM deliveries').get() as { n: number }
    if (count.n >= 10000) throw new Error('assistant-actions: delivery ledger full')
    this.#db.prepare("INSERT INTO deliveries(id,intent,state) VALUES(?,?,'awaiting-verification')").run(id, JSON.stringify(intent))
    return this.#public(this.#row(id)!)
  }
  #finish(id: string, state: 'failed' | 'succeeded' | 'unknown', result: unknown): void {
    this.#db.prepare("UPDATE deliveries SET state=?,result=?,notification_state='pending' WHERE id=?").run(state, JSON.stringify(result), id)
  }
  reconcile(): void {
    if (!this.#active || !this.#automations) return
    const rows = this.#db.prepare("SELECT * FROM deliveries WHERE state IN ('awaiting-verification','scheduled') LIMIT 10001").all() as unknown as Row[]
    for (const row of rows) {
      try {
        const intent = JSON.parse(row.intent) as DeliveryIntent
        if (Date.now() >= intent.security.expiresAt) { this.#finish(row.id, 'failed', { reason: 'delivery-expired' }); continue }
        let snapshot: VerifiedFiles | undefined
        try { snapshot = this.ports.inspect(intent) } catch { this.#finish(row.id, 'failed', { reason: 'delivery-authority-or-evidence-invalid' }); continue }
        if (!snapshot) continue
        this.#materialize(row, intent, snapshot)
      } catch { this.#failures++ }
    }
    const terminal = this.#db.prepare("SELECT * FROM deliveries WHERE state IN ('succeeded','failed','unknown') AND notification_state='pending' LIMIT 10001").all() as unknown as Row[]
    for (const row of terminal) {
      try { this.#notify(row, JSON.parse(row.intent) as DeliveryIntent) } catch { this.#failures++ }
    }
  }
  #notify(row: Row, intent: DeliveryIntent): void {
    if (row.result === null || Date.now() >= intent.security.expiresAt) return
    const outcome = JSON.parse(row.result) as DeliveryOutcome | { reason?: string }
    this.ports.notify(intent, { idempotencyKey: `verified-delivery-result:${intent.id}`, text: notificationText(row.state, outcome), outcome })
    this.#db.prepare("UPDATE deliveries SET notification_state='enqueued' WHERE id=? AND notification_state='pending'").run(row.id)
  }
  #materialize(row: Row, intent: DeliveryIntent, snapshot: VerifiedFiles): void {
    const automations = this.#automations!
    const at = row.at_ms ?? Date.now()
    const deadline = row.deadline_ms ?? Math.min(intent.security.expiresAt, snapshot.acceptance.validUntil, at + 60000)
    if (deadline <= Date.now() || deadline - at < 1000) { this.#finish(row.id, 'failed', { reason: 'delivery-deadline-unavailable' }); return }
    this.#db.prepare('UPDATE deliveries SET at_ms=?,deadline_ms=? WHERE id=?').run(at, deadline, row.id)
    const security = intent.security
    const definition: HostAutomationDefinition = {
      name: 'Deliver independently verified repository artifacts', schedule: { kind: 'at', at: new Date(at).toISOString() },
      workspace: security.identity.workspace, agentPreset: security.identity.agentPreset, principal: security.principalId,
      timeoutMs: deadline - at, misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
      budgetId: security.budgetId, budgetAmount: 1,
      execution: { kind: 'host', executorId: verifiedDeliveryOwner, executorContractVersion: 1,
        runbookId: 'deliver-verified-artifacts', runbookVersion: 1, catalogDigest,
        targetScope: { workspace: security.identity.workspace, preset: security.identity.agentPreset },
        scopeDigest: '0'.repeat(64), ownerRouteId: security.ownerRouteId, activationNonce: intent.id },
    }
    const prepared = automations.reconcileSystem({ owner: verifiedDeliveryOwner, automationId: intent.id,
      idempotencyKey: `prepare:${intent.id}`, desiredStatus: 'paused', definition })
    const definitionHash = hash(prepared.definition)
    if (row.definition_hash !== null && row.definition_hash !== definitionHash) throw new Error('delivery definition changed')
    this.#db.prepare("UPDATE deliveries SET state='scheduled',definition_hash=? WHERE id=? AND state IN ('scheduled','awaiting-verification')").run(definitionHash, row.id)
    automations.reconcileSystem({ owner: verifiedDeliveryOwner, automationId: intent.id,
      idempotencyKey: `activate:${intent.id}`, desiredStatus: 'active', definition })
  }
  #result(outcome: 'failed' | 'succeeded' | 'unknown', code: string): HostAutomationExecutorResult {
    return { outcome, failureClass: outcome === 'succeeded' ? 'none' : outcome === 'unknown' ? 'unknown' : 'policy',
      failurePhase: outcome === 'succeeded' ? 'none' : 'host-execution', failureCode: outcome === 'succeeded' ? 'none' : code,
      sideEffectState: outcome === 'succeeded' ? 'possible' : outcome === 'unknown' ? 'unknown' : 'none', retryability: outcome === 'failed' ? 'after-intervention' : 'unsafe' }
  }
  async #execute(input: HostAutomationExecutorInput): Promise<HostAutomationExecutorResult> {
    if (!this.#active) return this.#result('failed', 'delivery-unavailable')
    const row = this.#row(input.activationNonce)
    if (!row) return this.#result('failed', 'delivery-identity-denied')
    const intent = JSON.parse(row.intent) as DeliveryIntent, security = intent.security
    if (input.executionMode !== 'production' || input.automationId !== intent.id || input.definitionHash !== row.definition_hash
      || input.catalogDigest !== catalogDigest || input.principal !== security.principalId || input.ownerRouteId !== security.ownerRouteId
      || hash(input.targetScope) !== hash({ workspace: security.identity.workspace, preset: security.identity.agentPreset })) return this.#result('failed', 'delivery-identity-denied')
    if (row.state !== 'scheduled') return this.#result(row.state === 'succeeded' ? 'succeeded' : row.state === 'failed' ? 'failed' : 'unknown', 'delivery-prior-state')
    if (row.deadline_ms === null || row.deadline_ms <= Date.now()) { this.#finish(row.id, 'failed', { reason: 'delivery-expired' }); return this.#result('failed', 'delivery-expired') }
    const signal = AbortSignal.any([input.signal, this.#abort.signal, AbortSignal.timeout(row.deadline_ms - Date.now())])
    try {
      signal.throwIfAborted()
      const snapshot = this.ports.inspect(intent)
      if (!snapshot) throw new Error('acceptance unavailable')
      const changed = this.#db.prepare("UPDATE deliveries SET state='executing' WHERE id=? AND state='scheduled'").run(row.id)
      if (changed.changes !== 1) return this.#result('unknown', 'delivery-prior-state')
      const result = await this.ports.deliver(intent, snapshot, signal)
      const all = [result.commit, ...(result.pullRequest ? [result.pullRequest] : [])]
      const state = signal.aborted || all.some(item => item.status === 'unknown') ? 'unknown'
        : all.every(item => item.status === 'succeeded') ? 'succeeded' : result.commit.status === 'succeeded' ? 'unknown' : 'failed'
      this.#finish(row.id, state, result)
      const finished = this.#row(row.id)!; try { this.#notify(finished, intent) } catch { this.#failures++ }
      return this.#result(state, 'delivery-action-incomplete')
    } catch {
      const state = this.#row(row.id)?.state === 'executing' ? 'unknown' : 'failed'
      this.#finish(row.id, state, { reason: 'delivery-interrupted-or-denied' })
      const finished = this.#row(row.id)!; try { this.#notify(finished, intent) } catch { this.#failures++ }
      return this.#result(state, 'delivery-interrupted-or-denied')
    }
  }
  health() { return { connected: this.#automations !== undefined, reconciliationFailures: this.#failures } }
  async close(): Promise<void> {
    this.#active = false; this.#abort.abort()
    await Promise.allSettled(this.#pending)
    this.#db.close()
  }
}

function notificationText(state: State, outcome: DeliveryOutcome | { reason?: string }): string {
  const commit = 'commit' in outcome ? outcome.commit : undefined
  const pullRequest = 'pullRequest' in outcome ? outcome.pullRequest : undefined
  const lines = [state === 'succeeded' ? '仓库交付已完成。' : state === 'unknown' ? '仓库交付结果待确认。' : '仓库交付未完成。']
  if (commit) lines.push(commit.status === 'succeeded' ? `提交成功${commit.commitOid ? `（Commit: ${commit.commitOid}）` : ''}。` : commit.status === 'unknown' ? '提交结果待确认。' : '提交未完成。')
  if (pullRequest) lines.push(pullRequest.status === 'succeeded' ? `PR 已创建${pullRequest.pullRequestNumber ? `：#${pullRequest.pullRequestNumber}` : ''}。` : pullRequest.status === 'unknown' ? 'PR 结果待确认。' : 'PR 未完成。')
  return lines.join('\n')
}
