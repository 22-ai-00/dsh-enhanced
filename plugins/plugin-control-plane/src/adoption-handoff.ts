export interface AdoptionHandoffTerms { schemaVersion: 1; coordinatorId: string; maximumWindowMs: number; commit: 'target-host' }
export interface AdoptionHandoffRecord { planId: string; planDigest: string; coordinatorId: string; createdAt: number; expiresAt: number; revokedAt?: number }

export function validateAdoptionHandoffTerms(value: unknown): asserts value is AdoptionHandoffTerms {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid adoption handoff terms')
  const v = value as Record<string, unknown>
  if (Object.keys(v).sort().join(',') !== 'commit,coordinatorId,maximumWindowMs,schemaVersion'
    || v.schemaVersion !== 1 || v.commit !== 'target-host' || typeof v.coordinatorId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(v.coordinatorId)
    || typeof v.maximumWindowMs !== 'number' || !Number.isSafeInteger(v.maximumWindowMs) || v.maximumWindowMs < 1_000 || v.maximumWindowMs > 86_400_000) throw new Error('invalid adoption handoff terms')
}
