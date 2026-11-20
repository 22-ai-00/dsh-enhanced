import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { buildSharedEntityEdges, extractEntities, type EntityEdgeCandidateNode } from './entities.js'
import { ensureWebLearningSchema, type AssociationStore, type WithdrawalCascadeResult } from './sqlite.js'
import { tokenizeAssociationText } from './tokenize.js'
import {
  normalizeSourceVersion,
  WEB_LEARNING_SOURCE_PLUGIN,
  type AssociationOwnerScope,
  type AssociationWebLearningNormalizedConfig,
  type DerivedRefInput,
  type UpsertEdgeInput,
  type UpsertNodeInput,
} from './types.js'
import { validateWhitelistedWebUrl } from './web-fetch.js'
import {
  extractWebLearningInterests,
  type ExtractedWebInterest,
} from './web-learning-interests.js'
import {
  createInProcessWebLearningRunner,
  createSubprocessWebLearningRunner,
  type SubprocessWebLearningRunnerOptions,
  type WebLearningRunner,
} from './web-learning-runner.js'
import type {
  WebLearningFetchAttempt,
  WebLearningWorkerDeps,
  WebLearningWorkerInput,
  WebLearningWorkerOutput,
} from './web-learning-worker.js'

const MAX_WEB_TITLE_CHARS = 160
const MAX_WEB_BODY_CHARS = 8_192
const MAX_SHARED_ENTITY_EDGES_PER_WEB_NODE = 16

export interface WebLearningPolicyRequest {
  readonly subject: {
    readonly kind: 'background'
    readonly id: 'assistant-association:web-learning'
    readonly workspace: string
    readonly principal: string
  }
  readonly action: 'web.learn'
  readonly resource: {
    readonly kind: 'network'
    readonly id: 'assistant-association:web-learning'
  }
  readonly context: {
    readonly initiator: 'background'
  }
}

export interface WebLearningPolicyDecision {
  readonly effect: 'allow' | 'deny'
  readonly reasonCode?: string
  readonly ruleId?: string | undefined
}

export interface WebLearningPolicyPeer {
  readonly getEmergencyStop?: () => { readonly enabled: boolean }
  readonly getBudgetConfig?: (
    budgetId: string,
  ) =>
    | {
        readonly id: string
        readonly metric: string
        readonly limit: number
        readonly periodMs: number
        readonly scope: string
      }
    | undefined
  readonly evaluate?: (request: WebLearningPolicyRequest) => WebLearningPolicyDecision
  readonly authorize?: (
    request: WebLearningPolicyRequest,
    options?: { readonly idempotencyKey?: string; readonly auditDetails?: unknown },
  ) => WebLearningPolicyDecision
}

export interface WebLearningDeliveryPeer {
  readonly validateOwnerRoute?: (input: {
    readonly authorityId: string
    readonly principalId: string
    readonly workspace: string
    readonly agentPreset: string
  }) => unknown
  readonly inspectOwnerRouteState?: (input: {
    readonly authorityId: string
    readonly principalId: string
    readonly workspace: string
    readonly agentPreset: string
  }) => { readonly status: string } | string
}

export type WebLearningGateDenyReason =
  | 'disabled'
  | 'empty-whitelist'
  | 'emergency-stop'
  | 'interval-not-elapsed'
  | 'agent-active'
  | 'not-idle'
  | 'daily-budget-exhausted'
  | 'route-invalid'
  | 'route-inactive'
  | 'policy-unavailable'
  | 'budget-unavailable'
  | 'budget-exhausted'
  | 'policy-denied'

export interface WebLearningBudgetUsageRow {
  readonly ownerScopeKey: string
  readonly utcDay: string
  readonly requestsUsed: number
  readonly pagesFetched: number
  readonly bytesFetched: number
  readonly updatedAt: number
}

export interface StoredWebLearningRunRow {
  readonly runId: string
  readonly ownerScopeKey: string
  readonly startedAt: number
  readonly finishedAt: number
  readonly status: 'completed' | 'budget-exhausted' | 'skipped' | 'failed'
  readonly reason: string | null
  readonly topicsConsidered: number
  readonly requestsUsed: number
  readonly pagesFetched: number
  readonly bytesFetched: number
  readonly nodesWritten: number
  readonly details: Readonly<Record<string, unknown>> | null
}

export interface StoredWebLearningFetchRow {
  readonly fetchId: string
  readonly ownerScopeKey: string
  readonly runId: string
  readonly canonicalUrl: string
  readonly domain: string
  readonly interestKey: string
  readonly status: string
  readonly bytesFetched: number
  readonly nodeId: string | null
  readonly fetchedAt: number
  readonly expiresAt: number | null
}

export interface WebLearningGateDecision {
  readonly allowed: boolean
  readonly reason: WebLearningGateDenyReason | 'ok'
  readonly policyReasonCode?: string
  readonly utcDay: string
  readonly dailyUsage: WebLearningBudgetUsageRow
  readonly remainingDailyRequests: number
  readonly remainingDailyBytes: number
}

export interface EvaluateWebLearningGateInput {
  readonly db?: DatabaseSync
  readonly store?: AssociationStore
  readonly scope: AssociationOwnerScope
  readonly rootEnabled?: boolean
  readonly config: AssociationWebLearningNormalizedConfig
  readonly policy?: WebLearningPolicyPeer
  readonly delivery?: WebLearningDeliveryPeer
  readonly hasRunningAgent?: boolean
  readonly lastActivityAt?: number | null
  readonly ignoreIdle?: boolean
  readonly nowMs?: number
  readonly requirePolicy?: boolean
}

