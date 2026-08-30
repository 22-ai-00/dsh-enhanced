import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  catalogSelection,
  preferenceCatalog,
  renderCatalogPreference,
  type PreferenceKey,
  type PreferenceRiskTier,
} from './catalog.js'
import { openPreferenceDatabase, preferenceSchemaVersion } from './sqlite.js'
import {
  preferenceActorTrustLevels,
  preferenceInterpretationTrustLevels,
  preferenceRollbackReasons,
  preferenceSignalSources,
  preferenceSignalStances,
} from './types.js'
import type {
  PreferenceActorTrust,
  PreferenceClaimState,
  PreferenceEffectState,
  PreferenceHealth,
  PreferenceHypothesis,
  PreferenceInterpretationTrust,
  PreferenceMaintenanceResult,
  PreferenceRollbackReason,
  PreferenceScope,
  PreferenceSignalInput,
  PreferenceSignalSource,
  PreferenceSignalStance,
  StoredPreferenceSignal,
} from './types.js'

export type PreferenceStoreErrorCode =
  | 'conflict'
  | 'disabled'
  | 'forbidden-tier'
  | 'idempotency-conflict'
  | 'invalid-input'
  | 'not-found'
  | 'not-ready'
  | 'privacy-purge-pending'
  | 'scope-forgotten'

export class PreferenceStoreError extends Error {
  constructor(readonly code: PreferenceStoreErrorCode, message: string) {
    super(message)
    this.name = 'PreferenceStoreError'
  }
}

export interface PreferenceStoreOptions {
  path: string
  now?: () => number
  signalTtlMs: number
  hypothesisTtlMs: number
  minSignalsForActivation: number
  minConfidenceBps: number
  maxContradictionBps: number
  maxActiveOverlays: number
  maxReviewHypotheses: number
  maxOverlayBytes: number
}

export interface PreferenceForgetResult {
  replayed: boolean
  forgottenThrough: number
  deletedSignals: number
  deletedHypotheses: number
}

interface SignalRow {
  id: string
  idempotency_key: string
  payload_hash: string
  scope_key: string
  workspace: string
  preset: string
  preference_key: PreferenceKey
  candidate_value: string
  risk_tier: PreferenceRiskTier
  stance: PreferenceSignalStance
  actor_trust: PreferenceActorTrust
  interpretation_trust: PreferenceInterpretationTrust
  source: PreferenceSignalSource
  occurred_at: number
  recorded_at: number
}

interface HypothesisRow {
  id: string
  scope_key: string
  workspace: string
  preset: string
  preference_key: PreferenceKey
  candidate_value: string
  risk_tier: 'T1' | 'T2'
  claim_state: PreferenceClaimState
  effect_state: PreferenceEffectState
  confidence_bps: number
  contradiction_bps: number
  supporting_signals: number
  contradicting_signals: number
  evidence_mass: number
  expires_at: number
  activated_at: number | null
  rolled_back_at: number | null
  version: number
  created_at: number
  updated_at: number
}

interface TombstoneRow {
  payload_hash: string
  forgotten_through: number
  deleted_signals: number
  deleted_hypotheses: number
}

const actorWeights: Readonly<Record<PreferenceActorTrust, number>> = Object.freeze({
  'owner-authenticated': 400,
  'delegated-authenticated': 250,
  'system-attested': 150,
  unverified: 25,
})

const interpretationWeights: Readonly<Record<PreferenceInterpretationTrust, number>> = Object.freeze({
  'explicit-selection': 400,
  'typed-feedback': 300,
  'behavioral-inference': 100,
  'model-inference': 40,
})

function boundedText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string') throw new PreferenceStoreError('invalid-input', `${label} must be a string`)
  const normalized = value.normalize('NFC').trim()
  if (normalized === '' || Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    throw new PreferenceStoreError('invalid-input', `${label} must contain 1-${maxBytes} UTF-8 bytes`)
  }
  return normalized
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new PreferenceStoreError('invalid-input', `${label} is not an allowed value`)
  }
  return value as T
}

function safeTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PreferenceStoreError('invalid-input', `${label} must be a non-negative safe integer`)
  }
  return value as number
}

export function canonicalPreferenceScope(input: PreferenceScope): {
  scope: PreferenceScope
  scopeKey: string
  scopeDigest: string
} {
  const workspace = boundedText(input.workspace, 'scope.workspace', 4_096)
  if (!isAbsolute(workspace)) throw new PreferenceStoreError('invalid-input', 'scope.workspace must be absolute')
  const scope = Object.freeze({
    workspace: resolve(workspace),
    preset: boundedText(input.preset, 'scope.preset', 200),
  })
  const scopeKey = JSON.stringify([scope.workspace, scope.preset])
  return {
    scope,
    scopeKey,
    scopeDigest: createHash('sha256').update(`preference-scope-v1\0${scopeKey}`).digest('hex'),
  }
}

function payloadHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function signalFromRow(row: SignalRow): StoredPreferenceSignal {
  return Object.freeze({
    id: row.id,
    scope: Object.freeze({ workspace: row.workspace, preset: row.preset }),
    preferenceKey: row.preference_key,
    candidateValue: row.candidate_value,
    riskTier: row.risk_tier,
    stance: row.stance,
    actorTrust: row.actor_trust,
    interpretationTrust: row.interpretation_trust,
    source: row.source,
    occurredAt: row.occurred_at,
    idempotencyKey: row.idempotency_key,
    recordedAt: row.recorded_at,
  })
}

function hypothesisFromRow(row: HypothesisRow): PreferenceHypothesis {
  return Object.freeze({
    id: row.id,
    scope: Object.freeze({ workspace: row.workspace, preset: row.preset }),
    preferenceKey: row.preference_key,
    candidateValue: row.candidate_value,
    riskTier: row.risk_tier,
    claimState: row.claim_state,
    effectState: row.effect_state,
    confidenceBps: row.confidence_bps,
    contradictionBps: row.contradiction_bps,
    supportingSignals: row.supporting_signals,
    contradictingSignals: row.contradicting_signals,
    evidenceMass: row.evidence_mass,
    expiresAt: row.expires_at,
    activatedAt: row.activated_at ?? undefined,
    rolledBackAt: row.rolled_back_at ?? undefined,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function hypothesisId(scopeKey: string, preferenceKey: PreferenceKey, candidateValue: string): string {
  return `pref-hyp-${createHash('sha256')
    .update(`preference-hypothesis-v1\0${scopeKey}\0${preferenceKey}\0${candidateValue}`)
    .digest('hex')}`
}

function assertSignalProvenance(input: {
  source: PreferenceSignalSource
  actorTrust: PreferenceActorTrust
  interpretationTrust: PreferenceInterpretationTrust
}): void {
  if (input.source === 'direct-owner-feedback') {
    if (input.actorTrust !== 'owner-authenticated') {
      throw new PreferenceStoreError('invalid-input', 'direct-owner-feedback requires owner-authenticated actor trust')
    }
    if (!['explicit-selection', 'typed-feedback'].includes(input.interpretationTrust)) {
      throw new PreferenceStoreError('invalid-input', 'direct-owner-feedback requires explicit or typed interpretation')
    }
  }
  if (input.source === 'signed-ui-feedback'
    && !['owner-authenticated', 'delegated-authenticated'].includes(input.actorTrust)) {
    throw new PreferenceStoreError('invalid-input', 'signed-ui-feedback requires authenticated actor trust')
  }
}

/**
 * Only an authenticated owner's explicit, typed feedback can unlock an
 * automatic T1 effect. Lower-trust observations remain useful shadow evidence
 * and contradictions, but no amount of repetition can promote them by itself.
 */
function isActivationEligibleSignal(signal: SignalRow): boolean {
  return signal.actor_trust === 'owner-authenticated'
    && ['explicit-selection', 'typed-feedback'].includes(signal.interpretation_trust)
    && ['direct-owner-feedback', 'signed-ui-feedback'].includes(signal.source)
}

export class PreferenceStore {
  readonly #database: DatabaseSync
  readonly #now: () => number
  readonly #options: Omit<PreferenceStoreOptions, 'path' | 'now'>
  #closed = false

  constructor(options: PreferenceStoreOptions) {
    this.#database = openPreferenceDatabase(options.path)
    this.#now = options.now ?? Date.now
    this.#options = Object.freeze({
      signalTtlMs: options.signalTtlMs,
      hypothesisTtlMs: options.hypothesisTtlMs,
      minSignalsForActivation: options.minSignalsForActivation,
      minConfidenceBps: options.minConfidenceBps,
      maxContradictionBps: options.maxContradictionBps,
      maxActiveOverlays: options.maxActiveOverlays,
      maxReviewHypotheses: options.maxReviewHypotheses,
      maxOverlayBytes: options.maxOverlayBytes,
    })
  }

  appendSignal(input: PreferenceSignalInput): StoredPreferenceSignal {
    return this.appendSignals([input])[0]!
  }

  /** Atomically record one small producer batch and reconcile each affected key once. */
  appendSignals(inputs: readonly PreferenceSignalInput[]): StoredPreferenceSignal[] {
    this.#assertOpen()
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 16) {
      throw new PreferenceStoreError('invalid-input', 'preference signal batch must contain 1-16 entries')
    }
    const now = this.#now()
    const normalizedBatch = inputs.map(input => this.#normalizeSignal(input, now))
    const uniqueIdempotency = new Set(normalizedBatch.map(input => input.idempotencyDigest))
    if (uniqueIdempotency.size !== normalizedBatch.length) {
      throw new PreferenceStoreError('invalid-input', 'preference signal batch contains duplicate idempotency keys')
    }
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const storedSignals: StoredPreferenceSignal[] = []
      const affected = new Map<string, {
        scopeKey: string
        scope: PreferenceScope
        preferenceKey: PreferenceKey
        trigger: SignalRow
      }>()
      for (const normalized of normalizedBatch) {
        const hash = payloadHash(normalized)
        const replay = this.#database.prepare(
          'SELECT * FROM preference_signals WHERE idempotency_key = ?',
        ).get(normalized.idempotencyDigest) as unknown as SignalRow | undefined
        if (replay !== undefined) {
          if (replay.payload_hash !== hash) {
            throw new PreferenceStoreError(
              'idempotency-conflict',
              'preference signal idempotency key was reused with different content',
            )
          }
          storedSignals.push(signalFromRow(replay))
          continue
        }
        const forgottenThrough = this.#forgottenThrough(normalized.scopeDigest)
        if (forgottenThrough !== undefined && normalized.occurredAt <= forgottenThrough) {
          throw new PreferenceStoreError('scope-forgotten', 'signal predates the durable scope forget boundary')
        }
        const id = `pref-sig-${randomUUID()}`
        this.#database.prepare(`
          INSERT INTO preference_signals(
            id, idempotency_key, payload_hash, scope_key, workspace, preset,
            preference_key, candidate_value, risk_tier, stance, actor_trust,
            interpretation_trust, source, occurred_at, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, normalized.idempotencyDigest, hash, normalized.scopeKey,
          normalized.scope.workspace, normalized.scope.preset, normalized.preferenceKey,
          normalized.candidateValue, normalized.riskTier, normalized.stance,
          normalized.actorTrust, normalized.interpretationTrust, normalized.source,
          normalized.occurredAt, now,
        )
        const stored = this.#database.prepare('SELECT * FROM preference_signals WHERE id = ?')
          .get(id) as unknown as SignalRow
        storedSignals.push(signalFromRow(stored))
        if (normalized.riskTier === 'T1' || normalized.riskTier === 'T2') {
          affected.set(`${normalized.scopeKey}\0${normalized.preferenceKey}`, {
            scopeKey: normalized.scopeKey,
            scope: normalized.scope,
            preferenceKey: normalized.preferenceKey,
            trigger: stored,
          })
        }
      }
      for (const entry of affected.values()) {
        this.#reconcileKey(
          entry.scopeKey,
          entry.scope,
          entry.preferenceKey,
          now,
          entry.trigger,
        )
      }
      this.#database.exec('COMMIT')
      return storedSignals
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  list(scopeInput: PreferenceScope, limit = this.#options.maxReviewHypotheses): PreferenceHypothesis[] {
    this.#assertOpen()
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#options.maxReviewHypotheses) {
      throw new PreferenceStoreError(
        'invalid-input',
        `hypothesis limit must be between 1 and ${this.#options.maxReviewHypotheses}`,
      )
    }
    const canonical = canonicalPreferenceScope(scopeInput)
    this.#refreshScope(canonical.scopeKey, canonical.scope, this.#now())
    const rows = this.#database.prepare(`
      SELECT * FROM preference_hypotheses
      WHERE scope_key = ?
      ORDER BY CASE effect_state
        WHEN 'active' THEN 0 WHEN 'shadow' THEN 1 WHEN 'inactive' THEN 2
        WHEN 'suppressed' THEN 3 ELSE 4 END,
        confidence_bps DESC, updated_at DESC, id DESC
      LIMIT ?
    `).all(canonical.scopeKey, limit) as unknown as HypothesisRow[]
    return rows.map(hypothesisFromRow)
  }

  get(scopeInput: PreferenceScope, hypothesisIdInput: string): PreferenceHypothesis | undefined {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(scopeInput)
    const id = boundedText(hypothesisIdInput, 'hypothesisId', 200)
    this.#refreshScope(canonical.scopeKey, canonical.scope, this.#now())
    const row = this.#database.prepare(
      'SELECT * FROM preference_hypotheses WHERE id = ? AND scope_key = ?',
    ).get(id, canonical.scopeKey) as HypothesisRow | undefined
    return row === undefined ? undefined : hypothesisFromRow(row)
  }

  activate(scopeInput: PreferenceScope, hypothesisIdInput: string, expectedVersion: number): PreferenceHypothesis {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(scopeInput)
    const id = boundedText(hypothesisIdInput, 'hypothesisId', 200)
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new PreferenceStoreError('invalid-input', 'expectedVersion must be a positive safe integer')
    }
    const now = this.#now()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#refreshScopeInTransaction(canonical.scopeKey, canonical.scope, now)
      const row = this.#database.prepare(
        'SELECT * FROM preference_hypotheses WHERE id = ? AND scope_key = ?',
      ).get(id, canonical.scopeKey) as HypothesisRow | undefined
      if (row === undefined) throw new PreferenceStoreError('not-found', 'preference hypothesis was not found')
      if (row.version !== expectedVersion) throw new PreferenceStoreError('conflict', 'hypothesis version changed')
      if (row.risk_tier !== 'T1') {
        throw new PreferenceStoreError('forbidden-tier', 'only Host-catalog T1 hypotheses can activate automatically')
      }
      if (row.claim_state !== 'tentative' || row.effect_state !== 'shadow') {
        throw new PreferenceStoreError('not-ready', 'hypothesis is not in an activatable shadow state')
      }
      if (row.expires_at <= now
        || row.supporting_signals < this.#options.minSignalsForActivation
        || row.confidence_bps < this.#options.minConfidenceBps
        || row.contradiction_bps > this.#options.maxContradictionBps) {
        throw new PreferenceStoreError('not-ready', 'hypothesis has insufficient current evidence')
      }
      const latestSelection = this.#latestActivationEligibleSignal(
        canonical.scopeKey,
        row.preference_key,
        now,
      )
      if (latestSelection?.stance !== 'support'
        || latestSelection.candidate_value !== row.candidate_value) {
        throw new PreferenceStoreError('not-ready', 'hypothesis is not the owner\'s latest explicit selection')
      }
      const activeCount = (this.#database.prepare(`
        SELECT COUNT(*) AS count FROM preference_hypotheses
        WHERE scope_key = ? AND effect_state = 'active'
      `).get(canonical.scopeKey) as { count: number }).count
      if (activeCount >= this.#options.maxActiveOverlays) {
        throw new PreferenceStoreError('not-ready', 'scope reached the active preference hard cap')
      }
      const sameKey = this.#database.prepare(`
        SELECT id FROM preference_hypotheses
        WHERE scope_key = ? AND preference_key = ? AND effect_state = 'active'
      `).get(canonical.scopeKey, row.preference_key) as { id: string } | undefined
      if (sameKey !== undefined) throw new PreferenceStoreError('conflict', 'another value for this key is active')
      const nextVersion = row.version + 1
      this.#database.prepare(`
        UPDATE preference_hypotheses
        SET effect_state = 'active', activated_at = ?, updated_at = ?, version = ?
        WHERE id = ? AND version = ?
      `).run(now, now, nextVersion, row.id, row.version)
      this.#transition(row, row.claim_state, 'active', 'activated', nextVersion, now)
      const updated = this.#database.prepare('SELECT * FROM preference_hypotheses WHERE id = ?')
        .get(row.id) as unknown as HypothesisRow
      this.#database.exec('COMMIT')
      return hypothesisFromRow(updated)
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  rollback(
    scopeInput: PreferenceScope,
    hypothesisIdInput: string,
    expectedVersion: number,
    reasonInput: PreferenceRollbackReason,
  ): PreferenceHypothesis {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(scopeInput)
    const id = boundedText(hypothesisIdInput, 'hypothesisId', 200)
    const reason = enumValue(reasonInput, preferenceRollbackReasons, 'reason')
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new PreferenceStoreError('invalid-input', 'expectedVersion must be a positive safe integer')
    }
    const now = this.#now()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.#database.prepare(
        'SELECT * FROM preference_hypotheses WHERE id = ? AND scope_key = ?',
      ).get(id, canonical.scopeKey) as HypothesisRow | undefined
      if (row === undefined) throw new PreferenceStoreError('not-found', 'preference hypothesis was not found')
      if (row.version !== expectedVersion) throw new PreferenceStoreError('conflict', 'hypothesis version changed')
      if (row.effect_state !== 'active' && row.effect_state !== 'shadow') {
        throw new PreferenceStoreError('not-ready', 'only a shadow or active hypothesis can be rolled back')
      }
      const nextVersion = row.version + 1
      this.#database.prepare(`
        UPDATE preference_hypotheses SET
          claim_state = 'rejected', effect_state = 'rolled-back', rolled_back_at = ?, updated_at = ?, version = ?
        WHERE id = ? AND version = ?
      `).run(now, now, nextVersion, row.id, row.version)
      this.#transition(row, 'rejected', 'rolled-back', reason, nextVersion, now)
      const updated = this.#database.prepare('SELECT * FROM preference_hypotheses WHERE id = ?')
        .get(row.id) as unknown as HypothesisRow
      this.#database.exec('COMMIT')
      return hypothesisFromRow(updated)
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  overlay(scopeInput: PreferenceScope): string | undefined {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(scopeInput)
    this.#refreshScope(canonical.scopeKey, canonical.scope, this.#now())
    const rows = this.#database.prepare(`
      SELECT * FROM preference_hypotheses
      WHERE scope_key = ? AND effect_state = 'active' AND risk_tier = 'T1'
      ORDER BY preference_key ASC, id ASC
      LIMIT ?
    `).all(canonical.scopeKey, this.#options.maxActiveOverlays) as unknown as HypothesisRow[]
    if (rows.length === 0) return undefined
    const lines = rows.map(row => `- ${renderCatalogPreference(row.preference_key, row.candidate_value)}`)
    const rendered = [
      '<tentative_preference_overlay>',
      'These low-risk preferences are tentative, scope-local, and subordinate to the current request.',
      ...lines,
      '</tentative_preference_overlay>',
    ].join('\n')
    if (Buffer.byteLength(rendered, 'utf8') > this.#options.maxOverlayBytes) {
      throw new PreferenceStoreError('invalid-input', 'catalog overlay exceeds the configured hard byte cap')
    }
    return rendered
  }

  forgetScope(
    scopeInput: PreferenceScope,
    idempotencyKeyInput: string,
  ): PreferenceForgetResult {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(scopeInput)
    const rawIdempotencyKey = boundedText(idempotencyKeyInput, 'idempotencyKey', 200)
    const idempotencyKey = `pref-forget-idem-${createHash('sha256')
      .update(`preference-forget-idempotency-v1\0${rawIdempotencyKey}`).digest('hex')}`
    const now = this.#now()
    const forgottenThrough = now
    const hash = payloadHash({ scopeDigest: canonical.scopeDigest, idempotencyKey })
    let result: PreferenceForgetResult
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const replay = this.#database.prepare(`
        SELECT payload_hash, forgotten_through, deleted_signals, deleted_hypotheses
        FROM preference_scope_tombstones WHERE idempotency_key = ?
      `).get(idempotencyKey) as unknown as TombstoneRow | undefined
      if (replay !== undefined) {
        if (replay.payload_hash !== hash) {
          throw new PreferenceStoreError('idempotency-conflict', 'forget idempotency key was reused')
        }
        this.#database.exec('COMMIT')
        result = Object.freeze({
          replayed: true,
          forgottenThrough: replay.forgotten_through,
          deletedSignals: replay.deleted_signals,
          deletedHypotheses: replay.deleted_hypotheses,
        })
      } else {
        const hypothesisIds = this.#database.prepare(
          'SELECT id FROM preference_hypotheses WHERE scope_key = ?',
        ).all(canonical.scopeKey) as unknown as Array<{ id: string }>
        for (const entry of hypothesisIds) {
          this.#database.prepare(
            'DELETE FROM preference_transitions WHERE hypothesis_id = ?',
          ).run(entry.id)
        }
        const deletedHypotheses = Number(this.#database.prepare(
          'DELETE FROM preference_hypotheses WHERE scope_key = ?',
        ).run(canonical.scopeKey).changes)
        const deletedSignals = Number(this.#database.prepare(
          'DELETE FROM preference_signals WHERE scope_key = ?',
        ).run(canonical.scopeKey).changes)
        this.#database.prepare(`
          INSERT INTO preference_scope_tombstones(
            id, scope_digest, idempotency_key, payload_hash, forgotten_through,
            recorded_at, deleted_signals, deleted_hypotheses
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `pref-forget-${randomUUID()}`, canonical.scopeDigest, idempotencyKey, hash,
          forgottenThrough, now, deletedSignals, deletedHypotheses,
        )
        this.#database.exec('COMMIT')
        result = Object.freeze({
          replayed: false,
          forgottenThrough,
          deletedSignals,
          deletedHypotheses,
        })
      }
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
    // A logical DELETE is not a privacy boundary while old pages remain in
    // WAL. Secure-delete wipes the database pages; TRUNCATE proves those
    // deletion frames have also been checkpointed before success is reported.
    this.#truncateWalForPrivacy()
    return result
  }

  health(): PreferenceHealth {
    this.#assertOpen()
    const signals = (this.#database.prepare(
      'SELECT COUNT(*) AS count, MAX(recorded_at) AS last FROM preference_signals',
    ).get() as { count: number; last: number | null })
    const hypotheses = this.#database.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN effect_state = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN effect_state = 'shadow' THEN 1 ELSE 0 END) AS shadow,
        SUM(CASE WHEN claim_state = 'proposed' THEN 1 ELSE 0 END) AS proposed,
        SUM(CASE WHEN effect_state = 'rolled-back' THEN 1 ELSE 0 END) AS rolled_back,
        SUM(CASE WHEN claim_state = 'expired' THEN 1 ELSE 0 END) AS expired
      FROM preference_hypotheses
    `).get() as {
      total: number; active: number | null; shadow: number | null; proposed: number | null
      rolled_back: number | null; expired: number | null
    }
    return Object.freeze({
      ready: true,
      enabled: true,
      schemaVersion: preferenceSchemaVersion,
      signals: signals.count,
      hypotheses: hypotheses.total,
      active: hypotheses.active ?? 0,
      shadow: hypotheses.shadow ?? 0,
      proposed: hypotheses.proposed ?? 0,
      rolledBack: hypotheses.rolled_back ?? 0,
      expired: hypotheses.expired ?? 0,
      lastRecordedAt: signals.last ?? undefined,
    })
  }

  /** Delete one bounded batch whose evidence-retention window has elapsed. */
  maintain(limit = 500): PreferenceMaintenanceResult {
    this.#assertOpen()
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
      throw new PreferenceStoreError('invalid-input', 'maintenance limit must be between 1 and 5000')
    }
    const threshold = Math.max(0, this.#now() - this.#options.signalTtlMs)
    let deletedSignals: number
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      deletedSignals = Number(this.#database.prepare(`
        DELETE FROM preference_signals
        WHERE id IN (
          SELECT id FROM preference_signals
          WHERE occurred_at < ?
          ORDER BY occurred_at ASC, id ASC
          LIMIT ?
        )
      `).run(threshold, limit).changes)
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
    // Run this even when the current batch is empty: a previous committed
    // deletion may have reported privacy-purge-pending because a reader held
    // the WAL, and the next maintenance pass must finish that purge.
    this.#truncateWalForPrivacy()
    return Object.freeze({ deletedSignals })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#database.close()
  }

  #normalizeSignal(input: PreferenceSignalInput, now: number) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new PreferenceStoreError('invalid-input', 'preference signal must be an object')
    }
    const canonical = canonicalPreferenceScope(input.scope)
    let selection: ReturnType<typeof catalogSelection>
    try {
      selection = catalogSelection(input.preferenceKey, input.candidateValue)
    } catch (error) {
      throw new PreferenceStoreError('invalid-input', error instanceof Error ? error.message : String(error))
    }
    if (selection.riskTier === 'T3') {
      throw new PreferenceStoreError('forbidden-tier', 'T3 controls are Host-defined and cannot become evidence')
    }
    const occurredAt = safeTimestamp(input.occurredAt, 'occurredAt')
    if (occurredAt > now) {
      throw new PreferenceStoreError('invalid-input', 'occurredAt must not be in the future')
    }
    if (now - occurredAt > this.#options.signalTtlMs) {
      throw new PreferenceStoreError('invalid-input', 'signal is older than the evidence retention window')
    }
    const normalized = {
      ...canonical,
      preferenceKey: selection.key,
      candidateValue: selection.value,
      riskTier: selection.riskTier,
      stance: enumValue(input.stance, preferenceSignalStances, 'stance'),
      actorTrust: enumValue(input.actorTrust, preferenceActorTrustLevels, 'actorTrust'),
      interpretationTrust: enumValue(
        input.interpretationTrust,
        preferenceInterpretationTrustLevels,
        'interpretationTrust',
      ),
      source: enumValue(input.source, preferenceSignalSources, 'source'),
      occurredAt,
      idempotencyDigest: `pref-idem-${createHash('sha256')
        .update(`preference-signal-idempotency-v1\0${boundedText(input.idempotencyKey, 'idempotencyKey', 200)}`)
        .digest('hex')}`,
    }
    assertSignalProvenance(normalized)
    return normalized
  }

  #refreshScope(scopeKey: string, scope: PreferenceScope, now: number): void {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#refreshScopeInTransaction(scopeKey, scope, now)
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  #refreshScopeInTransaction(scopeKey: string, scope: PreferenceScope, now: number): void {
    const keys = this.#database.prepare(`
      SELECT DISTINCT preference_key FROM preference_hypotheses WHERE scope_key = ?
      UNION
      SELECT DISTINCT preference_key FROM preference_signals
      WHERE scope_key = ? AND risk_tier IN ('T1', 'T2')
    `).all(scopeKey, scopeKey) as unknown as Array<{ preference_key: PreferenceKey }>
    for (const { preference_key: key } of keys) this.#reconcileKey(scopeKey, scope, key, now)
  }

  #reconcileKey(
    scopeKey: string,
    scope: PreferenceScope,
    key: PreferenceKey,
    now: number,
    triggerSignal?: SignalRow,
  ): void {
    const signals = this.#database.prepare(`
      SELECT * FROM preference_signals
      WHERE scope_key = ? AND preference_key = ? AND occurred_at >= ?
      ORDER BY occurred_at ASC, id ASC
    `).all(scopeKey, key, Math.max(0, now - this.#options.signalTtlMs)) as unknown as SignalRow[]
    const entry = preferenceCatalog[key]
    if (entry.riskTier !== 'T1' && entry.riskTier !== 'T2') return
    const existing = this.#database.prepare(`
      SELECT * FROM preference_hypotheses WHERE scope_key = ? AND preference_key = ?
    `).all(scopeKey, key) as unknown as HypothesisRow[]
    const latestSelection = this.#latestActivationEligibleSignal(scopeKey, key, now)
    const candidates = new Set(existing.map(row => row.candidate_value))
    for (const signal of signals) if (signal.stance === 'support') candidates.add(signal.candidate_value)

    for (const candidate of candidates) {
      const evidence = this.#evidenceForCandidate(signals, candidate, now)
      const latestSupportingAt = signals.reduce<number | undefined>((latest, signal) => {
        if (signal.stance !== 'support' || signal.candidate_value !== candidate) return latest
        return latest === undefined ? signal.occurred_at : Math.max(latest, signal.occurred_at)
      }, undefined)
      const latestEligibleSupportingAt = signals.reduce<number | undefined>((latest, signal) => {
        if (!isActivationEligibleSignal(signal)
          || signal.stance !== 'support'
          || signal.candidate_value !== candidate) return latest
        return latest === undefined ? signal.occurred_at : Math.max(latest, signal.occurred_at)
      }, undefined)
      const prior = existing.find(row => row.candidate_value === candidate)
      if (prior === undefined) {
        if (latestSupportingAt === undefined) continue
        const expiryAnchor = entry.riskTier === 'T1'
          ? latestEligibleSupportingAt ?? latestSupportingAt
          : latestSupportingAt
        const expiresAt = expiryAnchor + this.#options.hypothesisTtlMs
        const expired = expiresAt <= now
        const claimState: PreferenceClaimState = expired
          ? 'expired'
          : entry.riskTier === 'T2' ? 'proposed' : 'tentative'
        const effectState: PreferenceEffectState = expired
          ? 'inactive'
          : entry.riskTier === 'T2' ? 'inactive' : 'shadow'
        const id = hypothesisId(scopeKey, key, candidate)
        this.#database.prepare(`
          INSERT INTO preference_hypotheses(
            id, scope_key, workspace, preset, preference_key, candidate_value, risk_tier,
            claim_state, effect_state, confidence_bps, contradiction_bps,
            supporting_signals, contradicting_signals, evidence_mass, expires_at,
            activated_at, rolled_back_at, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?)
        `).run(
          id, scopeKey, scope.workspace, scope.preset, key, candidate, entry.riskTier,
          claimState, effectState, evidence.confidenceBps, evidence.contradictionBps,
          evidence.supportingSignals, evidence.contradictingSignals, evidence.mass,
          expiresAt, now, now,
        )
        this.#database.prepare(`
          INSERT INTO preference_transitions(
            hypothesis_id, from_claim_state, to_claim_state, from_effect_state,
            to_effect_state, reason, version, occurred_at
          ) VALUES (?, NULL, ?, NULL, ?, 'created', 1, ?)
        `).run(id, claimState, effectState, now)
        continue
      }
      const expiryAnchor = entry.riskTier === 'T1'
        ? latestEligibleSupportingAt ?? latestSupportingAt
        : latestSupportingAt
      const expiresAt = expiryAnchor === undefined
        ? prior.expires_at
        : expiryAnchor + this.#options.hypothesisTtlMs
      let claimState = prior.claim_state
      let effectState = prior.effect_state
      let activatedAt = prior.activated_at
      let rolledBackAt = prior.rolled_back_at
      let version = prior.version
      let transitionReason: 'evidence-updated' | PreferenceRollbackReason | undefined
      const ownerCorrection = triggerSignal !== undefined
        && latestSelection?.id === triggerSignal.id
        && isActivationEligibleSignal(triggerSignal)
        && ((triggerSignal.stance === 'support' && triggerSignal.candidate_value !== candidate)
          || (triggerSignal.stance === 'contradict' && triggerSignal.candidate_value === candidate))
      const ownerReselected = triggerSignal !== undefined
        && latestSelection?.id === triggerSignal.id
        && isActivationEligibleSignal(triggerSignal)
        && triggerSignal.stance === 'support'
        && triggerSignal.candidate_value === candidate
      if (!['rejected', 'expired'].includes(claimState) && expiresAt <= now) {
        claimState = 'expired'
        effectState = 'inactive'
        version += 1
        transitionReason = 'expired'
      } else if (effectState === 'active' && ownerCorrection) {
        claimState = 'rejected'
        effectState = 'rolled-back'
        rolledBackAt = now
        version += 1
        transitionReason = 'owner-rejected'
      } else if (entry.riskTier === 'T1'
        && ['rejected', 'expired'].includes(claimState)
        && ownerReselected
        && expiresAt > now) {
        claimState = 'tentative'
        effectState = 'shadow'
        activatedAt = null
        rolledBackAt = null
        version += 1
        transitionReason = 'evidence-updated'
      }
      const changed = prior.confidence_bps !== evidence.confidenceBps
        || prior.contradiction_bps !== evidence.contradictionBps
        || prior.supporting_signals !== evidence.supportingSignals
        || prior.contradicting_signals !== evidence.contradictingSignals
        || prior.evidence_mass !== evidence.mass
        || prior.expires_at !== expiresAt
        || prior.claim_state !== claimState
        || prior.effect_state !== effectState
        || prior.activated_at !== activatedAt
        || prior.rolled_back_at !== rolledBackAt
      if (!changed) continue
      if (transitionReason === undefined) {
        version += 1
        transitionReason = 'evidence-updated'
      }
      this.#database.prepare(`
        UPDATE preference_hypotheses SET
          claim_state = ?, effect_state = ?, confidence_bps = ?, contradiction_bps = ?,
          supporting_signals = ?, contradicting_signals = ?, evidence_mass = ?, expires_at = ?,
          activated_at = ?, rolled_back_at = ?, version = ?, updated_at = ?
        WHERE id = ?
      `).run(
        claimState, effectState, evidence.confidenceBps, evidence.contradictionBps,
        evidence.supportingSignals, evidence.contradictingSignals, evidence.mass,
        expiresAt, activatedAt, rolledBackAt, version, now, prior.id,
      )
      this.#transition(prior, claimState, effectState, transitionReason, version, now)
    }
  }

  #evidenceForCandidate(signals: readonly SignalRow[], candidate: string, now: number) {
    let positive = 0
    let negative = 0
    let observedMass = 0
    let supportingSignals = 0
    let contradictingSignals = 0
    for (const signal of signals) {
      const age = Math.max(0, now - signal.occurred_at)
      if (age >= this.#options.signalTtlMs) continue
      const base = Math.floor(
        actorWeights[signal.actor_trust] * interpretationWeights[signal.interpretation_trust] / 100,
      )
      const decayPermille = Math.floor((this.#options.signalTtlMs - age) * 1_000 / this.#options.signalTtlMs)
      const weight = Math.floor(base * decayPermille / 1_000)
      if (weight <= 0) continue
      observedMass += weight
      if (!isActivationEligibleSignal(signal)) continue
      const supports = signal.candidate_value === candidate && signal.stance === 'support'
      const contradicts = (signal.candidate_value === candidate && signal.stance === 'contradict')
        || (signal.candidate_value !== candidate && signal.stance === 'support')
      if (supports) {
        positive += weight
        supportingSignals += 1
      } else if (contradicts) {
        negative += weight
        contradictingSignals += 1
      }
    }
    const decisionMass = positive + negative
    const rawConfidenceBps = decisionMass === 0 ? 0 : Math.floor(positive * 10_000 / decisionMass)
    const coverageTarget = this.#options.minSignalsForActivation * 1_200
    const coverageBps = Math.min(10_000, Math.floor(decisionMass * 10_000 / coverageTarget))
    return {
      mass: observedMass,
      supportingSignals,
      contradictingSignals,
      confidenceBps: Math.floor(rawConfidenceBps * coverageBps / 10_000),
      contradictionBps: decisionMass === 0 ? 0 : Math.floor(negative * 10_000 / decisionMass),
    }
  }

  #latestActivationEligibleSignal(
    scopeKey: string,
    key: PreferenceKey,
    now: number,
  ): SignalRow | undefined {
    return this.#database.prepare(`
      SELECT * FROM preference_signals
      WHERE scope_key = ? AND preference_key = ? AND occurred_at >= ?
        AND actor_trust = 'owner-authenticated'
        AND interpretation_trust IN ('explicit-selection', 'typed-feedback')
        AND source IN ('direct-owner-feedback', 'signed-ui-feedback')
      ORDER BY occurred_at DESC, recorded_at DESC, rowid DESC
      LIMIT 1
    `).get(scopeKey, key, Math.max(0, now - this.#options.signalTtlMs)) as unknown as SignalRow | undefined
  }

  #transition(
    prior: HypothesisRow,
    claimState: PreferenceClaimState,
    effectState: PreferenceEffectState,
    reason: 'activated' | 'evidence-updated' | PreferenceRollbackReason,
    version: number,
    occurredAt: number,
  ): void {
    this.#database.prepare(`
      INSERT INTO preference_transitions(
        hypothesis_id, from_claim_state, to_claim_state, from_effect_state,
        to_effect_state, reason, version, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      prior.id, prior.claim_state, claimState, prior.effect_state, effectState,
      reason, version, occurredAt,
    )
  }

  #forgottenThrough(scopeDigest: string): number | undefined {
    const row = this.#database.prepare(`
      SELECT MAX(forgotten_through) AS forgotten_through
      FROM preference_scope_tombstones WHERE scope_digest = ?
    `).get(scopeDigest) as { forgotten_through: number | null }
    return row.forgotten_through ?? undefined
  }

  #assertOpen(): void {
    if (this.#closed) throw new PreferenceStoreError('disabled', 'preference store is closed')
  }

  #truncateWalForPrivacy(): void {
    try {
      const checkpoint = this.#database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
        busy: number
      }
      if (checkpoint.busy !== 0) {
        throw new PreferenceStoreError(
          'privacy-purge-pending',
          'preference data is logically forgotten but the WAL privacy purge is still busy; retry the exact request',
        )
      }
    } catch (error) {
      if (error instanceof PreferenceStoreError) throw error
      throw new PreferenceStoreError(
        'privacy-purge-pending',
        'preference data is logically forgotten but its WAL privacy purge could not be verified; retry the exact request',
      )
    }
  }
}
