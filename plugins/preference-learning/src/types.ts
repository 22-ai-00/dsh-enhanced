import type { PreferenceKey, PreferenceRiskTier } from './catalog.js'

export const preferenceSignalStances = ['support', 'contradict'] as const
export type PreferenceSignalStance = typeof preferenceSignalStances[number]

export const preferenceActorTrustLevels = [
  'owner-authenticated', 'delegated-authenticated', 'system-attested', 'unverified',
] as const
export type PreferenceActorTrust = typeof preferenceActorTrustLevels[number]

export const preferenceInterpretationTrustLevels = [
  'explicit-selection', 'typed-feedback', 'behavioral-inference', 'model-inference',
] as const
export type PreferenceInterpretationTrust = typeof preferenceInterpretationTrustLevels[number]

export const preferenceSignalSources = [
  'direct-owner-feedback', 'signed-ui-feedback', 'delivery-observation',
  'evaluation-outcome', 'system-observation',
] as const
export type PreferenceSignalSource = typeof preferenceSignalSources[number]

export const preferenceClaimStates = ['tentative', 'proposed', 'confirmed', 'rejected', 'expired'] as const
export type PreferenceClaimState = typeof preferenceClaimStates[number]

export const preferenceEffectStates = ['shadow', 'active', 'suppressed', 'rolled-back', 'inactive'] as const
export type PreferenceEffectState = typeof preferenceEffectStates[number]

export const preferenceRollbackReasons = [
  'owner-rejected', 'contradicted', 'regression', 'expired', 'superseded', 'operator-request',
] as const
export type PreferenceRollbackReason = typeof preferenceRollbackReasons[number]

export interface PreferenceScope {
  workspace: string
  preset: string
}

/** Content-free evidence: every field is a bounded enum/catalog value or identifier. */
export interface PreferenceSignalInput {
  scope: PreferenceScope
  preferenceKey: PreferenceKey
  candidateValue: string
  stance: PreferenceSignalStance
  actorTrust: PreferenceActorTrust
  interpretationTrust: PreferenceInterpretationTrust
  source: PreferenceSignalSource
  occurredAt: number
  idempotencyKey: string
}

/**
 * Unprivileged Host observation. The service assigns system actor trust and
 * never lets this surface claim authenticated-owner provenance.
 */
export interface PreferenceObservationInput {
  scope: PreferenceScope
  preferenceKey: PreferenceKey
  candidateValue: string
  stance: PreferenceSignalStance
  interpretationTrust: Extract<PreferenceInterpretationTrust, 'behavioral-inference' | 'model-inference'>
  source: Extract<PreferenceSignalSource, 'delivery-observation' | 'evaluation-outcome' | 'system-observation'>
  occurredAt: number
  idempotencyKey: string
}

export interface StoredPreferenceSignal extends PreferenceSignalInput {
  id: string
  riskTier: PreferenceRiskTier
  recordedAt: number
}

export interface PreferenceHypothesis {
  id: string
  scope: PreferenceScope
  preferenceKey: PreferenceKey
  candidateValue: string
  riskTier: Extract<PreferenceRiskTier, 'T1' | 'T2'>
  claimState: PreferenceClaimState
  effectState: PreferenceEffectState
  confidenceBps: number
  contradictionBps: number
  supportingSignals: number
  contradictingSignals: number
  evidenceMass: number
  expiresAt: number
  activatedAt: number | undefined
  rolledBackAt: number | undefined
  version: number
  createdAt: number
  updatedAt: number
}

export interface PreferenceReview {
  hypotheses: readonly PreferenceHypothesis[]
  activeOverlay: string | undefined
}

export interface PreferenceHealth {
  ready: true
  enabled: boolean
  schemaVersion: number
  signals: number
  hypotheses: number
  active: number
  shadow: number
  proposed: number
  rolledBack: number
  expired: number
  lastRecordedAt: number | undefined
}

export interface PreferenceLimits {
  signalTtlMs: number
  hypothesisTtlMs: number
  minSignalsForActivation: number
  minConfidenceBps: number
  maxContradictionBps: number
  maxActiveOverlays: number
  maxReviewHypotheses: number
  maxOverlayBytes: number
  maintenanceIntervalMs: number
  maintenanceBatchSize: number
}

export interface PreferenceMaintenanceResult {
  deletedSignals: number
}
