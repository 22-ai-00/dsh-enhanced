import type { ExternalPrincipalKey, DeliveryPrincipal } from './types.js'
import { DeliveryStore } from './store.js'

export interface LocalPairingInput {
  databasePath: string
  principal: ExternalPrincipalKey
}

/**
 * Trusted, local-only control plane for onboarding an exact channel identity.
 * The caller must already have filesystem access to the private delivery DB.
 */
export function pairPrincipalLocally(input: LocalPairingInput): DeliveryPrincipal {
  const store = new DeliveryStore({ path: input.databasePath })
  try {
    const issued = store.issuePairing(input.principal, { ttlMs: 60_000, maxAttempts: 1 })
    return store.confirmPairing({
      challengeId: issued.challenge.id,
      principal: input.principal,
      code: issued.code,
    })
  } finally {
    store.close()
  }
}
