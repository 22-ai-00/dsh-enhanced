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
  | 'learning-paused'
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
  minBehavioralSignalsForActivation?: number
  minConfidenceBps: number
  maxContradictionBps: number
  maxActiveOverlays: number
  maxReviewHypotheses: number
  maxOverlayBytes: number
}

export interface PreferenceForgetResult {
  applied: boolean
  replayed: boolean
  forgottenThrough: number
  deletedSignals: number
  deletedHypotheses: number
  state?: PreferenceScopeLearningStatus
}

export interface PreferenceHostMaintenanceResult extends PreferenceMaintenanceResult {
  replayed: boolean
  ownerGeneration: number
  principalLineageId: string
  principalLineageVersion: number
}

/** Content-minimal durable result for one exact Host activation step. */
export interface PreferenceHostActivationResult {
  hypothesisId: string
  expectedVersion: number
  resultVersion: number
  ownerGeneration: number
  principalLineageId: string
  principalLineageVersion: number
  replayed: boolean
}

export interface PreferenceOverlaySnapshot {
  text: string | undefined
  hypotheses: readonly PreferenceHypothesis[]
  ownerFence?: PreferenceScopePrincipalFence
}

export interface PreferenceExactCorrectionInput {
  signalIndex: number
  sourceInboxId: string
  replyOutboxId: string
}

export interface PreferenceScopePrincipalFence {
  scopeKey: string
  principalDigest: string
  principalLineageId: string
  principalLineageVersion: number
  generation: number
}

/** Durable total order minted by Delivery when an Inbox is admitted. */
export interface PreferenceAdmissionCursor {
  epoch: string
  sequence: number
}

export interface PreferenceScopePrincipalResult extends PreferenceScopePrincipalFence {
  accepted: boolean
  reset: boolean
}

export interface PreferencePrincipalLineage {
  principalRecordId: string
  principalVersion: number
}

export interface PreferenceScopeLearningStatus {
  mode: 'active' | 'paused'
  signals: number
  hypotheses: number
  activeOverlays: number
  storedActiveOverlays: number
  shadowHypotheses: number
  controlVersion: number
  admissionHighWater: Readonly<PreferenceAdmissionCursor> | undefined
  ignoreEventsThrough: Readonly<PreferenceAdmissionCursor> | undefined
}

export interface PreferenceScopeLearningControlResult {
  applied: boolean
  replayed: boolean
  state: PreferenceScopeLearningStatus
}

export interface PreferenceScopeLearningExplanation {
  key: PreferenceKey
  value: string
  state: PreferenceEffectState
  version: number
  supportingSignals: number
  contradictingSignals: number
  evidenceMass: number
}

export interface PreferenceScopeLearningExplainResult extends PreferenceScopeLearningControlResult {
  explanation: readonly Readonly<PreferenceScopeLearningExplanation>[]
}

export interface PreferenceScopeLearningExportResult extends PreferenceScopeLearningControlResult {
  records: readonly Readonly<PreferenceScopeLearningExplanation>[]
}

