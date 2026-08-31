import { createHash } from 'node:crypto'
import type { RecoveryBootstrapAttestation } from './types.js'

const DIGEST = /^[a-f\d]{64}$/u
const MAX_ATTESTATIONS = 100
const MAX_ATTESTATION_SET_BYTES = 131_072

/** SHA-256 of the canonical empty bootstrap-attestation JSON array (`[]`). */
export const EMPTY_BOOTSTRAP_ATTESTATION_SET_DIGEST
  = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'

export class RecoveryBootstrapAttestationError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = 'RecoveryBootstrapAttestationError'
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0)!
    return point <= 0x1f || point === 0x7f
  })
}

function boundedText(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== 'string') {
    throw new RecoveryBootstrapAttestationError(`${field} must be a string`)
  }
  const normalized = value.normalize('NFC').trim()
  if (normalized === ''
    || Buffer.byteLength(normalized, 'utf8') > maximumBytes
    || hasControlCharacter(normalized)) {
    throw new RecoveryBootstrapAttestationError(`${field} must contain bounded printable text`)
  }
  return normalized
}

function digestText(value: unknown, field: string): string {
  const normalized = boundedText(value, field, 64).toLowerCase()
  if (!DIGEST.test(normalized)) {
    throw new RecoveryBootstrapAttestationError(`${field} must be a SHA-256 digest`)
  }
  return normalized
}

/**
 * Canonicalize and freeze the complete Recovery bootstrap attestation set.
 *
 * This function is the public byte-level contract used by Recovery schema v4:
 * entries are normalized, ordered by automation id, encoded with native
 * `JSON.stringify`, and limited to the exact durable bounds accepted by the
 * Store. It performs no I/O and never mutates the caller's array or entries.
 */
export function canonicalRecoveryBootstrapAttestationSet(
  raw: readonly RecoveryBootstrapAttestation[],
): readonly RecoveryBootstrapAttestation[] {
  if (!Array.isArray(raw) || raw.length > MAX_ATTESTATIONS) {
    throw new RecoveryBootstrapAttestationError('bootstrap attestations exceed their safe bound')
  }
  const attestations = raw.map((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new RecoveryBootstrapAttestationError(`bootstrap attestations[${index}] is invalid`)
    }
    if (!['active', 'paused', 'preview'].includes(value.activationState)) {
      throw new RecoveryBootstrapAttestationError(
        `bootstrap attestations[${index}].activationState is invalid`,
      )
    }
    return Object.freeze({
      automationId: boundedText(
        value.automationId,
        `bootstrap attestations[${index}].automationId`,
        300,
      ),
      activationState: value.activationState,
      activationNonce: boundedText(
        value.activationNonce,
        `bootstrap attestations[${index}].activationNonce`,
        200,
      ),
      activationPlanDigest: digestText(
        value.activationPlanDigest,
        `bootstrap attestations[${index}].activationPlanDigest`,
      ),
    })
  }).sort((left, right) => left.automationId < right.automationId
    ? -1
    : left.automationId > right.automationId ? 1 : 0)
  if (new Set(attestations.map(value => value.automationId)).size !== attestations.length) {
    throw new RecoveryBootstrapAttestationError('bootstrap automation ids must be unique')
  }
  const frozen = Object.freeze(attestations)
  if (Buffer.byteLength(JSON.stringify(frozen), 'utf8') > MAX_ATTESTATION_SET_BYTES) {
    throw new RecoveryBootstrapAttestationError('bootstrap attestations exceed their durable bound')
  }
  return frozen
}

/** SHA-256 over the schema-v4 canonical attestation-set JSON bytes. */
export function recoveryBootstrapAttestationSetDigest(
  raw: readonly RecoveryBootstrapAttestation[],
): string {
  const canonical = canonicalRecoveryBootstrapAttestationSet(raw)
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}