export interface WebLearningUpsertBatch {
  readonly nodes: readonly UpsertNodeInput[]
  readonly edges: readonly UpsertEdgeInput[]
  readonly derivedRefs: readonly DerivedRefInput[]
}

export interface RunWebLearningPassInput extends EvaluateWebLearningGateInput {
  readonly store: AssociationStore
  readonly runner?: WebLearningRunner
  readonly workerDeps?: WebLearningWorkerDeps
  readonly subprocessOptions?: SubprocessWebLearningRunnerOptions
  readonly signal?: AbortSignal
  readonly enqueueUpsertNodes?: (batch: WebLearningUpsertBatch) => Promise<unknown> | unknown
}

export interface RunWebLearningPassResult {
  readonly ran: boolean
  readonly runId: string | null
  readonly status: 'completed' | 'budget-exhausted' | 'skipped' | 'failed'
  readonly reason: string
  readonly policyReasonCode?: string
  readonly topicsConsidered: number
  readonly requestsUsed: number
  readonly pagesFetched: number
  readonly bytesFetched: number
  readonly nodesWritten: number
  readonly edgesWritten: number
  readonly writtenNodeIds: readonly string[]
  readonly interests: readonly ExtractedWebInterest[]
  readonly fetches: readonly StoredWebLearningFetchRow[]
  readonly dailyUsage: WebLearningBudgetUsageRow
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function asDatabase(storeOrDb: AssociationStore | DatabaseSync): DatabaseSync {
  return 'database' in storeOrDb ? storeOrDb.database : storeOrDb
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { ok: number } | undefined
  return row !== undefined
}

function compactText(raw: string, maxChars: number): string {
  const collapsed = raw.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  if (collapsed.length <= maxChars) return collapsed
  const chars = [...collapsed]
  if (chars.length <= maxChars) return collapsed
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`
}

export function formatUtcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10)
}

export function computeWebNodeId(ownerScopeKey: string, canonicalUrl: string): string {
  const scope8 = ownerScopeKey.slice(0, 8)
  const digest = sha256Hex(`${ownerScopeKey}\0${canonicalUrl}`).slice(0, 20)
  return `a:web-${scope8}-${digest}`
}

export function computeWebSourceRef(canonicalUrl: string): string {
  return canonicalUrl.length <= 512 ? canonicalUrl : `web:${sha256Hex(canonicalUrl)}`
}

export function canonicalizeWebSourceUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  try {
    const parsed = new URL(trimmed)
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return trimmed
  }
}

export function buildWebLearningPolicyRequest(
  scope: AssociationOwnerScope,
): WebLearningPolicyRequest {
  return {
    subject: {
      kind: 'background',
      id: 'assistant-association:web-learning',
      workspace: scope.workspace,
      principal: scope.principalId,
    },
    action: 'web.learn',
    resource: {
      kind: 'network',
      id: 'assistant-association:web-learning',
    },
    context: {
      initiator: 'background',
    },
  }
}

function inferLastScopeActivityAt(db: DatabaseSync, ownerScopeKey: string): number | null {
  let latest: number | null = null

  if (hasTable(db, 'assoc_step_metrics')) {
    const stepRow = db
      .prepare('SELECT MAX(occurred_at) AS ts FROM assoc_step_metrics WHERE owner_scope_key = ?')
      .get(ownerScopeKey) as { ts: number | null } | undefined
    if (typeof stepRow?.ts === 'number' && Number.isFinite(stepRow.ts)) {
      latest = stepRow.ts
    }
  }

  if (hasTable(db, 'assoc_nodes')) {
    const nodeRow = db
      .prepare(`
        SELECT MAX(updated_at) AS ts
        FROM assoc_nodes
        WHERE owner_scope_key = ?
          AND status = 'active'
          AND kind NOT IN ('dream', 'abstraction', 'web')
      `)
      .get(ownerScopeKey) as { ts: number | null } | undefined
    if (typeof nodeRow?.ts === 'number' && Number.isFinite(nodeRow.ts)) {
      latest = latest === null ? nodeRow.ts : Math.max(latest, nodeRow.ts)
    }
  }

  return latest
}

export function getWebLearningBudgetUsage(
  storeOrDb: AssociationStore | DatabaseSync,
  ownerScopeKey: string,
  nowMs = Date.now(),
): WebLearningBudgetUsageRow {
  const db = asDatabase(storeOrDb)
  const utcDay = formatUtcDayKey(nowMs)
  if (!hasTable(db, 'assoc_web_learning_budget_usage')) {
    return {
      ownerScopeKey,
      utcDay,
      requestsUsed: 0,
      pagesFetched: 0,
      bytesFetched: 0,
      updatedAt: 0,
    }
  }

  const row = db
    .prepare(`
      SELECT owner_scope_key, utc_day, requests_used, pages_fetched, bytes_fetched, updated_at
      FROM assoc_web_learning_budget_usage
      WHERE owner_scope_key = ? AND utc_day = ?
    `)
    .get(ownerScopeKey, utcDay) as
    | {
        owner_scope_key: string
        utc_day: string
        requests_used: number
        pages_fetched: number
        bytes_fetched: number
        updated_at: number
      }
    | undefined

  if (row === undefined) {
    return {
      ownerScopeKey,
      utcDay,
      requestsUsed: 0,
      pagesFetched: 0,
      bytesFetched: 0,
      updatedAt: 0,
    }
  }

  return {
    ownerScopeKey: row.owner_scope_key,
    utcDay: row.utc_day,
    requestsUsed: row.requests_used,
    pagesFetched: row.pages_fetched,
    bytesFetched: row.bytes_fetched,
    updatedAt: row.updated_at,
  }
}

export function evaluateWebLearningGate(
  input: EvaluateWebLearningGateInput,
  mode: 'dry-check' | 'execute' = 'dry-check',
  idempotencyKey?: string | (() => string),
): WebLearningGateDecision {
  const db = input.db ?? input.store?.database
  const nowMs = input.nowMs ?? Date.now()
  const utcDay = formatUtcDayKey(nowMs)
  const dailyUsage =
    db !== undefined
      ? getWebLearningBudgetUsage(db, input.scope.ownerScopeKey, nowMs)
      : {
          ownerScopeKey: input.scope.ownerScopeKey,
          utcDay,
          requestsUsed: 0,
          pagesFetched: 0,
          bytesFetched: 0,
          updatedAt: 0,
        }
  const remainingDailyRequests = Math.max(0, input.config.maxRequestsPerDay - dailyUsage.requestsUsed)
  const remainingDailyBytes = Math.max(0, input.config.maxBytesPerDay - dailyUsage.bytesFetched)

  const deny = (
    reason: WebLearningGateDenyReason,
    policyReasonCode?: string,
  ): WebLearningGateDecision => ({
    allowed: false,
    reason,
    ...(policyReasonCode !== undefined ? { policyReasonCode } : {}),
    utcDay,
    dailyUsage,
    remainingDailyRequests,
    remainingDailyBytes,
  })

  // 1. Enabled gate
  if (!(input.rootEnabled ?? true) || !input.config.enabled) {
    return deny('disabled')
  }

  // 2. Non-empty domain whitelist (fail-closed)
  if (input.config.allowedDomains.length === 0) {
    return deny('empty-whitelist')
  }

  // 3. Emergency stop
  if (input.policy?.getEmergencyStop?.()?.enabled === true) {
    return deny('emergency-stop')
  }

  // 4. Interval gate
  if (
    db !== undefined &&
    input.config.intervalMs > 0 &&
    hasTable(db, 'assoc_web_learning_runs')
  ) {
    const row = db
      .prepare(`
        SELECT MAX(finished_at) AS last_finished_at
        FROM assoc_web_learning_runs
        WHERE owner_scope_key = ? AND status IN ('completed', 'budget-exhausted')
      `)
      .get(input.scope.ownerScopeKey) as { last_finished_at: number | null } | undefined
    if (
      typeof row?.last_finished_at === 'number' &&
      Number.isFinite(row.last_finished_at) &&
      nowMs - row.last_finished_at < input.config.intervalMs
    ) {
      return deny('interval-not-elapsed')
    }
  }

  // 5. Idle gate
  if (!input.ignoreIdle && input.config.idleMinMs > 0) {
    if (input.hasRunningAgent === true) {
      return deny('agent-active')
    }
    const lastActivityAt =
      input.lastActivityAt !== undefined
        ? input.lastActivityAt
        : db !== undefined
          ? inferLastScopeActivityAt(db, input.scope.ownerScopeKey)
          : null

    if (
      lastActivityAt === null ||
      !Number.isFinite(lastActivityAt) ||
      nowMs - lastActivityAt < input.config.idleMinMs
    ) {
      return deny('not-idle')
    }
  }

  // 6. Persisted daily budget gate
  if (
    dailyUsage.requestsUsed >= input.config.maxRequestsPerDay ||
    dailyUsage.bytesFetched >= input.config.maxBytesPerDay
  ) {
    return deny('daily-budget-exhausted')
  }

  // 7. Delivery owner route check
  if (input.scope.mode === 'delivery' && input.delivery !== undefined) {
    const authorityId = input.scope.authorityId
    if (typeof input.delivery.validateOwnerRoute === 'function') {
      if (typeof authorityId !== 'string' || authorityId.length === 0) {
        return deny('route-invalid')
      }
      try {
        input.delivery.validateOwnerRoute({
          authorityId,
          principalId: input.scope.principalId,
          workspace: input.scope.workspace,
          agentPreset: input.scope.agentPreset,
        })
      } catch {
        return deny('route-invalid')
      }
    }
    if (typeof input.delivery.inspectOwnerRouteState === 'function') {
      if (typeof authorityId !== 'string' || authorityId.length === 0) {
        return deny('route-invalid')
      }
      try {
        const routeState = input.delivery.inspectOwnerRouteState({
          authorityId,
          principalId: input.scope.principalId,
          workspace: input.scope.workspace,
          agentPreset: input.scope.agentPreset,
        })
        const status = typeof routeState === 'string' ? routeState : routeState?.status
        if (status !== 'active') {
          return deny('route-inactive')
        }
      } catch {
        return deny('route-invalid')
      }
    }
  }

  // 8. Policy availability, Policy budget check, and Policy authorization (last!)
  const requirePolicy = input.requirePolicy ?? true
  if (requirePolicy && input.policy === undefined) {
    return deny('policy-unavailable')
  }

  if (input.config.budgetId !== undefined) {
    if (typeof input.policy?.getBudgetConfig !== 'function') {
      return deny('budget-unavailable')
    }
    const budget = input.policy.getBudgetConfig(input.config.budgetId)
    const requiredAmount = input.config.budgetAmount ?? 1
    if (budget === undefined || !Number.isFinite(budget.limit) || budget.limit <= 0) {
      return deny('budget-unavailable')
    }
    if (budget.limit < requiredAmount) {
      return deny('budget-exhausted')
    }
  }

  if (input.policy !== undefined) {
    const request = buildWebLearningPolicyRequest(input.scope)
    let decision: WebLearningPolicyDecision | undefined
    if (mode === 'execute') {
      if (typeof input.policy.authorize === 'function') {
        const resolvedKey =
          typeof idempotencyKey === 'function' ? idempotencyKey() : idempotencyKey
        const nonEmptyKey =
          resolvedKey !== undefined && resolvedKey.trim().length > 0
            ? resolvedKey
            : `web-learn:${input.scope.ownerScopeKey.slice(0, 12)}:${nowMs}`
        decision = input.policy.authorize(request, { idempotencyKey: nonEmptyKey })
      } else if (typeof input.policy.evaluate === 'function') {
        decision = input.policy.evaluate(request)
      }
    } else {
      if (typeof input.policy.evaluate === 'function') {
        decision = input.policy.evaluate(request)
      } else if (typeof input.policy.authorize === 'function') {
        // Defer side-effectful authorize() until execute mode once targets are confirmed.
        decision = { effect: 'allow' }
      }
    }

    if (decision === undefined) {
      if (requirePolicy) {
        return deny('policy-unavailable')
      }
    } else if (decision.effect !== 'allow') {
      if (decision.reasonCode === 'budget-exhausted') {
        return deny('budget-exhausted', decision.reasonCode)
      }
      return deny('policy-denied', decision.reasonCode)
    }
  }

  return {
    allowed: true,
    reason: 'ok',
    utcDay,
    dailyUsage,
    remainingDailyRequests,
    remainingDailyBytes,
  }
}

function recordRunRow(
  db: DatabaseSync,
  row: {
    readonly runId: string
    readonly ownerScopeKey: string
    readonly startedAt: number
    readonly finishedAt: number
    readonly status: 'completed' | 'budget-exhausted' | 'skipped' | 'failed'
    readonly reason: string | null
    readonly topicsConsidered: number
    readonly requestsUsed: number
    readonly pagesFetched: number
    readonly bytesFetched: number
    readonly nodesWritten: number
    readonly details?: Readonly<Record<string, unknown>>
  },
): void {
  db.prepare(`
    INSERT INTO assoc_web_learning_runs (
      run_id, owner_scope_key, started_at, finished_at, status, reason,
      topics_considered, requests_used, pages_fetched, bytes_fetched,
      nodes_written, details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      finished_at = excluded.finished_at,
      status = excluded.status,
      reason = excluded.reason,
      topics_considered = excluded.topics_considered,
      requests_used = excluded.requests_used,
      pages_fetched = excluded.pages_fetched,
      bytes_fetched = excluded.bytes_fetched,
      nodes_written = excluded.nodes_written,
      details_json = excluded.details_json
  `).run(
    row.runId,
    row.ownerScopeKey,
    row.startedAt,
    row.finishedAt,
    row.status,
    row.reason,
    row.topicsConsidered,
    row.requestsUsed,
    row.pagesFetched,
    row.bytesFetched,
    row.nodesWritten,
    row.details === undefined ? null : JSON.stringify(row.details),
  )
}

function extractDomainSafe(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function buildFetchAttemptRows(
  runId: string,
  ownerScopeKey: string,
  attempts: readonly WebLearningFetchAttempt[],
  writtenNodeByUrl: ReadonlyMap<string, { readonly nodeId: string; readonly expiresAt: number | null }>,
  overrideTimestamp?: number,
): StoredWebLearningFetchRow[] {
  return attempts.map((attempt, index) => {
    const canonical = canonicalizeWebSourceUrl(attempt.finalUrl ?? attempt.url)
    const written = writtenNodeByUrl.get(canonical)
    const fetchedAt = overrideTimestamp ?? attempt.fetchedAt
    return {
      fetchId: `fetch-${sha256Hex(`${runId}\0${index}\0${attempt.url}`).slice(0, 24)}`,
      ownerScopeKey,
      runId,
      canonicalUrl: canonical,
      domain: extractDomainSafe(canonical),
      interestKey: attempt.interestKey,
      status: attempt.ok ? 'ok' : (attempt.rejectionCode ?? 'error'),
      bytesFetched: attempt.bytesFetched,
      nodeId: written?.nodeId ?? null,
      fetchedAt,
      expiresAt: written?.expiresAt ?? null,
    }
  })
}

function mapWorkerStatusToRunStatus(
  workerStatus: WebLearningWorkerOutput['status'],
): 'completed' | 'budget-exhausted' | 'skipped' | 'failed' {
  if (workerStatus === 'completed') return 'completed'
  if (workerStatus === 'budget-exhausted') return 'budget-exhausted'
  if (workerStatus === 'rejected') return 'skipped'
  return 'failed'
}

export async function runWebLearningPass(
  input: RunWebLearningPassInput,
): Promise<RunWebLearningPassResult> {
  const db = input.store.database
  ensureWebLearningSchema(db)
  const nowMs = input.nowMs ?? Date.now()

  let computedRunId: string | null = null
  const getRunId = (): string => {
    if (computedRunId === null) {
      const countRow = db
        .prepare('SELECT COUNT(*) AS cnt FROM assoc_web_learning_runs WHERE owner_scope_key = ?')
        .get(input.scope.ownerScopeKey) as { cnt: number } | undefined
      const ordinal = countRow?.cnt ?? 0
      computedRunId = `web-${sha256Hex(`${input.scope.ownerScopeKey}\0${nowMs}\0${ordinal}`).slice(0, 24)}`
    }
    return computedRunId
  }

  const dryGate = evaluateWebLearningGate(input, 'dry-check')
  if (!dryGate.allowed) {
    const gateStatus =
      dryGate.reason === 'daily-budget-exhausted' || dryGate.reason === 'budget-exhausted'
        ? 'budget-exhausted'
        : 'skipped'
    return {
      ran: false,
      runId: null,
      status: gateStatus,
      reason: dryGate.reason,
      ...(dryGate.policyReasonCode !== undefined
        ? { policyReasonCode: dryGate.policyReasonCode }
        : {}),
      topicsConsidered: 0,
      requestsUsed: 0,
      pagesFetched: 0,
      bytesFetched: 0,
      nodesWritten: 0,
      edgesWritten: 0,
      writtenNodeIds: [],
      interests: [],
      fetches: [],
      dailyUsage: dryGate.dailyUsage,
    }
  }

  if (input.signal?.aborted) {
    return {
      ran: false,
      runId: null,
      status: 'failed',
      reason: 'aborted',
      topicsConsidered: 0,
      requestsUsed: 0,
      pagesFetched: 0,
      bytesFetched: 0,
      nodesWritten: 0,
      edgesWritten: 0,
      writtenNodeIds: [],
      interests: [],
      fetches: [],
      dailyUsage: dryGate.dailyUsage,
    }
  }

  const extracted = extractWebLearningInterests(input.store, input.scope, {
    config: input.config,
    nowMs,
  })

  if (extracted.targets.length === 0) {
    let suppressDuplicateNoTargetsRow = false
    if (input.config.intervalMs > 0) {
      const lastRun = db
        .prepare(`
          SELECT status, reason, finished_at
          FROM assoc_web_learning_runs
          WHERE owner_scope_key = ?
          ORDER BY finished_at DESC, started_at DESC, rowid DESC
          LIMIT 1
        `)
        .get(input.scope.ownerScopeKey) as
        | { status: string; reason: string | null; finished_at: number }
        | undefined
      if (
        lastRun !== undefined &&
        lastRun.status === 'skipped' &&
        lastRun.reason === 'no-targets' &&
        nowMs - lastRun.finished_at < input.config.intervalMs
      ) {
        suppressDuplicateNoTargetsRow = true
      }
    }

    let persistedRunId: string | null = null
    if (!suppressDuplicateNoTargetsRow) {
      persistedRunId = getRunId()
      recordRunRow(db, {
        runId: persistedRunId,
        ownerScopeKey: input.scope.ownerScopeKey,
        startedAt: nowMs,
        finishedAt: nowMs,
        status: 'skipped',
        reason: 'no-targets',
        topicsConsidered: extracted.interests.length,
        requestsUsed: 0,
        pagesFetched: 0,
        bytesFetched: 0,
        nodesWritten: 0,
        details: {
          skippedCooldownCount: extracted.skippedCooldownCount,
          rejectedSeedUrls: extracted.rejectedSeedUrls,
        },
      })
    }

    return {
      ran: false,
      runId: persistedRunId,
      status: 'skipped',
      reason: 'no-targets',
      topicsConsidered: extracted.interests.length,
      requestsUsed: 0,
      pagesFetched: 0,
      bytesFetched: 0,
      nodesWritten: 0,
      edgesWritten: 0,
      writtenNodeIds: [],
      interests: extracted.interests,
      fetches: [],
      dailyUsage: dryGate.dailyUsage,
    }
  }

  const runId = getRunId()
  const gate = evaluateWebLearningGate(input, 'execute', () => `web-learn:${runId}`)
  if (!gate.allowed) {
    const gateStatus =
      gate.reason === 'daily-budget-exhausted' || gate.reason === 'budget-exhausted'
        ? 'budget-exhausted'
        : 'skipped'
    return {
      ran: false,
      runId: null,
      status: gateStatus,
      reason: gate.reason,
      ...(gate.policyReasonCode !== undefined ? { policyReasonCode: gate.policyReasonCode } : {}),
      topicsConsidered: extracted.interests.length,
      requestsUsed: 0,
      pagesFetched: 0,
      bytesFetched: 0,
      nodesWritten: 0,
      edgesWritten: 0,
      writtenNodeIds: [],
      interests: extracted.interests,
      fetches: [],
      dailyUsage: gate.dailyUsage,
    }
  }

  if (input.signal?.aborted) {
    return {
      ran: false,
      runId,
      status: 'failed',
      reason: 'aborted',
      topicsConsidered: extracted.interests.length,
      requestsUsed: 0,
      pagesFetched: 0,
      bytesFetched: 0,
      nodesWritten: 0,
      edgesWritten: 0,
      writtenNodeIds: [],
      interests: extracted.interests,
      fetches: [],
      dailyUsage: gate.dailyUsage,
    }
  }

  const effectiveMaxRequests = Math.min(input.config.maxRequestsPerRun, gate.remainingDailyRequests)
  const effectiveMaxTotalBytes = Math.min(input.config.maxTotalBytesPerRun, gate.remainingDailyBytes)

  const plan: WebLearningWorkerInput = {
    runId,
    allowedDomains: input.config.allowedDomains,
    allowSubdomains: input.config.allowSubdomains,
    allowIpv6: input.config.allowIpv6,
    targets: extracted.targets,
    budget: {
      maxRequests: effectiveMaxRequests,
      maxPages: input.config.maxPagesPerRun,
      maxBytesPerRequest: input.config.maxBytesPerRequest,
      maxTotalBytes: effectiveMaxTotalBytes,
      maxDurationMs: input.config.maxDurationMs,
      requestTimeoutMs: input.config.requestTimeoutMs,
      maxRedirects: input.config.maxRedirects,
    },
  }

  const runner: WebLearningRunner =
    input.runner !== undefined
      ? input.runner
      : input.config.isolationMode === 'in-process'
        ? createInProcessWebLearningRunner({
            ...input.workerDeps,
            ...(input.nowMs !== undefined && input.workerDeps?.now === undefined
              ? { now: () => nowMs }
              : {}),
          })
        : createSubprocessWebLearningRunner(input.subprocessOptions)

  let output: WebLearningWorkerOutput
  try {
    output = await runner.run(plan, input.signal)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const reason = input.signal?.aborted ? 'aborted' : 'runner-error'
    recordRunRow(db, {
      runId,
      ownerScopeKey: input.scope.ownerScopeKey,
      startedAt: nowMs,
      finishedAt: Math.max(nowMs, Date.now()),
      status: 'failed',
      reason,
      topicsConsidered: extracted.interests.length,
      requestsUsed: 0,
      pagesFetched: 0,
      bytesFetched: 0,
      nodesWritten: 0,
      details: { error: message },
    })
    return {
      ran: false,
      runId,
      status: 'failed',
      reason,
      topicsConsidered: extracted.interests.length,
      requestsUsed: 0,
      pagesFetched: 0,
      bytesFetched: 0,
      nodesWritten: 0,
      edgesWritten: 0,
      writtenNodeIds: [],
      interests: extracted.interests,
      fetches: [],
      dailyUsage: gate.dailyUsage,
    }
  }

  if (input.signal?.aborted || output.status === 'aborted') {
    const abortedFinishedAt = input.nowMs !== undefined ? nowMs : Math.max(nowMs, output.finishedAt)
    input.store.runInTransaction(() => {
      if (output.requestsUsed > 0 || output.bytesFetched > 0) {
        db.prepare(`
          INSERT INTO assoc_web_learning_budget_usage (
            owner_scope_key, utc_day, requests_used, pages_fetched, bytes_fetched, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(owner_scope_key, utc_day) DO UPDATE SET
            requests_used = assoc_web_learning_budget_usage.requests_used + excluded.requests_used,
            pages_fetched = assoc_web_learning_budget_usage.pages_fetched + excluded.pages_fetched,
            bytes_fetched = assoc_web_learning_budget_usage.bytes_fetched + excluded.bytes_fetched,
            updated_at = excluded.updated_at
        `).run(
          input.scope.ownerScopeKey,
          gate.utcDay,
          output.requestsUsed,
          output.pagesFetched,
          output.bytesFetched,
          abortedFinishedAt,
        )
      }
      recordRunRow(db, {
        runId,
        ownerScopeKey: input.scope.ownerScopeKey,
        startedAt: nowMs,
        finishedAt: abortedFinishedAt,
        status: 'failed',
        reason: 'aborted',
        topicsConsidered: extracted.interests.length,
        requestsUsed: output.requestsUsed,
        pagesFetched: output.pagesFetched,
        bytesFetched: output.bytesFetched,
        nodesWritten: 0,
        details: { reason: output.reason },
      })
    })
    return {
      ran: false,
      runId,
      status: 'failed',
      reason: 'aborted',
      topicsConsidered: extracted.interests.length,
      requestsUsed: output.requestsUsed,
      pagesFetched: output.pagesFetched,
      bytesFetched: output.bytesFetched,
      nodesWritten: 0,
      edgesWritten: 0,
      writtenNodeIds: [],
      interests: extracted.interests,
      fetches: [],
      dailyUsage: getWebLearningBudgetUsage(db, input.scope.ownerScopeKey, nowMs),
    }
  }

  // Build trust:'low' 'web' nodes + entity edges with bidirectional assoc_derived_from
  const overrideFetchedAt =
    input.nowMs !== undefined && input.workerDeps?.now === undefined ? nowMs : undefined
  const scopePeers = input.store.loadEntityCandidateNodesForScope(input.scope.ownerScopeKey, 256)
  const workingPeers: EntityEdgeCandidateNode[] = [...scopePeers]

  const nodesToWrite: UpsertNodeInput[] = []
  const edgesToWrite: UpsertEdgeInput[] = []
  const derivedRefsToWrite: DerivedRefInput[] = []
  const seenEdgeIds = new Set<string>()
  const writtenNodeByUrl = new Map<string, { readonly nodeId: string; readonly expiresAt: number | null }>()

  for (const page of output.pages) {
    let canonicalUrl: string
    try {
      canonicalUrl = validateWhitelistedWebUrl(page.finalUrl || page.sourceUrl, {
        allowedDomains: input.config.allowedDomains,
        allowSubdomains: input.config.allowSubdomains,
      }).canonicalUrl
    } catch {
      continue
    }

    const sourceRef = computeWebSourceRef(canonicalUrl)
    if (input.store.isSourceWithdrawn(input.scope.ownerScopeKey, WEB_LEARNING_SOURCE_PLUGIN, sourceRef)) {
      continue
    }

    const fetchedAt = overrideFetchedAt ?? page.fetchedAt
    const ttlMs = input.config.nodeTtlMs > 0 ? input.config.nodeTtlMs : null
    const expiresAt = ttlMs !== null ? fetchedAt + ttlMs : null
    const nodeId = computeWebNodeId(input.scope.ownerScopeKey, canonicalUrl)
    const title = compactText(page.title || canonicalUrl, MAX_WEB_TITLE_CHARS)
    const body = compactText(page.text || title, MAX_WEB_BODY_CHARS)
    const combined = `${title}\n${body}`
    const entities = extractEntities(combined)
    const tokens = tokenizeAssociationText(combined)
    const sourceVersion = normalizeSourceVersion(page.contentDigest.slice(0, 16) || fetchedAt)

    const node: UpsertNodeInput = {
      id: nodeId,
      kind: 'web',
      sourcePlugin: WEB_LEARNING_SOURCE_PLUGIN,
      sourceRef,
      sourceVersion,
      ownerScopeKey: input.scope.ownerScopeKey,
      ownerMode: input.scope.mode,
      principalDigest: input.scope.principalDigest,
      principalRecordId: input.scope.mode === 'delivery' ? input.scope.principalRecordId : null,
      principalVersion: input.scope.mode === 'delivery' ? input.scope.principalVersion : null,
      scopeMode: 'workspace',
      workspace: input.scope.workspace,
      agentPreset: input.scope.agentPreset,
      trust: 'low',
      sensitivity: 'private',
      title,
      body,
      entities,
      tokens,
      metadata: {
        sourceUrl: canonicalUrl,
        fetchedAt,
        extra: {
          fetchedAtIso: new Date(fetchedAt).toISOString(),
          contentDigest: page.contentDigest,
          contentType: page.contentType,
          interestKey: page.interestKey,
          runId,
          originNodeIds: [...page.originNodeIds],
        },
      },
      ttlMs,
      expiresAt,
      status: 'active',
      createdAt: fetchedAt,
      updatedAt: fetchedAt,
    }

    nodesToWrite.push(node)
    writtenNodeByUrl.set(canonicalUrl, { nodeId, expiresAt })

    const edgeResult = buildSharedEntityEdges(
      {
        id: node.id,
        sourceVersion: node.sourceVersion,
        ownerScopeKey: node.ownerScopeKey,
        trust: 'low',
        entities: node.entities,
        updatedAt: fetchedAt,
      },
      workingPeers,
      {
        maxEdgesPerNode: MAX_SHARED_ENTITY_EDGES_PER_WEB_NODE,
        nowMs: fetchedAt,
      },
    )

    for (const edge of edgeResult.edges) {
      if (!seenEdgeIds.has(edge.edgeId)) {
        seenEdgeIds.add(edge.edgeId)
        edgesToWrite.push(edge)
      }
    }
    derivedRefsToWrite.push(...edgeResult.derivedRefs)

    workingPeers.push({
      id: node.id,
      sourceVersion: node.sourceVersion,
      ownerScopeKey: node.ownerScopeKey,
      trust: 'low',
      entities: node.entities,
      updatedAt: fetchedAt,
    })
  }

  if (nodesToWrite.length > 0 || edgesToWrite.length > 0 || derivedRefsToWrite.length > 0) {
    const batch: WebLearningUpsertBatch = {
      nodes: nodesToWrite,
      edges: edgesToWrite,
      derivedRefs: derivedRefsToWrite,
    }
    if (input.enqueueUpsertNodes !== undefined) {
      await input.enqueueUpsertNodes(batch)
    } else {
      input.store.upsertBatch(batch)
    }
  }

  const fetchRows = buildFetchAttemptRows(
    runId,
    input.scope.ownerScopeKey,
    output.attempts,
    writtenNodeByUrl,
    overrideFetchedAt,
  )
  const finishedAt = input.nowMs !== undefined ? nowMs : Math.max(nowMs, output.finishedAt)
  const runStatus = mapWorkerStatusToRunStatus(output.status)

  input.store.runInTransaction(() => {
    if (fetchRows.length > 0) {
      const insertFetchStmt = db.prepare(`
        INSERT INTO assoc_web_learning_fetches (
          fetch_id, owner_scope_key, run_id, canonical_url, domain,
          interest_key, status, bytes_fetched, node_id, fetched_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(fetch_id) DO UPDATE SET
          status = excluded.status,
          bytes_fetched = excluded.bytes_fetched,
          node_id = excluded.node_id,
          fetched_at = excluded.fetched_at,
          expires_at = excluded.expires_at
      `)
      for (const f of fetchRows) {
        insertFetchStmt.run(
          f.fetchId,
          f.ownerScopeKey,
          f.runId,
          f.canonicalUrl,
          f.domain,
          f.interestKey,
          f.status,
          f.bytesFetched,
          f.nodeId,
          f.fetchedAt,
          f.expiresAt,
        )
      }
    }

    db.prepare(`
      INSERT INTO assoc_web_learning_budget_usage (
        owner_scope_key, utc_day, requests_used, pages_fetched, bytes_fetched, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_scope_key, utc_day) DO UPDATE SET
        requests_used = assoc_web_learning_budget_usage.requests_used + excluded.requests_used,
        pages_fetched = assoc_web_learning_budget_usage.pages_fetched + excluded.pages_fetched,
        bytes_fetched = assoc_web_learning_budget_usage.bytes_fetched + excluded.bytes_fetched,
        updated_at = excluded.updated_at
    `).run(
      input.scope.ownerScopeKey,
      gate.utcDay,
      output.requestsUsed,
      output.pagesFetched,
      output.bytesFetched,
      finishedAt,
    )

    recordRunRow(db, {
      runId,
      ownerScopeKey: input.scope.ownerScopeKey,
      startedAt: nowMs,
      finishedAt,
      status: runStatus,
      reason: output.reason,
      topicsConsidered: extracted.interests.length,
      requestsUsed: output.requestsUsed,
      pagesFetched: output.pagesFetched,
      bytesFetched: output.bytesFetched,
      nodesWritten: nodesToWrite.length,
      details: {
        workerStatus: output.status,
        interestKeys: extracted.interests.map((item) => item.interestKey),
        rejectedSeedUrls: extracted.rejectedSeedUrls,
      },
    })
  })

  const updatedUsage = getWebLearningBudgetUsage(db, input.scope.ownerScopeKey, nowMs)

  return {
    ran: true,
    runId,
    status: runStatus,
    reason: output.reason,
    topicsConsidered: extracted.interests.length,
    requestsUsed: output.requestsUsed,
    pagesFetched: output.pagesFetched,
    bytesFetched: output.bytesFetched,
    nodesWritten: nodesToWrite.length,
    edgesWritten: edgesToWrite.length,
    writtenNodeIds: nodesToWrite.map((node) => node.id),
    interests: extracted.interests,
    fetches: fetchRows,
    dailyUsage: updatedUsage,
  }
}

export function listWebLearningRuns(
  storeOrDb: AssociationStore | DatabaseSync,
  ownerScopeKey: string,
  limit = 20,
): readonly StoredWebLearningRunRow[] {
  const db = asDatabase(storeOrDb)
  if (!hasTable(db, 'assoc_web_learning_runs')) return []
  const rows = db
    .prepare(`
      SELECT run_id, owner_scope_key, started_at, finished_at, status, reason,
             topics_considered, requests_used, pages_fetched, bytes_fetched,
             nodes_written, details_json
      FROM assoc_web_learning_runs
      WHERE owner_scope_key = ?
      ORDER BY started_at DESC, run_id ASC
      LIMIT ?
    `)
    .all(ownerScopeKey, Math.max(1, Math.min(200, Math.floor(limit)))) as Array<{
    run_id: string
    owner_scope_key: string
    started_at: number
    finished_at: number
    status: 'completed' | 'budget-exhausted' | 'skipped' | 'failed'
    reason: string | null
    topics_considered: number
    requests_used: number
    pages_fetched: number
    bytes_fetched: number
    nodes_written: number
    details_json: string | null
  }>

  return rows.map((row) => {
    let details: Readonly<Record<string, unknown>> | null = null
    if (row.details_json !== null) {
      try {
        const parsed = JSON.parse(row.details_json) as unknown
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          details = parsed as Record<string, unknown>
        }
      } catch {
        details = null
      }
    }
    return {
      runId: row.run_id,
      ownerScopeKey: row.owner_scope_key,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      status: row.status,
      reason: row.reason,
      topicsConsidered: row.topics_considered,
      requestsUsed: row.requests_used,
      pagesFetched: row.pages_fetched,
      bytesFetched: row.bytes_fetched,
      nodesWritten: row.nodes_written,
      details,
    }
  })
}

export function listWebLearningFetches(
  storeOrDb: AssociationStore | DatabaseSync,
  ownerScopeKey: string,
  limit = 50,
): readonly StoredWebLearningFetchRow[] {
  const db = asDatabase(storeOrDb)
  if (!hasTable(db, 'assoc_web_learning_fetches')) return []
  const rows = db
    .prepare(`
      SELECT fetch_id, owner_scope_key, run_id, canonical_url, domain,
             interest_key, status, bytes_fetched, node_id, fetched_at, expires_at
      FROM assoc_web_learning_fetches
      WHERE owner_scope_key = ?
      ORDER BY fetched_at DESC, fetch_id ASC
      LIMIT ?
    `)
    .all(ownerScopeKey, Math.max(1, Math.min(500, Math.floor(limit)))) as Array<{
    fetch_id: string
    owner_scope_key: string
    run_id: string
    canonical_url: string
    domain: string
    interest_key: string
    status: string
    bytes_fetched: number
    node_id: string | null
    fetched_at: number
    expires_at: number | null
  }>

  return rows.map((row) => ({
    fetchId: row.fetch_id,
    ownerScopeKey: row.owner_scope_key,
    runId: row.run_id,
    canonicalUrl: row.canonical_url,
    domain: row.domain,
    interestKey: row.interest_key,
    status: row.status,
    bytesFetched: row.bytes_fetched,
    nodeId: row.node_id,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
  }))
}

export function withdrawWebSourceByUrl(
  store: AssociationStore,
  scope: Pick<AssociationOwnerScope, 'ownerScopeKey'>,
  sourceUrl: string,
  nowMs = Date.now(),
): WithdrawalCascadeResult {
  const canonicalUrl = canonicalizeWebSourceUrl(sourceUrl)
  const sourceRef = computeWebSourceRef(canonicalUrl)
  return store.withdrawSource({
    ownerScopeKey: scope.ownerScopeKey,
    sourcePlugin: WEB_LEARNING_SOURCE_PLUGIN,
    sourceRef,
    hardDelete: true,
    recordWithdrawalTombstone: true,
    nowMs,
  })
}