export interface PreferenceScopeLearningRollbackResult extends PreferenceScopeLearningControlResult {
  rolledBack: boolean
  rolledBackVersion?: number
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

interface HostActivationReceiptRow {
  payload_hash: string
  scope_digest: string
  hypothesis_id: string
  expected_version: number
  result_version: number
  owner_generation: number | null
  principal_lineage_id: string | null
  principal_lineage_version: number | null
}

interface OwnerControlReceiptRow {
  payload_hash: string
  action: 'explain' | 'export' | 'forget' | 'pause' | 'resume' | 'rollback' | 'status'
  target_preference_key: string | null
  admission_cursor_epoch: string
  admission_cursor_sequence: number
  result_applied: number
  result_paused: number
  result_control_version: number
  result_admission_high_water: number | null
  result_ignore_events_through_sequence: number | null
  result_signals: number
  result_hypotheses: number
  result_active_overlays: number
  result_stored_active_overlays: number
  result_shadow_hypotheses: number
  result_deleted_signals: number
  result_deleted_hypotheses: number
  result_forgotten_through: number
  result_explanation_json: string | null
  result_rolled_back: number
  result_rolled_back_version: number | null
}

interface ScopeAdmissionRow {
  admission_cursor_epoch: string | null
  lineage_claim_sequence: number | null
  admission_high_water: number | null
  admission_high_water_kind: 'control' | 'event' | null
  ignore_events_through_sequence: number | null
  learning_paused: number
  control_version: number
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

export function canonicalPreferenceAdmissionCursor(
  value: Readonly<PreferenceAdmissionCursor>,
): Readonly<PreferenceAdmissionCursor> {
  if (typeof value !== 'object' || value === null) {
    throw new PreferenceStoreError('invalid-input', 'admission cursor is invalid')
  }
  const epoch = boundedText(value.epoch, 'admissionCursor.epoch', 32)
  if (!/^[0-9a-f]{32}$/u.test(epoch)) {
    throw new PreferenceStoreError(
      'invalid-input',
      'admissionCursor.epoch must be a 32-character lowercase hexadecimal identifier',
    )
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new PreferenceStoreError(
      'invalid-input',
      'admissionCursor.sequence must be a positive safe integer',
    )
  }
  return Object.freeze({ epoch, sequence: value.sequence })
}

function preferencePrincipalDigest(value: unknown): string {
  const principalId = boundedText(value, 'principalId', 500)
  return createHash('sha256')
    .update('preference-scope-principal-v1\0')
    .update(principalId)
    .digest('hex')
}

function canonicalPreferencePrincipalLineage(
  value: Readonly<PreferencePrincipalLineage>,
): Readonly<PreferencePrincipalLineage> {
  if (typeof value !== 'object' || value === null) {
    throw new PreferenceStoreError('invalid-input', 'principal lineage is invalid')
  }
  const principalRecordId = boundedText(value.principalRecordId, 'principalRecordId', 500)
  if (!Number.isSafeInteger(value.principalVersion) || value.principalVersion < 1) {
    throw new PreferenceStoreError('invalid-input', 'principalVersion must be a positive safe integer')
  }
  return Object.freeze({ principalRecordId, principalVersion: value.principalVersion })
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

function exactT1PreferenceKey(value: unknown): PreferenceKey {
  if (typeof value !== 'string' || !Object.hasOwn(preferenceCatalog, value)) {
    throw new PreferenceStoreError('invalid-input', 'preferenceKey is not an exact Host catalog key')
  }
  const key = value as PreferenceKey
  if (preferenceCatalog[key].riskTier !== 'T1') {
    throw new PreferenceStoreError('forbidden-tier', 'owner rollback only accepts Host catalog T1 keys')
  }
  return key
}

function explanationFromRow(row: HypothesisRow): Readonly<PreferenceScopeLearningExplanation> {
  const key = exactT1PreferenceKey(row.preference_key)
  try {
    catalogSelection(key, row.candidate_value)
  } catch {
    throw new PreferenceStoreError('conflict', 'T1 explanation row is outside the Host catalog')
  }
  return Object.freeze({
    key,
    value: row.candidate_value,
    state: row.effect_state,
    version: row.version,
    supportingSignals: row.supporting_signals,
    contradictingSignals: row.contradicting_signals,
    evidenceMass: row.evidence_mass,
  })
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
  if (input.source === 'delivery-observation' && input.actorTrust === 'owner-authenticated'
    && input.interpretationTrust !== 'behavioral-inference') {
    throw new PreferenceStoreError(
      'invalid-input',
      'owner delivery-observation requires behavioral interpretation',
    )
  }
}

/**
 * Only Delivery-attested owner evidence can unlock an automatic T1 effect.
 * Behavioral evidence is limited to the private completed-turn lane; the
 * public observation surface is always system-attested and remains ineligible.
 */
function isActivationEligibleSignal(signal: SignalRow): boolean {
  return signal.actor_trust === 'owner-authenticated'
    && ((['explicit-selection', 'typed-feedback'].includes(signal.interpretation_trust)
      && ['direct-owner-feedback', 'signed-ui-feedback'].includes(signal.source))
      || (signal.interpretation_trust === 'behavioral-inference'
        && signal.source === 'delivery-observation'))
}

export class PreferenceStore {
  readonly #database: DatabaseSync
  readonly #now: () => number
  readonly #options: Required<Omit<PreferenceStoreOptions, 'path' | 'now'>>
  #closed = false

  constructor(options: PreferenceStoreOptions) {
    this.#database = openPreferenceDatabase(options.path)
    this.#now = options.now ?? Date.now
    this.#options = Object.freeze({
      signalTtlMs: options.signalTtlMs,
      hypothesisTtlMs: options.hypothesisTtlMs,
      minSignalsForActivation: options.minSignalsForActivation,
      minBehavioralSignalsForActivation: options.minBehavioralSignalsForActivation ?? 6,
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

  /**
   * Monotonic content-free owner fence for a Delivery scope. A delayed event
   * from an older principal is acknowledged as ignored instead of reclaiming
   * the scope after a newer owner has started using it.
   */
  ensureScopePrincipal(
    scopeInput: PreferenceScope,
    principalIdInput: string,
    occurredAtInput: number,
    lineageInput: Readonly<PreferencePrincipalLineage>,
    admissionCursorInput: Readonly<PreferenceAdmissionCursor>,
  ): PreferenceScopePrincipalResult {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(scopeInput)
    const principalDigest = preferencePrincipalDigest(principalIdInput)
    const occurredAt = safeTimestamp(occurredAtInput, 'occurredAt')
    const lineage = canonicalPreferencePrincipalLineage(lineageInput)
    const admissionCursor = canonicalPreferenceAdmissionCursor(admissionCursorInput)
    const now = this.#now()
    let result: PreferenceScopePrincipalResult
    let purgeGeneration: number | undefined
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#database.prepare(`
        SELECT principal_digest, principal_lineage_id, principal_lineage_version,
          generation, claimed_at, purge_pending, admission_cursor_epoch,
          lineage_claim_sequence, admission_high_water, learning_paused, paused_at
        FROM preference_scope_principals WHERE scope_key = ?
      `).get(canonical.scopeKey) as {
        principal_digest: string
        principal_lineage_id: string | null
        principal_lineage_version: number | null
        generation: number
        claimed_at: number
        purge_pending: number
        admission_cursor_epoch: string | null
        lineage_claim_sequence: number | null
        admission_high_water: number | null
        learning_paused: number
        paused_at: number | null
      } | undefined
      if (current !== undefined && current.principal_digest === principalDigest
        && current.principal_lineage_id === lineage.principalRecordId
        && current.principal_lineage_version === lineage.principalVersion
        && current.admission_cursor_epoch === admissionCursor.epoch) {
        purgeGeneration = current.purge_pending === 1 ? current.generation : undefined
        result = Object.freeze({
          accepted: true,
          scopeKey: canonical.scopeKey,
          principalDigest,
          principalLineageId: lineage.principalRecordId,
          principalLineageVersion: lineage.principalVersion,
          generation: current.generation,
          reset: false,
        })
      } else if (current !== undefined && current.admission_cursor_epoch === null) {
        // Schema v5 had no owner-row lineage and schema v6 had no durable Inbox
        // order. Neither can prove that its evidence predates a pause/forget or
        // belongs to this exact Delivery instance. The first v7 claim is always
        // a privacy reset, even when the external principal and lineage happen
        // to match.
        const preservePaused = current.principal_digest === principalDigest
          && current.principal_lineage_id === lineage.principalRecordId
          && current.principal_lineage_version === lineage.principalVersion
          && current.learning_paused === 1
        this.#deleteScopeDataInTransaction(canonical.scopeKey, canonical.scopeDigest)
        const generation = current.generation + 1
        const changed = this.#database.prepare(`
          UPDATE preference_scope_principals
          SET scope_digest = ?, principal_digest = ?, generation = ?, claimed_at = ?, updated_at = ?,
            principal_lineage_id = ?, principal_lineage_version = ?,
            purge_pending = 1,
            learning_paused = ?, paused_at = ?,
            control_version = control_version + 1, ignore_events_through = -1,
            admission_cursor_epoch = ?, lineage_claim_sequence = ?,
            admission_high_water = NULL, admission_high_water_kind = NULL,
            ignore_events_through_sequence = NULL
          WHERE scope_key = ? AND generation = ? AND admission_cursor_epoch IS NULL
        `).run(
          canonical.scopeDigest,
          principalDigest,
          generation,
          occurredAt,
          now,
          lineage.principalRecordId,
          lineage.principalVersion,
          preservePaused ? 1 : 0,
          preservePaused ? current.paused_at : null,
          admissionCursor.epoch,
          admissionCursor.sequence,
          canonical.scopeKey,
          current.generation,
        )
        if (changed.changes !== 1) {
          throw new PreferenceStoreError('conflict', 'legacy scope principal adoption lost its generation')
        }
        purgeGeneration = generation
        result = Object.freeze({
          accepted: true,
          scopeKey: canonical.scopeKey,
          principalDigest,
          principalLineageId: lineage.principalRecordId,
          principalLineageVersion: lineage.principalVersion,
          generation,
          reset: true,
        })
      } else if (current !== undefined
        && current.principal_digest === principalDigest
        && current.principal_lineage_id === lineage.principalRecordId
        && current.principal_lineage_version === lineage.principalVersion) {
        // An epoch change for one exact lineage is impossible in the Delivery
        // contract. Never sort opaque epochs or silently rebind it.
        result = Object.freeze({
          accepted: false,
          scopeKey: canonical.scopeKey,
          principalDigest: current.principal_digest,
          principalLineageId: current.principal_lineage_id ?? 'legacy-owner-lineage',
          principalLineageVersion: current.principal_lineage_version ?? 1,
          generation: current.generation,
          reset: false,
        })
      } else if (current !== undefined
        && current.admission_cursor_epoch === admissionCursor.epoch
        && admissionCursor.sequence <= Math.max(
          current.lineage_claim_sequence ?? 0,
          current.admission_high_water ?? 0,
        )) {
        result = Object.freeze({
          accepted: false,
          scopeKey: canonical.scopeKey,
          principalDigest: current.principal_digest,
          principalLineageId: current.principal_lineage_id ?? 'legacy-owner-lineage',
          principalLineageVersion: current.principal_lineage_version ?? 1,
          generation: current.generation,
          reset: false,
        })
      } else {
        this.#deleteScopeDataInTransaction(canonical.scopeKey, canonical.scopeDigest)
        const generation = (current?.generation ?? 0) + 1
        if (current === undefined) {
          this.#database.prepare(`
            INSERT INTO preference_scope_principals(
              scope_key, scope_digest, principal_digest, generation,
              claimed_at, purge_pending, updated_at,
              principal_lineage_id, principal_lineage_version,
              learning_paused, paused_at, control_version, ignore_events_through,
              admission_cursor_epoch, lineage_claim_sequence,
              admission_high_water, admission_high_water_kind,
              ignore_events_through_sequence
            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 0, NULL, 1, -1, ?, ?, NULL, NULL, NULL)
          `).run(
            canonical.scopeKey,
            canonical.scopeDigest,
            principalDigest,
            generation,
            occurredAt,
            now,
            lineage.principalRecordId,
            lineage.principalVersion,
            admissionCursor.epoch,
            admissionCursor.sequence,
          )
        } else {
          this.#database.prepare(`
            UPDATE preference_scope_principals
            SET scope_digest = ?, principal_digest = ?, generation = ?,
              claimed_at = ?, purge_pending = 1, updated_at = ?,
              principal_lineage_id = ?, principal_lineage_version = ?,
              learning_paused = 0, paused_at = NULL,
              control_version = control_version + 1, ignore_events_through = -1,
              admission_cursor_epoch = ?, lineage_claim_sequence = ?,
              admission_high_water = NULL, admission_high_water_kind = NULL,
              ignore_events_through_sequence = NULL
            WHERE scope_key = ? AND generation = ? AND principal_digest = ?
          `).run(
            canonical.scopeDigest,
            principalDigest,
            generation,
            occurredAt,
            now,
            lineage.principalRecordId,
            lineage.principalVersion,
            admissionCursor.epoch,
            admissionCursor.sequence,
            canonical.scopeKey,
            current.generation,
            current.principal_digest,
          )
        }
        purgeGeneration = generation
        result = Object.freeze({
          accepted: true,
          scopeKey: canonical.scopeKey,
          principalDigest,
          principalLineageId: lineage.principalRecordId,
          principalLineageVersion: lineage.principalVersion,
          generation,
          reset: current !== undefined,
        })
      }
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
    if (purgeGeneration !== undefined) {
      this.#truncateWalForPrivacy()
      this.#database.exec('BEGIN IMMEDIATE')
      try {
        const cleared = this.#database.prepare(`
          UPDATE preference_scope_principals
          SET purge_pending = 0, updated_at = ?
          WHERE scope_key = ? AND principal_digest = ? AND generation = ? AND purge_pending = 1
        `).run(now, canonical.scopeKey, principalDigest, purgeGeneration)
        if (cleared.changes !== 1) {
          throw new PreferenceStoreError('conflict', 'scope principal purge lost its exact generation')
        }
        this.#database.exec('COMMIT')
      } catch (error) {
        this.#database.exec('ROLLBACK')
        throw error
      }
    }
    return result
  }

  scopePrincipalMatches(scopeInput: PreferenceScope, principalIdInput: string): boolean {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(scopeInput)
    const principalDigest = preferencePrincipalDigest(principalIdInput)
    return this.#database.prepare(`
      SELECT 1 AS present FROM preference_scope_principals
      WHERE scope_key = ? AND principal_digest = ? AND purge_pending = 0
        AND admission_cursor_epoch IS NOT NULL
    `).get(canonical.scopeKey, principalDigest) !== undefined
  }

  scopePrincipalFence(
    scopeInput: PreferenceScope,
    principalIdInput: string,
    lineageInput: Readonly<PreferencePrincipalLineage>,
    expectedGeneration?: number,
  ): PreferenceScopePrincipalFence | undefined {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(scopeInput)
    const principalDigest = preferencePrincipalDigest(principalIdInput)
    const lineage = canonicalPreferencePrincipalLineage(lineageInput)
    if (expectedGeneration !== undefined
      && (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1)) {
      throw new PreferenceStoreError('invalid-input', 'expected owner generation is invalid')
    }
    const row = this.#database.prepare(`
      SELECT generation FROM preference_scope_principals
      WHERE scope_key = ? AND principal_digest = ?
        AND principal_lineage_id = ? AND principal_lineage_version = ?
        AND purge_pending = 0 AND admission_cursor_epoch IS NOT NULL
    `).get(
      canonical.scopeKey,
      principalDigest,
      lineage.principalRecordId,
      lineage.principalVersion,
    ) as { generation: number } | undefined
    if (row === undefined || (expectedGeneration !== undefined && row.generation !== expectedGeneration)) {
      return undefined
    }
    return Object.freeze({
      scopeKey: canonical.scopeKey,
      principalDigest,
      principalLineageId: lineage.principalRecordId,
      principalLineageVersion: lineage.principalVersion,
      generation: row.generation,
    })
  }

  scopeLearningStatus(
    scopeInput: PreferenceScope,
    owner: Readonly<PreferenceScopePrincipalFence>,
  ): PreferenceScopeLearningStatus {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(scopeInput)
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const status = this.#scopeLearningStatusInTransaction(canonical, owner)
      this.#database.exec('COMMIT')
      return status
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  scopeAcceptsEvent(
    scopeInput: PreferenceScope,
    owner: Readonly<PreferenceScopePrincipalFence>,
    admissionCursorInput: Readonly<PreferenceAdmissionCursor>,
  ): boolean {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(scopeInput)
    const admissionCursor = canonicalPreferenceAdmissionCursor(admissionCursorInput)
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const accepted = this.#admitEventCursorInTransaction(canonical, owner, admissionCursor)
      this.#database.exec('COMMIT')
      return accepted
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  setScopeLearningPaused(
    scopeInput: PreferenceScope,
    owner: Readonly<PreferenceScopePrincipalFence>,
    paused: boolean,
    admissionCursorInput: Readonly<PreferenceAdmissionCursor>,
    occurredAtInput: number,
    idempotencyKeyInput: string,
  ): PreferenceScopeLearningControlResult {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(scopeInput)
    const occurredAt = safeTimestamp(occurredAtInput, 'occurredAt')
    const admissionCursor = canonicalPreferenceAdmissionCursor(admissionCursorInput)
    const rawIdempotencyKey = boundedText(idempotencyKeyInput, 'idempotencyKey', 500)
    const idempotencyKey = `pref-owner-control-${createHash('sha256')
      .update(`preference-owner-control-idempotency-v1\0${rawIdempotencyKey}`).digest('hex')}`
    const action = paused ? 'pause' : 'resume'
    const hash = payloadHash({
      scopeDigest: canonical.scopeDigest,
      principalDigest: owner.principalDigest,
      principalLineageId: owner.principalLineageId,
      principalLineageVersion: owner.principalLineageVersion,
      generation: owner.generation,
      action,
      admissionCursor,
    })
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#assertScopePrincipalInTransaction(canonical, owner)
      const replay = this.#database.prepare(`
        SELECT * FROM preference_owner_control_receipts
        WHERE idempotency_key = ?
      `).get(idempotencyKey) as unknown as OwnerControlReceiptRow | undefined
      if (replay !== undefined) {
        if (replay.payload_hash !== hash) {
          throw new PreferenceStoreError(
            'idempotency-conflict',
            'learning control idempotency key was reused',
          )
        }
        const state = this.#ownerControlStateFromReceipt(replay)
        this.#database.exec('COMMIT')
        return Object.freeze({ applied: replay.result_applied === 1, replayed: true, state })
      }
      const current = this.#database.prepare(`
        SELECT admission_cursor_epoch, lineage_claim_sequence,
          admission_high_water, admission_high_water_kind,
          ignore_events_through_sequence, learning_paused, control_version
        FROM preference_scope_principals WHERE scope_key = ?
      `).get(canonical.scopeKey) as unknown as ScopeAdmissionRow
      const fresh = this.#controlCursorIsFresh(current, admissionCursor)
      const controlVersion = fresh ? current.control_version + 1 : current.control_version
      const ignoreEventsThroughSequence = fresh
        ? Math.max(current.ignore_events_through_sequence ?? 0, admissionCursor.sequence)
        : current.ignore_events_through_sequence
      if (fresh) {
        const changed = this.#database.prepare(`
          UPDATE preference_scope_principals
          SET learning_paused = ?, paused_at = ?, control_version = ?,
            ignore_events_through = MAX(ignore_events_through, ?),
            ignore_events_through_sequence = ?, admission_high_water = ?,
            admission_high_water_kind = 'control', updated_at = ?
          WHERE scope_key = ? AND principal_digest = ?
            AND principal_lineage_id = ? AND principal_lineage_version = ?
            AND generation = ? AND purge_pending = 0
            AND admission_cursor_epoch = ? AND admission_high_water IS ?
        `).run(
          paused ? 1 : 0,
          paused ? occurredAt : null,
          controlVersion,
          occurredAt,
          ignoreEventsThroughSequence,
          admissionCursor.sequence,
          this.#now(),
          canonical.scopeKey,
          owner.principalDigest,
          owner.principalLineageId,
          owner.principalLineageVersion,
          owner.generation,
          admissionCursor.epoch,
          current.admission_high_water,
        )
        if (changed.changes !== 1) {
          throw new PreferenceStoreError('conflict', 'learning control owner cursor changed')
        }
      }
      const state = this.#scopeLearningStatusInTransaction(canonical, owner, false)
      this.#insertOwnerControlReceipt({
        idempotencyKey,
        hash,
        canonical,
        owner,
        action,
        admissionCursor,
        applied: fresh,
        state,
        occurredAt,
      })
      this.#database.exec('COMMIT')
      return Object.freeze({ applied: fresh, replayed: false, state })
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  recordScopeLearningStatus(
    scopeInput: PreferenceScope,
    owner: Readonly<PreferenceScopePrincipalFence>,
    admissionCursorInput: Readonly<PreferenceAdmissionCursor>,
    occurredAtInput: number,
    idempotencyKeyInput: string,
  ): PreferenceScopeLearningControlResult {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(scopeInput)
    const admissionCursor = canonicalPreferenceAdmissionCursor(admissionCursorInput)
    const occurredAt = safeTimestamp(occurredAtInput, 'occurredAt')
    const rawIdempotencyKey = boundedText(idempotencyKeyInput, 'idempotencyKey', 500)
    const idempotencyKey = `pref-owner-control-${createHash('sha256')
      .update(`preference-owner-control-idempotency-v1\0${rawIdempotencyKey}`).digest('hex')}`
    const hash = payloadHash({
      scopeDigest: canonical.scopeDigest,
      principalDigest: owner.principalDigest,
      principalLineageId: owner.principalLineageId,
      principalLineageVersion: owner.principalLineageVersion,
      generation: owner.generation,
      action: 'status',
      admissionCursor,
    })
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#assertScopePrincipalInTransaction(canonical, owner)
      const replay = this.#database.prepare(`
        SELECT * FROM preference_owner_control_receipts WHERE idempotency_key = ?
      `).get(idempotencyKey) as unknown as OwnerControlReceiptRow | undefined
      if (replay !== undefined) {
        if (replay.payload_hash !== hash) {
          throw new PreferenceStoreError('idempotency-conflict', 'learning control idempotency key was reused')
        }
        const state = this.#ownerControlStateFromReceipt(replay)
        this.#database.exec('COMMIT')
        return Object.freeze({ applied: replay.result_applied === 1, replayed: true, state })
      }
      const current = this.#scopeAdmissionRowInTransaction(canonical.scopeKey)
      if (!this.#readCursorCanObserveCurrent(current, admissionCursor)) {
        const state = this.#scopeLearningStatusInTransaction(canonical, owner, false)
        this.#database.exec('COMMIT')
        return Object.freeze({ applied: false, replayed: false, state })
      }
      // Status is an authenticated read, not an ordering barrier. Advancing
      // the admission high-water here could discard an older Agent turn that
      // was already running but had not yet committed its projection.
      const state = this.#scopeLearningStatusInTransaction(canonical, owner, false)
      this.#insertOwnerControlReceipt({
        idempotencyKey,
        hash,
        canonical,
        owner,
        action: 'status',
        admissionCursor,
        applied: true,
        state,
        occurredAt,
      })
      this.#database.exec('COMMIT')
      return Object.freeze({ applied: true, replayed: false, state })
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  /** Receipt-backed, content-free T1 ledger view for one exact owner lineage. */
  explainScopeLearning(
    scopeInput: PreferenceScope,
    owner: Readonly<PreferenceScopePrincipalFence>,
    admissionCursorInput: Readonly<PreferenceAdmissionCursor>,
    occurredAtInput: number,
    idempotencyKeyInput: string,
  ): PreferenceScopeLearningExplainResult {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(scopeInput)
    const admissionCursor = canonicalPreferenceAdmissionCursor(admissionCursorInput)
    const occurredAt = safeTimestamp(occurredAtInput, 'occurredAt')
    const rawIdempotencyKey = boundedText(idempotencyKeyInput, 'idempotencyKey', 500)
    const idempotencyKey = `pref-owner-control-${createHash('sha256')
      .update(`preference-owner-control-idempotency-v1\0${rawIdempotencyKey}`).digest('hex')}`
    const hash = payloadHash({
      scopeDigest: canonical.scopeDigest,
      principalDigest: owner.principalDigest,
      principalLineageId: owner.principalLineageId,
      principalLineageVersion: owner.principalLineageVersion,
      generation: owner.generation,
      action: 'explain',
      admissionCursor,
    })
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#assertScopePrincipalInTransaction(canonical, owner)
      const replay = this.#database.prepare(`
        SELECT * FROM preference_owner_control_receipts WHERE idempotency_key = ?
      `).get(idempotencyKey) as unknown as OwnerControlReceiptRow | undefined
      if (replay !== undefined) {
        if (replay.payload_hash !== hash || replay.action !== 'explain') {
          throw new PreferenceStoreError('idempotency-conflict', 'learning explain idempotency key was reused')
        }
        const explanation = this.#ownerControlExplanationFromReceipt(replay)
        const state = this.#ownerControlStateFromReceipt(replay)
        this.#database.exec('COMMIT')
        return Object.freeze({ applied: replay.result_applied === 1, replayed: true, state, explanation })
      }
      const current = this.#scopeAdmissionRowInTransaction(canonical.scopeKey)
      if (!this.#readCursorCanObserveCurrent(current, admissionCursor)) {
        const state = this.#scopeLearningStatusInTransaction(canonical, owner, false)
        this.#database.exec('COMMIT')
        return Object.freeze({ applied: false, replayed: false, state, explanation: Object.freeze([]) })
      }
      // Deliberately do not refresh/reconcile hypotheses here. Explain is a
      // ledger read and must not advance cursors or mutate preference state.
      const rows = this.#database.prepare(`
        SELECT * FROM preference_hypotheses
        WHERE scope_key = ? AND risk_tier = 'T1'
        ORDER BY preference_key ASC, candidate_value ASC, id ASC
      `).all(canonical.scopeKey) as unknown as HypothesisRow[]
      const explanation = Object.freeze(rows.map(explanationFromRow))
      const state = this.#scopeLearningStatusInTransaction(canonical, owner, false)
      this.#insertOwnerControlReceipt({
        idempotencyKey,
        hash,
        canonical,
        owner,
        action: 'explain',
        admissionCursor,
        applied: true,
        state,
        explanation,
        occurredAt,
      })
      this.#database.exec('COMMIT')
      return Object.freeze({ applied: true, replayed: false, state, explanation })
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  /** Receipt-backed, stable export snapshot for the exact current owner scope. */
  exportScopeLearning(
    scopeInput: PreferenceScope,
    owner: Readonly<PreferenceScopePrincipalFence>,
    admissionCursorInput: Readonly<PreferenceAdmissionCursor>,
    occurredAtInput: number,
    idempotencyKeyInput: string,
  ): PreferenceScopeLearningExportResult {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(scopeInput)
    const admissionCursor = canonicalPreferenceAdmissionCursor(admissionCursorInput)
    const occurredAt = safeTimestamp(occurredAtInput, 'occurredAt')
    const rawIdempotencyKey = boundedText(idempotencyKeyInput, 'idempotencyKey', 500)
    const idempotencyKey = `pref-owner-control-${createHash('sha256')
      .update(`preference-owner-control-idempotency-v1\0${rawIdempotencyKey}`).digest('hex')}`
    const hash = payloadHash({
      scopeDigest: canonical.scopeDigest,
      principalDigest: owner.principalDigest,
      principalLineageId: owner.principalLineageId,
      principalLineageVersion: owner.principalLineageVersion,
      generation: owner.generation,
      action: 'export',
      format: 'dsh-preference-learning',
      version: 1,
      admissionCursor,
    })
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#assertScopePrincipalInTransaction(canonical, owner)
      const replay = this.#database.prepare(`
        SELECT * FROM preference_owner_control_receipts WHERE idempotency_key = ?
      `).get(idempotencyKey) as unknown as OwnerControlReceiptRow | undefined
      if (replay !== undefined) {
        if (replay.payload_hash !== hash || replay.action !== 'export') {
          throw new PreferenceStoreError('idempotency-conflict', 'learning export idempotency key was reused')
        }
        const records = this.#ownerControlExplanationFromReceipt(replay)
        const state = this.#ownerControlStateFromReceipt(replay)
        this.#database.exec('COMMIT')
        return Object.freeze({ applied: replay.result_applied === 1, replayed: true, state, records })
      }
      const current = this.#scopeAdmissionRowInTransaction(canonical.scopeKey)
      if (!this.#readCursorCanObserveCurrent(current, admissionCursor)) {
        const state = this.#scopeLearningStatusInTransaction(canonical, owner, false)
        this.#database.exec('COMMIT')
        return Object.freeze({ applied: false, replayed: false, state, records: Object.freeze([]) })
      }
      // Like explain, export is a ledger read. It neither reconciles state nor
      // advances the admission high-water for already-running earlier turns.
      const rows = this.#database.prepare(`
        SELECT * FROM preference_hypotheses
        WHERE scope_key = ? AND risk_tier = 'T1'
        ORDER BY preference_key ASC, candidate_value ASC, id ASC
      `).all(canonical.scopeKey) as unknown as HypothesisRow[]
      const records = Object.freeze(rows.map(explanationFromRow))
      const state = this.#scopeLearningStatusInTransaction(canonical, owner, false)
      this.#insertOwnerControlReceipt({
        idempotencyKey,
        hash,
        canonical,
        owner,
        action: 'export',
        admissionCursor,
        applied: true,
        state,
        explanation: records,
        occurredAt,
      })
      this.#database.exec('COMMIT')
      return Object.freeze({ applied: true, replayed: false, state, records })
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  /** Atomically fence older projections and CAS-roll back the active value for one T1 key. */
  rollbackScopeLearningKey(
    scopeInput: PreferenceScope,
    owner: Readonly<PreferenceScopePrincipalFence>,
    preferenceKeyInput: unknown,
    admissionCursorInput: Readonly<PreferenceAdmissionCursor>,
    occurredAtInput: number,
    idempotencyKeyInput: string,
  ): PreferenceScopeLearningRollbackResult {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(scopeInput)
    const preferenceKey = exactT1PreferenceKey(preferenceKeyInput)
    const admissionCursor = canonicalPreferenceAdmissionCursor(admissionCursorInput)
    const occurredAt = safeTimestamp(occurredAtInput, 'occurredAt')
    const rawIdempotencyKey = boundedText(idempotencyKeyInput, 'idempotencyKey', 500)
    const idempotencyKey = `pref-owner-control-${createHash('sha256')
      .update(`preference-owner-control-idempotency-v1\0${rawIdempotencyKey}`).digest('hex')}`
    const hash = payloadHash({
      scopeDigest: canonical.scopeDigest,
      principalDigest: owner.principalDigest,
      principalLineageId: owner.principalLineageId,
      principalLineageVersion: owner.principalLineageVersion,
      generation: owner.generation,
      action: 'rollback',
      preferenceKey,
      admissionCursor,
    })
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#assertScopePrincipalInTransaction(canonical, owner)
      const replay = this.#database.prepare(`
        SELECT * FROM preference_owner_control_receipts WHERE idempotency_key = ?
      `).get(idempotencyKey) as unknown as OwnerControlReceiptRow | undefined
      if (replay !== undefined) {
        if (replay.payload_hash !== hash || replay.action !== 'rollback'
          || replay.target_preference_key !== preferenceKey) {
          throw new PreferenceStoreError('idempotency-conflict', 'learning rollback idempotency key was reused')
        }
        const state = this.#ownerControlStateFromReceipt(replay)
        this.#database.exec('COMMIT')
        return Object.freeze({
          applied: replay.result_applied === 1,
          replayed: true,
          state,
          rolledBack: replay.result_rolled_back === 1,
          ...(replay.result_rolled_back_version === null
            ? {}
            : { rolledBackVersion: replay.result_rolled_back_version }),
        })
      }
      const current = this.#scopeAdmissionRowInTransaction(canonical.scopeKey)
      const fresh = this.#controlCursorIsFresh(current, admissionCursor)
      let rolledBack = false
      let rolledBackVersion: number | undefined
      if (fresh) {
        const active = this.#database.prepare(`
          SELECT * FROM preference_hypotheses
          WHERE scope_key = ? AND preference_key = ?
            AND risk_tier = 'T1' AND effect_state = 'active'
        `).get(canonical.scopeKey, preferenceKey) as HypothesisRow | undefined
        if (active !== undefined) {
          rolledBackVersion = active.version + 1
          const changed = this.#database.prepare(`
            UPDATE preference_hypotheses SET
              claim_state = 'rejected', effect_state = 'rolled-back',
              rolled_back_at = ?, updated_at = ?, version = ?
            WHERE id = ? AND scope_key = ? AND preference_key = ?
              AND version = ? AND effect_state = 'active'
          `).run(
            occurredAt,
            occurredAt,
            rolledBackVersion,
            active.id,
            canonical.scopeKey,
            preferenceKey,
            active.version,
          )
          if (changed.changes !== 1) {
            throw new PreferenceStoreError('conflict', 'learning rollback hypothesis CAS lost')
          }
          this.#transition(
            active,
            'rejected',
            'rolled-back',
            'owner-rejected',
            rolledBackVersion,
            occurredAt,
          )
          rolledBack = true
        }
        const controlVersion = current.control_version + 1
        const ignoreEventsThroughSequence = Math.max(
          current.ignore_events_through_sequence ?? 0,
          admissionCursor.sequence,
        )
        const changed = this.#database.prepare(`
          UPDATE preference_scope_principals
          SET control_version = ?, ignore_events_through = MAX(ignore_events_through, ?),
            ignore_events_through_sequence = ?, admission_high_water = ?,
            admission_high_water_kind = 'control', updated_at = ?
          WHERE scope_key = ? AND principal_digest = ?
            AND principal_lineage_id = ? AND principal_lineage_version = ?
            AND generation = ? AND purge_pending = 0
            AND admission_cursor_epoch = ? AND admission_high_water IS ?
        `).run(
          controlVersion,
          occurredAt,
          ignoreEventsThroughSequence,
          admissionCursor.sequence,
          this.#now(),
          canonical.scopeKey,
          owner.principalDigest,
          owner.principalLineageId,
          owner.principalLineageVersion,
          owner.generation,
          admissionCursor.epoch,
          current.admission_high_water,
        )
        if (changed.changes !== 1) {
          throw new PreferenceStoreError('conflict', 'learning rollback owner cursor changed')
        }
      }
      const state = this.#scopeLearningStatusInTransaction(canonical, owner, false)
      this.#insertOwnerControlReceipt({
        idempotencyKey,
        hash,
        canonical,
        owner,
        action: 'rollback',
        preferenceKey,
        admissionCursor,
        applied: fresh,
        state,
        rolledBack,
        ...(rolledBackVersion === undefined ? {} : { rolledBackVersion }),
        occurredAt,
      })
      this.#database.exec('COMMIT')
      return Object.freeze({
        applied: fresh,
        replayed: false,
        state,
        rolledBack,
        ...(rolledBackVersion === undefined ? {} : { rolledBackVersion }),
      })
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  /** Atomically record one small producer batch and reconcile each affected key once. */
  appendSignals(
    inputs: readonly PreferenceSignalInput[],
    options: Readonly<{
      admissionCursor?: Readonly<PreferenceAdmissionCursor>
      exactCorrections?: readonly Readonly<PreferenceExactCorrectionInput>[]
      ownerFence?: Readonly<PreferenceScopePrincipalFence>
    }> = {},
  ): StoredPreferenceSignal[] {
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
    const exactCorrections = options.exactCorrections ?? []
    const exactByIndex = new Map<number, Readonly<PreferenceExactCorrectionInput>>()
    for (const correction of exactCorrections) {
      if (!Number.isSafeInteger(correction.signalIndex) || correction.signalIndex < 0
        || correction.signalIndex >= normalizedBatch.length || exactByIndex.has(correction.signalIndex)) {
        throw new PreferenceStoreError('invalid-input', 'exact correction signal index is invalid')
      }
      exactByIndex.set(correction.signalIndex, Object.freeze({
        signalIndex: correction.signalIndex,
        sourceInboxId: boundedText(correction.sourceInboxId, 'sourceInboxId', 500),
        replyOutboxId: boundedText(correction.replyOutboxId, 'replyOutboxId', 500),
      }))
    }
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      let ownerAdmissionAccepted = true
      if (options.ownerFence !== undefined) {
        const canonical = canonicalPreferenceScope(normalizedBatch[0]!.scope)
        if (normalizedBatch.some(signal => signal.scopeKey !== canonical.scopeKey)) {
          throw new PreferenceStoreError('conflict', 'owner-fenced signal batch spans multiple scopes')
        }
        if (options.admissionCursor === undefined) {
          throw new PreferenceStoreError(
            'invalid-input',
            'owner-fenced signal batches require a Delivery admission cursor',
          )
        }
        ownerAdmissionAccepted = this.#admitEventCursorInTransaction(
          canonical,
          options.ownerFence,
          canonicalPreferenceAdmissionCursor(options.admissionCursor),
        )
      }
      const storedSignals: StoredPreferenceSignal[] = []
      const storedSignalsByIndex: Array<StoredPreferenceSignal | undefined> = []
      const storedSignalRows: Array<SignalRow | undefined> = []
      const affected = new Map<string, {
        scopeKey: string
        scope: PreferenceScope
        preferenceKey: PreferenceKey
        trigger: SignalRow
        allowGlobalOwnerCorrection: boolean
      }>()
      for (let index = 0; index < normalizedBatch.length; index += 1) {
        const normalized = normalizedBatch[index]!
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
          const replayed = signalFromRow(replay)
          storedSignals.push(replayed)
          storedSignalsByIndex[index] = replayed
          storedSignalRows[index] = replay
          continue
        }
        if (!ownerAdmissionAccepted) continue
        const forgottenThrough = options.ownerFence === undefined
          ? this.#forgottenThrough(normalized.scopeDigest)
          : undefined
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
        storedSignalsByIndex[index] = signalFromRow(stored)
        storedSignalRows[index] = stored
        if (normalized.riskTier === 'T1' || normalized.riskTier === 'T2') {
          affected.set(`${normalized.scopeKey}\0${normalized.preferenceKey}`, {
            scopeKey: normalized.scopeKey,
            scope: normalized.scope,
            preferenceKey: normalized.preferenceKey,
            trigger: stored,
            allowGlobalOwnerCorrection: !exactByIndex.has(index),
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
          entry.allowGlobalOwnerCorrection,
        )
      }
      for (const [index, correction] of exactByIndex) {
        const signal = storedSignalRows[index]
        const stored = storedSignalsByIndex[index]
        if (signal === undefined || stored === undefined) continue
        this.#applyExposureCorrectionInTransaction({
          signal,
          sourceInboxId: correction.sourceInboxId,
          replyOutboxId: correction.replyOutboxId,
          occurredAt: stored.occurredAt,
          now,
        })
      }
      this.#database.exec('COMMIT')
      return storedSignals
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  list(
    scopeInput: PreferenceScope,
    limit = this.#options.maxReviewHypotheses,
    principalIdInput?: string,
    lineageInput?: Readonly<PreferencePrincipalLineage>,
  ): PreferenceHypothesis[] {
    this.#assertOpen()
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#options.maxReviewHypotheses) {
      throw new PreferenceStoreError(
        'invalid-input',
        `hypothesis limit must be between 1 and ${this.#options.maxReviewHypotheses}`,
      )
    }
    const canonical = canonicalPreferenceScope(scopeInput)
    const principalDigest = principalIdInput === undefined
      ? undefined
      : preferencePrincipalDigest(principalIdInput)
    if ((principalDigest === undefined) !== (lineageInput === undefined)) {
      throw new PreferenceStoreError(
        'invalid-input',
        'scoped preference listing requires both external principal and exact lineage',
      )
    }
    const lineage = lineageInput === undefined
      ? undefined
      : canonicalPreferencePrincipalLineage(lineageInput)
    this.#refreshScope(canonical.scopeKey, canonical.scope, this.#now())
    const rows = this.#database.prepare(`
      SELECT hypothesis.* FROM preference_hypotheses AS hypothesis
      WHERE hypothesis.scope_key = ?
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM preference_scope_principals AS owner
          WHERE owner.scope_key = hypothesis.scope_key
            AND owner.principal_digest = ? AND owner.purge_pending = 0
            AND (? IS NULL OR (
              owner.principal_lineage_id = ? AND owner.principal_lineage_version = ?
            ))
            AND owner.admission_cursor_epoch IS NOT NULL
        ))
      ORDER BY CASE effect_state
        WHEN 'active' THEN 0 WHEN 'shadow' THEN 1 WHEN 'inactive' THEN 2
        WHEN 'suppressed' THEN 3 ELSE 4 END,
        confidence_bps DESC, updated_at DESC, id DESC
      LIMIT ?
    `).all(
      canonical.scopeKey,
      principalDigest ?? null,
      principalDigest ?? null,
      lineage?.principalRecordId ?? null,
      lineage?.principalRecordId ?? null,
      lineage?.principalVersion ?? null,
      limit,
    ) as unknown as HypothesisRow[]
    return rows.map(hypothesisFromRow)
  }

  get(
    scopeInput: PreferenceScope,
    hypothesisIdInput: string,
    principalIdInput?: string,
    lineageInput?: Readonly<PreferencePrincipalLineage>,
  ): PreferenceHypothesis | undefined {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(scopeInput)
    const id = boundedText(hypothesisIdInput, 'hypothesisId', 200)
    this.#refreshScope(canonical.scopeKey, canonical.scope, this.#now())
    const principalDigest = principalIdInput === undefined
      ? undefined
      : preferencePrincipalDigest(principalIdInput)
    if ((principalDigest === undefined) !== (lineageInput === undefined)) {
      throw new PreferenceStoreError(
        'invalid-input',
        'scoped preference lookup requires both external principal and exact lineage',
      )
    }
    const lineage = lineageInput === undefined
      ? undefined
      : canonicalPreferencePrincipalLineage(lineageInput)
    const row = this.#database.prepare(`
      SELECT hypothesis.* FROM preference_hypotheses AS hypothesis
      WHERE hypothesis.id = ? AND hypothesis.scope_key = ?
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM preference_scope_principals AS owner
          WHERE owner.scope_key = hypothesis.scope_key
            AND owner.principal_digest = ? AND owner.purge_pending = 0
            AND (? IS NULL OR (
              owner.principal_lineage_id = ? AND owner.principal_lineage_version = ?
            ))
            AND owner.admission_cursor_epoch IS NOT NULL
        ))
    `).get(
      id,
      canonical.scopeKey,
      principalDigest ?? null,
      principalDigest ?? null,
      lineage?.principalRecordId ?? null,
      lineage?.principalRecordId ?? null,
      lineage?.principalVersion ?? null,
    ) as HypothesisRow | undefined
    return row === undefined ? undefined : hypothesisFromRow(row)
  }

  /**
   * Return the first hypothesis that would pass activate() at this instant.
   * The deterministic ordering is only a planning hint: activate() still
   * repeats every predicate under BEGIN IMMEDIATE and exact-version CAS.
   */
  activationCandidate(
    scopeInput: PreferenceScope,
    owner?: string | Readonly<PreferenceScopePrincipalFence>,
  ): PreferenceHypothesis | undefined {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(scopeInput)
    const now = this.#now()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#assertScopePrincipalInTransaction(canonical, owner)
      this.#assertScopeLearningActiveInTransaction(canonical)
      this.#refreshScopeInTransaction(canonical.scopeKey, canonical.scope, now)
      const rows = this.#database.prepare(`
        SELECT * FROM preference_hypotheses
        WHERE scope_key = ?
        ORDER BY confidence_bps DESC, supporting_signals DESC, updated_at DESC, id ASC
      `).all(canonical.scopeKey) as unknown as HypothesisRow[]
      const row = rows.find(candidate =>
        this.#activationError(candidate, canonical.scopeKey, now) === undefined)
      this.#database.exec('COMMIT')
      return row === undefined ? undefined : hypothesisFromRow(row)
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  activate(
    scopeInput: PreferenceScope,
    hypothesisIdInput: string,
    expectedVersion: number,
    owner?: string | Readonly<PreferenceScopePrincipalFence>,
  ): PreferenceHypothesis {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(scopeInput)
    const id = boundedText(hypothesisIdInput, 'hypothesisId', 200)
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new PreferenceStoreError('invalid-input', 'expectedVersion must be a positive safe integer')
    }
    const now = this.#now()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#assertScopePrincipalInTransaction(canonical, owner)
      this.#assertScopeLearningActiveInTransaction(canonical)
      this.#refreshScopeInTransaction(canonical.scopeKey, canonical.scope, now)
      const row = this.#database.prepare(
        'SELECT * FROM preference_hypotheses WHERE id = ? AND scope_key = ?',
      ).get(id, canonical.scopeKey) as HypothesisRow | undefined
      if (row === undefined) throw new PreferenceStoreError('not-found', 'preference hypothesis was not found')
      if (row.version !== expectedVersion) throw new PreferenceStoreError('conflict', 'hypothesis version changed')
      const activationError = this.#activationError(row, canonical.scopeKey, now)
      if (activationError !== undefined) throw activationError
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

  /**
   * Apply currently-ready catalog T1 hypotheses with the same exact CAS used
   * by the manual surface. The bounded loop is crash-replay safe: a later run
   * simply observes already-active rows and continues.
   */
  activateReady(
    scopeInput: PreferenceScope,
    limit = this.#options.maxActiveOverlays,
    ownerFence?: Readonly<PreferenceScopePrincipalFence>,
  ): PreferenceHypothesis[] {
    this.#assertOpen()
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#options.maxActiveOverlays) {
      throw new PreferenceStoreError('invalid-input', 'automatic activation limit is invalid')
    }
    const scope = canonicalPreferenceScope(scopeInput).scope
    const activated: PreferenceHypothesis[] = []
    for (let index = 0; index < limit; index += 1) {
      const candidate = this.activationCandidate(scope, ownerFence)
      if (candidate === undefined) break
      try {
        activated.push(this.activate(scope, candidate.id, candidate.version, ownerFence))
      } catch (error) {
        if (error instanceof PreferenceStoreError
          && ['conflict', 'not-ready'].includes(error.code)) break
        throw error
      }
    }
    return activated
  }

  /** Bounded restart/maintenance recovery for signals committed before activation. */
  activateReadyScopes(limit: number): number {
    this.#assertOpen()
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
      throw new PreferenceStoreError('invalid-input', 'automatic scope activation limit is invalid')
    }
    const rows = this.#database.prepare(`
      SELECT h.scope_key, h.workspace, h.preset,
        owner.principal_digest, owner.principal_lineage_id,
        owner.principal_lineage_version, owner.generation
      FROM preference_hypotheses h
      INNER JOIN preference_scope_principals owner
        ON owner.scope_key = h.scope_key AND owner.purge_pending = 0
          AND owner.learning_paused = 0 AND owner.admission_cursor_epoch IS NOT NULL
      WHERE h.risk_tier = 'T1' AND h.claim_state = 'tentative' AND h.effect_state = 'shadow'
        AND EXISTS (
          SELECT 1 FROM preference_signals s
          WHERE s.scope_key = h.scope_key AND s.actor_trust = 'owner-authenticated'
            AND ((s.interpretation_trust IN ('explicit-selection', 'typed-feedback')
              AND s.source IN ('direct-owner-feedback', 'signed-ui-feedback'))
              OR (s.interpretation_trust = 'behavioral-inference'
                AND s.source = 'delivery-observation'))
        )
      GROUP BY h.scope_key, h.workspace, h.preset,
        owner.principal_digest, owner.principal_lineage_id,
        owner.principal_lineage_version, owner.generation
      ORDER BY MAX(h.updated_at) DESC, h.scope_key ASC
      LIMIT ?
    `).all(limit) as unknown as Array<{
      scope_key: string
      workspace: string
      preset: string
      principal_digest: string
      principal_lineage_id: string
      principal_lineage_version: number
      generation: number
    }>
    let activated = 0
    for (const row of rows) {
      const scope = { workspace: row.workspace, preset: row.preset }
      const ownerFence = Object.freeze({
        scopeKey: row.scope_key,
        principalDigest: row.principal_digest,
        principalLineageId: row.principal_lineage_id,
        principalLineageVersion: row.principal_lineage_version,
        generation: row.generation,
      })
      try {
        activated += this.activateReady(scope, this.#options.maxActiveOverlays, ownerFence).length
      } catch (error) {
        // A newer authenticated owner may rotate this scope after the bounded
        // scan but before activation. The exact generation check inside each
        // activation transaction makes that race a safe no-op for this pass.
        if (error instanceof PreferenceStoreError && error.code === 'conflict') continue
        throw error
      }
    }
    return activated
  }

  /**
   * Activate one exact hypothesis and commit a fixed-run receipt in the same
   * writer transaction. A lost response can therefore be replayed after a
   * restart without relaxing the original evidence gate or CAS.
   */
  activateHostOnce(
    scopeInput: PreferenceScope,
    hypothesisIdInput: string,
    expectedVersion: number,
    operationIdInput: string,
    owner: Readonly<PreferenceScopePrincipalFence>,
    newMutationEnabled = true,
  ): PreferenceHostActivationResult {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(scopeInput)
    const id = boundedText(hypothesisIdInput, 'hypothesisId', 200)
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new PreferenceStoreError('invalid-input', 'expectedVersion must be a positive safe integer')
    }
    const operationId = boundedText(operationIdInput, 'operationId', 500)
    const idempotencyKey = `pref-host-activate-idem-${createHash('sha256')
      .update(`preference-host-activation-idempotency-v1\0${operationId}`).digest('hex')}`
    const hash = payloadHash({
      scopeDigest: canonical.scopeDigest,
      hypothesisId: id,
      expectedVersion,
      idempotencyKey,
      ownerGeneration: owner.generation,
      principalLineageId: owner.principalLineageId,
      principalLineageVersion: owner.principalLineageVersion,
    })
    const now = this.#now()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      // The current exact owner fence is always checked before looking up a
      // receipt. This prevents an A -> B -> A owner rotation from replaying an
      // old generation's success. Once that fence is proven, however, an
      // already-committed receipt is authoritative: pause/disable/readiness
      // changes happened after the mutation and must not turn a lost response
      // into an ambiguous Recovery result.
      this.#assertScopePrincipalInTransaction(canonical, owner)
      const prior = this.#database.prepare(`
        SELECT payload_hash, scope_digest, hypothesis_id, expected_version, result_version,
          owner_generation, principal_lineage_id, principal_lineage_version
        FROM preference_host_activation_receipts WHERE idempotency_key = ?
      `).get(idempotencyKey) as HostActivationReceiptRow | undefined
      if (prior !== undefined) {
        if (prior.payload_hash !== hash || prior.scope_digest !== canonical.scopeDigest
          || prior.hypothesis_id !== id || prior.expected_version !== expectedVersion
          || prior.owner_generation !== owner.generation
          || prior.principal_lineage_id !== owner.principalLineageId
          || prior.principal_lineage_version !== owner.principalLineageVersion) {
          throw new PreferenceStoreError(
            'idempotency-conflict',
            'Host activation operation identity was reused for another exact target',
          )
        }
        this.#database.exec('COMMIT')
        return Object.freeze({
          hypothesisId: prior.hypothesis_id,
          expectedVersion: prior.expected_version,
          resultVersion: prior.result_version,
          ownerGeneration: prior.owner_generation,
          principalLineageId: prior.principal_lineage_id,
          principalLineageVersion: prior.principal_lineage_version,
          replayed: true,
        })
      }

      if (!newMutationEnabled) {
        throw new PreferenceStoreError('disabled', 'preference learning is disabled')
      }
      this.#assertScopeLearningActiveInTransaction(canonical)
      this.#refreshScopeInTransaction(canonical.scopeKey, canonical.scope, now)
      const row = this.#database.prepare(
        'SELECT * FROM preference_hypotheses WHERE id = ? AND scope_key = ?',
      ).get(id, canonical.scopeKey) as HypothesisRow | undefined
      if (row === undefined) throw new PreferenceStoreError('not-found', 'preference hypothesis was not found')
      if (row.version !== expectedVersion) throw new PreferenceStoreError('conflict', 'hypothesis version changed')
      const activationError = this.#activationError(row, canonical.scopeKey, now)
      if (activationError !== undefined) throw activationError
      const resultVersion = row.version + 1
      const updated = this.#database.prepare(`
        UPDATE preference_hypotheses
        SET effect_state = 'active', activated_at = ?, updated_at = ?, version = ?
        WHERE id = ? AND scope_key = ? AND version = ?
      `).run(now, now, resultVersion, row.id, canonical.scopeKey, row.version)
      if (updated.changes !== 1) {
        throw new PreferenceStoreError('conflict', 'hypothesis activation CAS lost')
      }
      this.#transition(row, row.claim_state, 'active', 'activated', resultVersion, now)
      this.#database.prepare(`
        INSERT INTO preference_host_activation_receipts(
          idempotency_key, payload_hash, scope_digest, hypothesis_id,
          expected_version, result_version, occurred_at, owner_generation,
          principal_lineage_id, principal_lineage_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        idempotencyKey, hash, canonical.scopeDigest, row.id,
        row.version, resultVersion, now, owner.generation,
        owner.principalLineageId, owner.principalLineageVersion,
      )
      this.#database.exec('COMMIT')
      return Object.freeze({
        hypothesisId: row.id,
        expectedVersion: row.version,
        resultVersion,
        ownerGeneration: owner.generation,
        principalLineageId: owner.principalLineageId,
        principalLineageVersion: owner.principalLineageVersion,
        replayed: false,
      })
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
    principalIdInput?: string | Readonly<PreferenceScopePrincipalFence>,
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
      this.#assertScopePrincipalInTransaction(canonical, principalIdInput)
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
    return this.overlaySnapshot(scopeInput).text
  }

  overlaySnapshot(
    scopeInput: PreferenceScope,
    principalIdInput?: string,
    lineageInput?: Readonly<PreferencePrincipalLineage>,
  ): PreferenceOverlaySnapshot {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(scopeInput)
    const principalDigest = principalIdInput === undefined
      ? undefined
      : preferencePrincipalDigest(principalIdInput)
    const lineage = lineageInput === undefined
      ? undefined
      : canonicalPreferencePrincipalLineage(lineageInput)
    let rows: HypothesisRow[]
    let ownerFence: PreferenceScopePrincipalFence | undefined
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      if (principalDigest !== undefined) {
        const owner = this.#database.prepare(`
          SELECT generation, principal_lineage_id, principal_lineage_version,
            learning_paused, admission_cursor_epoch
          FROM preference_scope_principals
          WHERE scope_key = ? AND principal_digest = ? AND purge_pending = 0
            AND (? IS NULL OR (principal_lineage_id = ? AND principal_lineage_version = ?))
        `).get(
          canonical.scopeKey,
          principalDigest,
          lineage?.principalRecordId ?? null,
          lineage?.principalRecordId ?? null,
          lineage?.principalVersion ?? null,
        ) as {
          generation: number
          principal_lineage_id: string | null
          principal_lineage_version: number | null
          learning_paused: number
          admission_cursor_epoch: string | null
        } | undefined
        if (owner === undefined || owner.principal_lineage_id === null
          || owner.principal_lineage_version === null
          || owner.admission_cursor_epoch === null) {
          this.#database.exec('COMMIT')
          return Object.freeze({ text: undefined, hypotheses: Object.freeze([]) })
        }
        ownerFence = Object.freeze({
          scopeKey: canonical.scopeKey,
          principalDigest,
          principalLineageId: owner.principal_lineage_id,
          principalLineageVersion: owner.principal_lineage_version,
          generation: owner.generation,
        })
        if (owner.learning_paused === 1) {
          this.#database.exec('COMMIT')
          return Object.freeze({
            text: undefined,
            hypotheses: Object.freeze([]),
            ownerFence,
          })
        }
      }
      this.#refreshScopeInTransaction(canonical.scopeKey, canonical.scope, this.#now())
      rows = this.#database.prepare(`
        SELECT * FROM preference_hypotheses
        WHERE scope_key = ? AND effect_state = 'active' AND risk_tier = 'T1'
        ORDER BY preference_key ASC, id ASC
        LIMIT ?
      `).all(canonical.scopeKey, this.#options.maxActiveOverlays) as unknown as HypothesisRow[]
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
    if (rows.length === 0) {
      return Object.freeze({
        text: undefined,
        hypotheses: Object.freeze([]),
        ...(ownerFence === undefined ? {} : { ownerFence }),
      })
    }
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
    return Object.freeze({
      text: rendered,
      hypotheses: Object.freeze(rows.map(hypothesisFromRow)),
      ...(ownerFence === undefined ? {} : { ownerFence }),
    })
  }

  recordExposure(input: Readonly<{
    scope: PreferenceScope
    ownerFence?: Readonly<PreferenceScopePrincipalFence>
    hypothesisId: string
    hypothesisVersion: number
    sessionId: string
    sourceEventId: string
  }>): { replayed: boolean } {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(input.scope)
    const hypothesisIdInput = boundedText(input.hypothesisId, 'hypothesisId', 200)
    const sessionId = boundedText(input.sessionId, 'sessionId', 500)
    const sourceEventId = boundedText(input.sourceEventId, 'sourceEventId', 500)
    if (!Number.isSafeInteger(input.hypothesisVersion) || input.hypothesisVersion < 1) {
      throw new PreferenceStoreError('invalid-input', 'hypothesisVersion must be a positive safe integer')
    }
    const idempotencyKey = `pref-exposure-${createHash('sha256')
      .update('preference-exposure-v1\0')
      .update(JSON.stringify([
        canonical.scopeDigest,
        hypothesisIdInput,
        input.hypothesisVersion,
        sessionId,
        sourceEventId,
      ]))
      .digest('hex')}`
    const hash = payloadHash({
      scopeDigest: canonical.scopeDigest,
      hypothesisId: hypothesisIdInput,
      hypothesisVersion: input.hypothesisVersion,
      sessionId,
      sourceEventId,
    })
    const now = this.#now()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#assertScopePrincipalInTransaction(canonical, input.ownerFence)
      this.#assertScopeLearningActiveInTransaction(canonical)
      const replay = this.#database.prepare(`
        SELECT payload_hash FROM preference_exposures WHERE idempotency_key = ?
      `).get(idempotencyKey) as { payload_hash: string } | undefined
      if (replay !== undefined) {
        if (replay.payload_hash !== hash) {
          throw new PreferenceStoreError('idempotency-conflict', 'preference exposure identity was reused')
        }
        this.#database.exec('COMMIT')
        return Object.freeze({ replayed: true })
      }
      const hypothesis = this.#database.prepare(`
        SELECT * FROM preference_hypotheses
        WHERE id = ? AND scope_key = ? AND version = ?
          AND risk_tier = 'T1' AND effect_state = 'active' AND expires_at > ?
      `).get(
        hypothesisIdInput,
        canonical.scopeKey,
        input.hypothesisVersion,
        now,
      ) as unknown as HypothesisRow | undefined
      if (hypothesis === undefined) {
        throw new PreferenceStoreError('conflict', 'exposure hypothesis is no longer the exact active version')
      }
      this.#database.prepare(`
        INSERT INTO preference_exposures(
          idempotency_key, payload_hash, scope_key, workspace, preset,
          hypothesis_id, hypothesis_version, session_id, source_event_id,
          source_inbox_id, reply_outbox_id, state, exposed_at, bound_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', ?, NULL, ?)
      `).run(
        idempotencyKey,
        hash,
        canonical.scopeKey,
        canonical.scope.workspace,
        canonical.scope.preset,
        hypothesis.id,
        hypothesis.version,
        sessionId,
        sourceEventId,
        now,
        hypothesis.expires_at,
      )
      this.#database.exec('COMMIT')
      return Object.freeze({ replayed: false })
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  bindExposure(input: Readonly<{
    admissionCursor?: Readonly<PreferenceAdmissionCursor>
    scope: PreferenceScope
    ownerFence?: Readonly<PreferenceScopePrincipalFence>
    sessionId: string
    sourceEventId: string
    sourceInboxId: string
    replyOutboxId: string
  }>): { bound: number; replayed: boolean } {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(input.scope)
    const sessionId = boundedText(input.sessionId, 'sessionId', 500)
    const sourceEventId = boundedText(input.sourceEventId, 'sourceEventId', 500)
    const sourceInboxId = boundedText(input.sourceInboxId, 'sourceInboxId', 500)
    const replyOutboxId = boundedText(input.replyOutboxId, 'replyOutboxId', 500)
    const now = this.#now()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      if (input.ownerFence !== undefined) {
        if (input.admissionCursor === undefined) {
          throw new PreferenceStoreError(
            'invalid-input',
            'owner-fenced exposure binding requires a Delivery admission cursor',
          )
        }
        if (!this.#admitEventCursorInTransaction(
          canonical,
          input.ownerFence,
          canonicalPreferenceAdmissionCursor(input.admissionCursor),
        )) {
          this.#database.exec('COMMIT')
          return Object.freeze({ bound: 0, replayed: false })
        }
      } else {
        this.#assertScopePrincipalInTransaction(canonical, input.ownerFence)
      }
      this.#assertScopeLearningActiveInTransaction(canonical)
      const rows = this.#database.prepare(`
        SELECT source_inbox_id, reply_outbox_id, state FROM preference_exposures
        WHERE scope_key = ? AND session_id = ? AND source_event_id = ?
      `).all(canonical.scopeKey, sessionId, sourceEventId) as unknown as Array<{
        source_inbox_id: string | null
        reply_outbox_id: string | null
        state: 'pending' | 'bound'
      }>
      const conflict = rows.some(row => row.state === 'bound'
        && (row.source_inbox_id !== sourceInboxId || row.reply_outbox_id !== replyOutboxId))
      if (conflict) {
        throw new PreferenceStoreError('idempotency-conflict', 'exposure turn was bound to another receipt')
      }
      const updated = this.#database.prepare(`
        UPDATE preference_exposures
        SET source_inbox_id = ?, reply_outbox_id = ?, state = 'bound', bound_at = ?
        WHERE scope_key = ? AND session_id = ? AND source_event_id = ? AND state = 'pending'
      `).run(
        sourceInboxId,
        replyOutboxId,
        now,
        canonical.scopeKey,
        sessionId,
        sourceEventId,
      )
      this.#database.exec('COMMIT')
      return Object.freeze({ bound: Number(updated.changes), replayed: rows.length > 0 && updated.changes === 0 })
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  hasBoundExposure(input: Readonly<{
    scope: PreferenceScope
    sourceInboxId: string
    replyOutboxId: string
  }>): boolean {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(input.scope)
    const sourceInboxId = boundedText(input.sourceInboxId, 'sourceInboxId', 500)
    const replyOutboxId = boundedText(input.replyOutboxId, 'replyOutboxId', 500)
    return this.#database.prepare(`
      SELECT 1 AS present FROM preference_exposures
      WHERE scope_key = ? AND source_inbox_id = ? AND reply_outbox_id = ? AND state = 'bound'
      LIMIT 1
    `).get(canonical.scopeKey, sourceInboxId, replyOutboxId) !== undefined
  }

  recordExposureCorrection(input: Readonly<{
    scope: PreferenceScope
    signalId: string
    preferenceKey: PreferenceKey
    candidateValue: string
    sourceInboxId: string
    replyOutboxId: string
    occurredAt: number
  }>): number {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(input.scope)
    const signalId = boundedText(input.signalId, 'signalId', 200)
    const selection = catalogSelection(input.preferenceKey, input.candidateValue)
    const sourceInboxId = boundedText(input.sourceInboxId, 'sourceInboxId', 500)
    const replyOutboxId = boundedText(input.replyOutboxId, 'replyOutboxId', 500)
    const occurredAt = safeTimestamp(input.occurredAt, 'occurredAt')
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const signal = this.#database.prepare(`
        SELECT * FROM preference_signals WHERE id = ? AND scope_key = ?
      `).get(signalId, canonical.scopeKey) as SignalRow | undefined
      if (signal === undefined || signal.preference_key !== selection.key
        || signal.candidate_value !== selection.value || signal.occurred_at !== occurredAt) {
        throw new PreferenceStoreError('conflict', 'exposure correction signal identity changed')
      }
      const inserted = this.#applyExposureCorrectionInTransaction({
        signal,
        sourceInboxId,
        replyOutboxId,
        occurredAt,
        now: this.#now(),
      })
      this.#database.exec('COMMIT')
      return inserted
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  #applyExposureCorrectionInTransaction(input: Readonly<{
    signal: SignalRow
    sourceInboxId: string
    replyOutboxId: string
    occurredAt: number
    now: number
  }>): number {
    if (!isActivationEligibleSignal(input.signal)
      || input.signal.interpretation_trust === 'behavioral-inference') return 0
    const exposures = this.#database.prepare(`
      SELECT exposure.hypothesis_id, exposure.hypothesis_version
      FROM preference_exposures AS exposure
      JOIN preference_hypotheses AS hypothesis ON hypothesis.id = exposure.hypothesis_id
      WHERE exposure.scope_key = ? AND exposure.source_inbox_id = ?
        AND exposure.reply_outbox_id = ? AND exposure.state = 'bound'
        AND hypothesis.preference_key = ? AND hypothesis.candidate_value <> ?
      ORDER BY exposure.hypothesis_id, exposure.hypothesis_version
    `).all(
      input.signal.scope_key,
      input.sourceInboxId,
      input.replyOutboxId,
      input.signal.preference_key,
      input.signal.candidate_value,
    ) as unknown as Array<{ hypothesis_id: string; hypothesis_version: number }>
    let inserted = 0
    for (const exposure of exposures) {
      inserted += Number(this.#database.prepare(`
        INSERT OR IGNORE INTO preference_exposure_corrections(
          signal_id, hypothesis_id, hypothesis_version,
          source_inbox_id, reply_outbox_id, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        input.signal.id,
        exposure.hypothesis_id,
        exposure.hypothesis_version,
        input.sourceInboxId,
        input.replyOutboxId,
        input.occurredAt,
      ).changes)

      const current = this.#database.prepare(`
        SELECT * FROM preference_hypotheses
        WHERE id = ? AND scope_key = ? AND effect_state = 'active'
      `).get(exposure.hypothesis_id, input.signal.scope_key) as HypothesisRow | undefined
      if (current === undefined || current.version < exposure.hypothesis_version) continue
      const crossedLineage = this.#database.prepare(`
        SELECT 1 AS changed FROM preference_transitions
        WHERE hypothesis_id = ? AND version > ? AND reason <> 'evidence-updated'
        LIMIT 1
      `).get(current.id, exposure.hypothesis_version) !== undefined
      if (crossedLineage) continue
      const nextVersion = current.version + 1
      const changed = this.#database.prepare(`
        UPDATE preference_hypotheses SET
          claim_state = 'rejected', effect_state = 'rolled-back',
          rolled_back_at = ?, updated_at = ?, version = ?
        WHERE id = ? AND scope_key = ? AND version = ? AND effect_state = 'active'
      `).run(
        input.now,
        input.now,
        nextVersion,
        current.id,
        input.signal.scope_key,
        current.version,
      )
      if (changed.changes !== 1) {
        throw new PreferenceStoreError('conflict', 'exact exposure rollback CAS lost')
      }
      this.#transition(
        current,
        'rejected',
        'rolled-back',
        'owner-rejected',
        nextVersion,
        input.now,
      )
    }
    return inserted
  }

  forgetScope(
    scopeInput: PreferenceScope,
    idempotencyKeyInput: string,
    options?: Readonly<{
      ownerFence: Readonly<PreferenceScopePrincipalFence>
      admissionCursor: Readonly<PreferenceAdmissionCursor>
      occurredAt: number
    }>,
  ): PreferenceForgetResult {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(scopeInput)
    const rawIdempotencyKey = boundedText(idempotencyKeyInput, 'idempotencyKey', 200)
    const idempotencyKey = `pref-forget-idem-${createHash('sha256')
      .update(`preference-forget-idempotency-v1\0${rawIdempotencyKey}`).digest('hex')}`
    const now = this.#now()
    const occurredAt = options === undefined ? now : safeTimestamp(options.occurredAt, 'occurredAt')
    const admissionCursor = options === undefined
      ? undefined
      : canonicalPreferenceAdmissionCursor(options.admissionCursor)
    const forgottenThrough = Math.max(now, occurredAt)
    const hash = payloadHash({ scopeDigest: canonical.scopeDigest, idempotencyKey })
    const ownerReceiptKey = options === undefined
      ? undefined
      : `pref-owner-control-${createHash('sha256')
        .update(`preference-owner-control-idempotency-v1\0${rawIdempotencyKey}`).digest('hex')}`
    const ownerReceiptHash = options === undefined
      ? undefined
      : payloadHash({
          scopeDigest: canonical.scopeDigest,
          principalDigest: options.ownerFence.principalDigest,
          principalLineageId: options.ownerFence.principalLineageId,
          principalLineageVersion: options.ownerFence.principalLineageVersion,
          generation: options.ownerFence.generation,
          action: 'forget',
          admissionCursor,
        })
    let result: PreferenceForgetResult
    let privacyChanged = false
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#assertScopePrincipalInTransaction(canonical, options?.ownerFence)
      if (options !== undefined) {
        const replay = this.#database.prepare(`
          SELECT * FROM preference_owner_control_receipts WHERE idempotency_key = ?
        `).get(ownerReceiptKey!) as unknown as OwnerControlReceiptRow | undefined
        if (replay !== undefined) {
          if (replay.payload_hash !== ownerReceiptHash) {
            throw new PreferenceStoreError('idempotency-conflict', 'forget idempotency key was reused')
          }
          this.#database.exec('COMMIT')
          result = Object.freeze({
            applied: replay.result_applied === 1,
            replayed: true,
            forgottenThrough: Math.max(0, replay.result_forgotten_through),
            deletedSignals: replay.result_deleted_signals,
            deletedHypotheses: replay.result_deleted_hypotheses,
            state: this.#ownerControlStateFromReceipt(replay),
          })
          privacyChanged = replay.result_applied === 1
          if (privacyChanged) this.#truncateWalForPrivacy()
          return result
        }
        const current = this.#scopeAdmissionRowInTransaction(canonical.scopeKey)
        const fresh = this.#controlCursorIsFresh(current, admissionCursor!)
        if (!fresh) {
          const priorForget = this.#forgottenThrough(canonical.scopeDigest) ?? 0
          const state = this.#scopeLearningStatusInTransaction(canonical, options.ownerFence)
          this.#insertOwnerControlReceipt({
            idempotencyKey: ownerReceiptKey!,
            hash: ownerReceiptHash!,
            canonical,
            owner: options.ownerFence,
            action: 'forget',
            admissionCursor: admissionCursor!,
            applied: false,
            state,
            deletedSignals: 0,
            deletedHypotheses: 0,
            forgottenThrough: priorForget,
            occurredAt,
          })
          this.#database.exec('COMMIT')
          return Object.freeze({
            applied: false,
            replayed: false,
            forgottenThrough: priorForget,
            deletedSignals: 0,
            deletedHypotheses: 0,
            state,
          })
        }
      }
      const replay = options === undefined
        ? this.#database.prepare(`
            SELECT payload_hash, forgotten_through, deleted_signals, deleted_hypotheses
            FROM preference_scope_tombstones WHERE idempotency_key = ?
          `).get(idempotencyKey) as unknown as TombstoneRow | undefined
        : undefined
      if (replay !== undefined) {
        if (replay.payload_hash !== hash) {
          throw new PreferenceStoreError('idempotency-conflict', 'forget idempotency key was reused')
        }
        this.#database.exec('COMMIT')
        result = Object.freeze({
          applied: true,
          replayed: true,
          forgottenThrough: replay.forgotten_through,
          deletedSignals: replay.deleted_signals,
          deletedHypotheses: replay.deleted_hypotheses,
        })
      } else {
        // A privacy reset must not leave historical snapshots or tombstones
        // that disclose the deleted counts/times. The exact current forget
        // replay was handled above; after this boundary only its new receipt
        // and tombstone may survive.
        this.#database.prepare(
          'DELETE FROM preference_owner_control_receipts WHERE scope_digest = ?',
        ).run(canonical.scopeDigest)
        this.#database.prepare(
          'DELETE FROM preference_scope_tombstones WHERE scope_digest = ?',
        ).run(canonical.scopeDigest)
        this.#database.prepare(`
          DELETE FROM preference_exposure_corrections
          WHERE signal_id IN (SELECT id FROM preference_signals WHERE scope_key = ?)
            OR hypothesis_id IN (SELECT id FROM preference_hypotheses WHERE scope_key = ?)
        `).run(canonical.scopeKey, canonical.scopeKey)
        this.#database.prepare(
          'DELETE FROM preference_exposures WHERE scope_key = ?',
        ).run(canonical.scopeKey)
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
        if (options !== undefined) {
          const current = this.#scopeAdmissionRowInTransaction(canonical.scopeKey)
          const changed = this.#database.prepare(`
            UPDATE preference_scope_principals
            SET ignore_events_through = MAX(ignore_events_through, ?),
              ignore_events_through_sequence = ?,
              admission_high_water = ?, admission_high_water_kind = 'control',
              control_version = control_version + 1, updated_at = ?
            WHERE scope_key = ? AND principal_digest = ?
              AND principal_lineage_id = ? AND principal_lineage_version = ?
              AND generation = ? AND purge_pending = 0
              AND admission_cursor_epoch = ? AND admission_high_water IS ?
          `).run(
            forgottenThrough,
            admissionCursor!.sequence,
            admissionCursor!.sequence,
            now,
            canonical.scopeKey,
            options.ownerFence.principalDigest,
            options.ownerFence.principalLineageId,
            options.ownerFence.principalLineageVersion,
            options.ownerFence.generation,
            admissionCursor!.epoch,
            current.admission_high_water,
          )
          if (changed.changes !== 1) {
            throw new PreferenceStoreError('conflict', 'forget owner fence changed')
          }
        }
        this.#database.prepare(`
          INSERT INTO preference_scope_tombstones(
            id, scope_digest, idempotency_key, payload_hash, forgotten_through,
            recorded_at, deleted_signals, deleted_hypotheses
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `pref-forget-${randomUUID()}`, canonical.scopeDigest, idempotencyKey, hash,
          forgottenThrough, now, deletedSignals, deletedHypotheses,
        )
        if (options !== undefined) {
          const state = this.#scopeLearningStatusInTransaction(canonical, options.ownerFence)
          this.#insertOwnerControlReceipt({
            idempotencyKey: ownerReceiptKey!,
            hash: ownerReceiptHash!,
            canonical,
            owner: options.ownerFence,
            action: 'forget',
            admissionCursor: admissionCursor!,
            applied: true,
            state,
            deletedSignals,
            deletedHypotheses,
            forgottenThrough,
            occurredAt,
          })
          result = Object.freeze({
            applied: true,
            replayed: false,
            forgottenThrough,
            deletedSignals,
            deletedHypotheses,
            state,
          })
        } else {
          result = Object.freeze({
            applied: true,
            replayed: false,
            forgottenThrough,
            deletedSignals,
            deletedHypotheses,
          })
        }
        this.#database.exec('COMMIT')
        privacyChanged = true
      }
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
    // A logical DELETE is not a privacy boundary while old pages remain in
    // WAL. Secure-delete wipes the database pages; TRUNCATE proves those
    // deletion frames have also been checkpointed before success is reported.
    if (privacyChanged || result.applied) this.#truncateWalForPrivacy()
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
      this.#database.prepare(`
        DELETE FROM preference_exposures
        WHERE idempotency_key IN (
          SELECT idempotency_key FROM preference_exposures
          WHERE expires_at < ?
          ORDER BY expires_at ASC, idempotency_key ASC
          LIMIT ?
        )
      `).run(this.#now(), limit)
      this.#database.prepare(`
        DELETE FROM preference_exposure_corrections
        WHERE NOT EXISTS (
          SELECT 1 FROM preference_exposures e
          WHERE e.hypothesis_id = preference_exposure_corrections.hypothesis_id
            AND e.hypothesis_version = preference_exposure_corrections.hypothesis_version
            AND e.reply_outbox_id = preference_exposure_corrections.reply_outbox_id
        )
      `).run()
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

  /**
   * Delete at most one expired signal from one exact Host scope. The operation
   * receipt commits with the deletion, so a crash/retry cannot consume a second
   * row under the same fixed-run step identity.
   */
  maintainScopeOnce(
    scopeInput: PreferenceScope,
    operationIdInput: string,
    owner: Readonly<PreferenceScopePrincipalFence>,
  ): PreferenceHostMaintenanceResult {
    this.#assertOpen()
    const canonical = canonicalPreferenceScope(scopeInput)
    const operationId = boundedText(operationIdInput, 'operationId', 500)
    const idempotencyKey = `pref-host-maint-idem-${createHash('sha256')
      .update(`preference-host-maintenance-idempotency-v1\0${operationId}`).digest('hex')}`
    const hash = payloadHash({
      scopeDigest: canonical.scopeDigest,
      idempotencyKey,
      ownerGeneration: owner.generation,
      principalLineageId: owner.principalLineageId,
      principalLineageVersion: owner.principalLineageVersion,
    })
    const now = this.#now()
    const threshold = Math.max(0, now - this.#options.signalTtlMs)
    let result: PreferenceHostMaintenanceResult
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#assertScopePrincipalInTransaction(canonical, owner)
      const prior = this.#database.prepare(`
        SELECT payload_hash, scope_digest, deleted_signals, owner_generation,
          principal_lineage_id, principal_lineage_version
        FROM preference_host_maintenance_receipts WHERE idempotency_key = ?
      `).get(idempotencyKey) as {
        payload_hash: string
        scope_digest: string
        deleted_signals: number
        owner_generation: number | null
        principal_lineage_id: string | null
        principal_lineage_version: number | null
      } | undefined
      if (prior !== undefined) {
        if (prior.payload_hash !== hash || prior.scope_digest !== canonical.scopeDigest
          || prior.owner_generation !== owner.generation
          || prior.principal_lineage_id !== owner.principalLineageId
          || prior.principal_lineage_version !== owner.principalLineageVersion) {
          throw new PreferenceStoreError(
            'idempotency-conflict',
            'Host maintenance operation identity was reused for another scope',
          )
        }
        result = Object.freeze({
          deletedSignals: prior.deleted_signals,
          replayed: true,
          ownerGeneration: owner.generation,
          principalLineageId: owner.principalLineageId,
          principalLineageVersion: owner.principalLineageVersion,
        })
      } else {
        const deletedSignals = Number(this.#database.prepare(`
          DELETE FROM preference_signals
          WHERE id IN (
            SELECT id FROM preference_signals
            WHERE scope_key = ? AND occurred_at < ?
            ORDER BY occurred_at ASC, id ASC
            LIMIT 1
          )
        `).run(canonical.scopeKey, threshold).changes)
        this.#database.prepare(`
          INSERT INTO preference_host_maintenance_receipts(
            idempotency_key, payload_hash, scope_digest, deleted_signals, occurred_at,
            owner_generation, principal_lineage_id, principal_lineage_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          idempotencyKey,
          hash,
          canonical.scopeDigest,
          deletedSignals,
          now,
          owner.generation,
          owner.principalLineageId,
          owner.principalLineageVersion,
        )
        result = Object.freeze({
          deletedSignals,
          replayed: false,
          ownerGeneration: owner.generation,
          principalLineageId: owner.principalLineageId,
          principalLineageVersion: owner.principalLineageVersion,
        })
      }
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
    this.#truncateWalForPrivacy()
    return result
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
    allowGlobalOwnerCorrection = true,
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
      const ownerCorrection = allowGlobalOwnerCorrection && triggerSignal !== undefined
        && latestSelection?.id === triggerSignal.id
        && isActivationEligibleSignal(triggerSignal)
        && triggerSignal.interpretation_trust !== 'behavioral-inference'
        && ((triggerSignal.stance === 'support' && triggerSignal.candidate_value !== candidate)
          || (triggerSignal.stance === 'contradict' && triggerSignal.candidate_value === candidate))
      const behavioralCorrection = triggerSignal !== undefined
        && latestSelection?.id === triggerSignal.id
        && triggerSignal.interpretation_trust === 'behavioral-inference'
        && triggerSignal.source === 'delivery-observation'
        && triggerSignal.stance === 'support'
        && triggerSignal.candidate_value !== candidate
        && this.#behavioralSupportingCount(
          scopeKey,
          key,
          triggerSignal.candidate_value,
          now,
        ) >= this.#options.minBehavioralSignalsForActivation
        && evidence.contradictionBps > this.#options.maxContradictionBps
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
      } else if (effectState === 'active' && behavioralCorrection) {
        claimState = 'rejected'
        effectState = 'rolled-back'
        rolledBackAt = now
        version += 1
        transitionReason = 'contradicted'
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
        AND ((interpretation_trust IN ('explicit-selection', 'typed-feedback')
          AND source IN ('direct-owner-feedback', 'signed-ui-feedback'))
          OR (interpretation_trust = 'behavioral-inference' AND source = 'delivery-observation'))
      ORDER BY CASE interpretation_trust
        WHEN 'explicit-selection' THEN 0
        WHEN 'typed-feedback' THEN 1
        ELSE 2
      END ASC, occurred_at DESC, recorded_at DESC, rowid DESC
      LIMIT 1
    `).get(scopeKey, key, Math.max(0, now - this.#options.signalTtlMs)) as unknown as SignalRow | undefined
  }

  /** Shared, transaction-local gate for both planning and activation. */
  #activationError(row: HypothesisRow, scopeKey: string, now: number): PreferenceStoreError | undefined {
    if (row.risk_tier !== 'T1') {
      return new PreferenceStoreError(
        'forbidden-tier',
        'only Host-catalog T1 hypotheses can activate automatically',
      )
    }
    if (row.claim_state !== 'tentative' || row.effect_state !== 'shadow') {
      return new PreferenceStoreError('not-ready', 'hypothesis is not in an activatable shadow state')
    }
    const latestSelection = this.#latestActivationEligibleSignal(scopeKey, row.preference_key, now)
    if (latestSelection?.stance !== 'support'
      || latestSelection.candidate_value !== row.candidate_value) {
      return new PreferenceStoreError('not-ready', 'hypothesis is not the owner\'s controlling selection')
    }
    const isExplicit = latestSelection.interpretation_trust === 'explicit-selection'
    const isBehavioral = latestSelection.interpretation_trust === 'behavioral-inference'
    const requiredSignals = isBehavioral
      ? this.#options.minBehavioralSignalsForActivation
      : this.#options.minSignalsForActivation
    const supportingSignals = isBehavioral
      ? this.#behavioralSupportingCount(
          scopeKey,
          row.preference_key,
          row.candidate_value,
          now,
        )
      : row.supporting_signals
    if (row.expires_at <= now
      || (!isExplicit && supportingSignals < requiredSignals)
      || (!isExplicit && !isBehavioral && row.confidence_bps < this.#options.minConfidenceBps)
      || (!isExplicit && !isBehavioral && row.contradiction_bps > this.#options.maxContradictionBps)) {
      return new PreferenceStoreError('not-ready', 'hypothesis has insufficient current evidence')
    }
    const activeCount = (this.#database.prepare(`
      SELECT COUNT(*) AS count FROM preference_hypotheses
      WHERE scope_key = ? AND effect_state = 'active'
    `).get(scopeKey) as { count: number }).count
    if (activeCount >= this.#options.maxActiveOverlays) {
      return new PreferenceStoreError('not-ready', 'scope reached the active preference hard cap')
    }
    const sameKey = this.#database.prepare(`
      SELECT id FROM preference_hypotheses
      WHERE scope_key = ? AND preference_key = ? AND effect_state = 'active'
    `).get(scopeKey, row.preference_key) as { id: string } | undefined
    if (sameKey !== undefined) {
      return new PreferenceStoreError('conflict', 'another value for this key is active')
    }
    return undefined
  }

  #behavioralSupportingCount(
    scopeKey: string,
    key: PreferenceKey,
    candidateValue: string,
    now: number,
  ): number {
    const rows = this.#database.prepare(`
      SELECT candidate_value, stance FROM preference_signals
      WHERE scope_key = ? AND preference_key = ? AND actor_trust = 'owner-authenticated'
        AND interpretation_trust = 'behavioral-inference'
        AND source = 'delivery-observation' AND occurred_at >= ?
      ORDER BY occurred_at DESC, recorded_at DESC, rowid DESC
    `).all(
      scopeKey,
      key,
      Math.max(0, now - this.#options.signalTtlMs),
    ) as unknown as Array<{ candidate_value: string; stance: PreferenceSignalStance }>
    let streak = 0
    for (const row of rows) {
      if (row.stance !== 'support' || row.candidate_value !== candidateValue) break
      streak += 1
    }
    return streak
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

  #deleteScopeDataInTransaction(scopeKey: string, scopeDigest: string): void {
    this.#database.prepare(
      'DELETE FROM preference_owner_control_receipts WHERE scope_digest = ?',
    ).run(scopeDigest)
    this.#database.prepare(
      'DELETE FROM preference_host_activation_receipts WHERE scope_digest = ?',
    ).run(scopeDigest)
    this.#database.prepare(
      'DELETE FROM preference_host_maintenance_receipts WHERE scope_digest = ?',
    ).run(scopeDigest)
    this.#database.prepare(`
      DELETE FROM preference_exposure_corrections
      WHERE signal_id IN (SELECT id FROM preference_signals WHERE scope_key = ?)
        OR hypothesis_id IN (SELECT id FROM preference_hypotheses WHERE scope_key = ?)
    `).run(scopeKey, scopeKey)
    this.#database.prepare('DELETE FROM preference_exposures WHERE scope_key = ?').run(scopeKey)
    this.#database.prepare(`
      DELETE FROM preference_transitions
      WHERE hypothesis_id IN (SELECT id FROM preference_hypotheses WHERE scope_key = ?)
    `).run(scopeKey)
    this.#database.prepare('DELETE FROM preference_hypotheses WHERE scope_key = ?').run(scopeKey)
    this.#database.prepare('DELETE FROM preference_signals WHERE scope_key = ?').run(scopeKey)
    // Forget boundaries belong to the previous owner lineage. Retaining them
    // would reject the new owner's exact first Inbox event as "predating" its
    // own scope reset.
    this.#database.prepare(
      'DELETE FROM preference_scope_tombstones WHERE scope_digest = ?',
    ).run(scopeDigest)
  }

  #scopeAdmissionRowInTransaction(scopeKey: string): ScopeAdmissionRow {
    return this.#database.prepare(`
      SELECT admission_cursor_epoch, lineage_claim_sequence,
        admission_high_water, admission_high_water_kind,
        ignore_events_through_sequence, learning_paused, control_version
      FROM preference_scope_principals WHERE scope_key = ?
    `).get(scopeKey) as unknown as ScopeAdmissionRow
  }

  #controlCursorIsFresh(
    current: Readonly<ScopeAdmissionRow>,
    admissionCursor: Readonly<PreferenceAdmissionCursor>,
  ): boolean {
    return current.admission_cursor_epoch === admissionCursor.epoch
      && admissionCursor.sequence >= (current.lineage_claim_sequence ?? 1)
      && admissionCursor.sequence > (current.admission_high_water ?? 0)
  }

  #readCursorCanObserveCurrent(
    current: Readonly<ScopeAdmissionRow>,
    admissionCursor: Readonly<PreferenceAdmissionCursor>,
  ): boolean {
    return current.admission_cursor_epoch === admissionCursor.epoch
      && admissionCursor.sequence >= (current.lineage_claim_sequence ?? 1)
      && admissionCursor.sequence > (current.ignore_events_through_sequence ?? 0)
  }

  #admitEventCursorInTransaction(
    canonical: ReturnType<typeof canonicalPreferenceScope>,
    owner: Readonly<PreferenceScopePrincipalFence>,
    admissionCursor: Readonly<PreferenceAdmissionCursor>,
  ): boolean {
    this.#assertScopePrincipalInTransaction(canonical, owner)
    const current = this.#scopeAdmissionRowInTransaction(canonical.scopeKey)
    if (current.admission_cursor_epoch !== admissionCursor.epoch
      || admissionCursor.sequence < (current.lineage_claim_sequence ?? 1)
      || admissionCursor.sequence < (current.admission_high_water ?? 0)
      || (admissionCursor.sequence === current.admission_high_water
        && current.admission_high_water_kind !== 'event')) return false
    if (admissionCursor.sequence > (current.admission_high_water ?? 0)) {
      const changed = this.#database.prepare(`
        UPDATE preference_scope_principals
        SET admission_high_water = ?, admission_high_water_kind = 'event', updated_at = ?
        WHERE scope_key = ? AND principal_digest = ?
          AND principal_lineage_id = ? AND principal_lineage_version = ?
          AND generation = ? AND purge_pending = 0
          AND admission_cursor_epoch = ? AND admission_high_water IS ?
      `).run(
        admissionCursor.sequence,
        this.#now(),
        canonical.scopeKey,
        owner.principalDigest,
        owner.principalLineageId,
        owner.principalLineageVersion,
        owner.generation,
        admissionCursor.epoch,
        current.admission_high_water,
      )
      if (changed.changes !== 1) {
        throw new PreferenceStoreError('conflict', 'preference event admission cursor changed')
      }
    }
    return current.learning_paused === 0
      && admissionCursor.sequence > (current.ignore_events_through_sequence ?? 0)
  }

  #insertOwnerControlReceipt(input: Readonly<{
    idempotencyKey: string
    hash: string
    canonical: ReturnType<typeof canonicalPreferenceScope>
    owner: Readonly<PreferenceScopePrincipalFence>
    action: 'explain' | 'export' | 'forget' | 'pause' | 'resume' | 'rollback' | 'status'
    preferenceKey?: PreferenceKey
    admissionCursor: Readonly<PreferenceAdmissionCursor>
    applied: boolean
    state: Readonly<PreferenceScopeLearningStatus>
    deletedSignals?: number
    deletedHypotheses?: number
    forgottenThrough?: number
    explanation?: readonly Readonly<PreferenceScopeLearningExplanation>[]
    rolledBack?: boolean
    rolledBackVersion?: number
    occurredAt: number
  }>): void {
    this.#database.prepare(`
      INSERT INTO preference_owner_control_receipts(
        idempotency_key, payload_hash, scope_digest, principal_digest, generation,
        action, target_preference_key, admission_cursor_epoch, admission_cursor_sequence, result_applied,
        result_paused, result_control_version, result_admission_high_water,
        result_ignore_events_through_sequence, result_signals, result_hypotheses,
        result_active_overlays, result_stored_active_overlays, result_shadow_hypotheses,
        result_deleted_signals, result_deleted_hypotheses,
        result_forgotten_through, result_explanation_json, result_rolled_back,
        result_rolled_back_version, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.idempotencyKey,
      input.hash,
      input.canonical.scopeDigest,
      input.owner.principalDigest,
      input.owner.generation,
      input.action,
      input.preferenceKey ?? null,
      input.admissionCursor.epoch,
      input.admissionCursor.sequence,
      input.applied ? 1 : 0,
      input.state.mode === 'paused' ? 1 : 0,
      input.state.controlVersion,
      input.state.admissionHighWater?.sequence ?? null,
      input.state.ignoreEventsThrough?.sequence ?? null,
      input.state.signals,
      input.state.hypotheses,
      input.state.activeOverlays,
      input.state.storedActiveOverlays,
      input.state.shadowHypotheses,
      input.deletedSignals ?? 0,
      input.deletedHypotheses ?? 0,
      input.forgottenThrough ?? -1,
      input.explanation === undefined ? null : JSON.stringify(input.explanation),
      input.rolledBack === true ? 1 : 0,
      input.rolledBackVersion ?? null,
      input.occurredAt,
    )
  }

  #ownerControlExplanationFromReceipt(
    receipt: Readonly<OwnerControlReceiptRow>,
  ): readonly Readonly<PreferenceScopeLearningExplanation>[] {
    if (receipt.result_explanation_json === null) {
      throw new PreferenceStoreError('conflict', 'learning summary receipt is missing its snapshot')
    }
    let value: unknown
    try {
      value = JSON.parse(receipt.result_explanation_json)
    } catch {
      throw new PreferenceStoreError('conflict', 'learning summary receipt snapshot is corrupt')
    }
    if (!Array.isArray(value)) {
      throw new PreferenceStoreError('conflict', 'learning summary receipt snapshot is corrupt')
    }
    const explanation = value.map(entry => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new PreferenceStoreError('conflict', 'learning summary receipt snapshot is corrupt')
      }
      const row = entry as Partial<PreferenceScopeLearningExplanation>
      const key = exactT1PreferenceKey(row.key)
      try {
        catalogSelection(key, row.value)
      } catch {
        throw new PreferenceStoreError('conflict', 'learning summary receipt snapshot is corrupt')
      }
      if (!['active', 'inactive', 'rolled-back', 'shadow', 'suppressed'].includes(row.state ?? '')
        || !Number.isSafeInteger(row.version) || row.version! < 1
        || [row.supportingSignals, row.contradictingSignals, row.evidenceMass]
          .some(count => !Number.isSafeInteger(count) || count! < 0)) {
        throw new PreferenceStoreError('conflict', 'learning summary receipt snapshot is corrupt')
      }
      return Object.freeze({
        key,
        value: row.value!,
        state: row.state!,
        version: row.version!,
        supportingSignals: row.supportingSignals!,
        contradictingSignals: row.contradictingSignals!,
        evidenceMass: row.evidenceMass!,
      })
    })
    return Object.freeze(explanation)
  }

  #ownerControlStateFromReceipt(
    receipt: Readonly<OwnerControlReceiptRow>,
  ): PreferenceScopeLearningStatus {
    return Object.freeze({
      mode: receipt.result_paused === 1 ? 'paused' : 'active',
      signals: receipt.result_signals,
      hypotheses: receipt.result_hypotheses,
      activeOverlays: receipt.result_active_overlays,
      storedActiveOverlays: receipt.result_stored_active_overlays,
      shadowHypotheses: receipt.result_shadow_hypotheses,
      controlVersion: receipt.result_control_version,
      admissionHighWater: receipt.result_admission_high_water === null
        ? undefined
        : Object.freeze({
            epoch: receipt.admission_cursor_epoch,
            sequence: receipt.result_admission_high_water,
          }),
      ignoreEventsThrough: receipt.result_ignore_events_through_sequence === null
        ? undefined
        : Object.freeze({
            epoch: receipt.admission_cursor_epoch,
            sequence: receipt.result_ignore_events_through_sequence,
          }),
    })
  }

  #assertScopePrincipalInTransaction(
    canonical: ReturnType<typeof canonicalPreferenceScope>,
    owner: string | Readonly<PreferenceScopePrincipalFence> | undefined,
  ): void {
    if (owner === undefined) return
    const principalDigest = typeof owner === 'string'
      ? preferencePrincipalDigest(owner)
      : owner.principalDigest
    const generation = typeof owner === 'string' ? undefined : owner.generation
    if (typeof owner !== 'string'
      && (owner.scopeKey !== canonical.scopeKey
        || !/^[a-f0-9]{64}$/u.test(owner.principalDigest)
        || typeof owner.principalLineageId !== 'string'
        || owner.principalLineageId.length < 1
        || Buffer.byteLength(owner.principalLineageId) > 500
        || !Number.isSafeInteger(owner.principalLineageVersion)
        || owner.principalLineageVersion < 1
        || !Number.isSafeInteger(owner.generation) || owner.generation < 1)) {
      throw new PreferenceStoreError('conflict', 'scope principal fence is invalid')
    }
    const row = this.#database.prepare(`
      SELECT generation, principal_lineage_id, principal_lineage_version,
        admission_cursor_epoch
      FROM preference_scope_principals
      WHERE scope_key = ? AND principal_digest = ? AND purge_pending = 0
    `).get(canonical.scopeKey, principalDigest) as {
      generation: number
      principal_lineage_id: string | null
      principal_lineage_version: number | null
      admission_cursor_epoch: string | null
    } | undefined
    if (row === undefined || row.admission_cursor_epoch === null
      || (generation !== undefined && (row.generation !== generation
      || row.principal_lineage_id !== (owner as PreferenceScopePrincipalFence).principalLineageId
      || row.principal_lineage_version !== (owner as PreferenceScopePrincipalFence).principalLineageVersion))) {
      throw new PreferenceStoreError('conflict', 'scope principal fence changed')
    }
  }

  #scopeLearningStatusInTransaction(
    canonical: ReturnType<typeof canonicalPreferenceScope>,
    owner: Readonly<PreferenceScopePrincipalFence>,
    refresh = true,
  ): PreferenceScopeLearningStatus {
    this.#assertScopePrincipalInTransaction(canonical, owner)
    if (refresh) this.#refreshScopeInTransaction(canonical.scopeKey, canonical.scope, this.#now())
    const control = this.#database.prepare(`
      SELECT learning_paused, control_version, admission_cursor_epoch,
        admission_high_water, ignore_events_through_sequence
      FROM preference_scope_principals WHERE scope_key = ?
    `).get(canonical.scopeKey) as {
      learning_paused: number
      control_version: number
      admission_cursor_epoch: string
      admission_high_water: number | null
      ignore_events_through_sequence: number | null
    }
    const counts = this.#database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM preference_signals WHERE scope_key = ?) AS signals,
        COUNT(*) AS hypotheses,
        SUM(CASE WHEN effect_state = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN effect_state = 'shadow' THEN 1 ELSE 0 END) AS shadow
      FROM preference_hypotheses WHERE scope_key = ?
    `).get(canonical.scopeKey, canonical.scopeKey) as {
      signals: number
      hypotheses: number
      active: number | null
      shadow: number | null
    }
    return Object.freeze({
      mode: control.learning_paused === 1 ? 'paused' : 'active',
      signals: counts.signals,
      hypotheses: counts.hypotheses,
      activeOverlays: control.learning_paused === 1 ? 0 : (counts.active ?? 0),
      storedActiveOverlays: counts.active ?? 0,
      shadowHypotheses: counts.shadow ?? 0,
      controlVersion: control.control_version,
      admissionHighWater: control.admission_high_water === null
        ? undefined
        : Object.freeze({
            epoch: control.admission_cursor_epoch,
            sequence: control.admission_high_water,
          }),
      ignoreEventsThrough: control.ignore_events_through_sequence === null
        ? undefined
        : Object.freeze({
            epoch: control.admission_cursor_epoch,
            sequence: control.ignore_events_through_sequence,
          }),
    })
  }

  #assertScopeLearningActiveInTransaction(
    canonical: ReturnType<typeof canonicalPreferenceScope>,
  ): void {
    const row = this.#database.prepare(`
      SELECT learning_paused FROM preference_scope_principals
      WHERE scope_key = ? AND purge_pending = 0 AND admission_cursor_epoch IS NOT NULL
    `).get(canonical.scopeKey) as { learning_paused: number } | undefined
    if (row?.learning_paused === 1) {
      throw new PreferenceStoreError('learning-paused', 'preference learning is paused for this scope')
    }
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
