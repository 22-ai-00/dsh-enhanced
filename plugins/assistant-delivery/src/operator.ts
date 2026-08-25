import type { ConversationBinding, ExternalPrincipalKey, DeliveryPrincipal } from './types.js'
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

export interface LocalOwnerDmBindingQuery {
  databasePath: string
  account: string
  tenant: string
  workspace: string
  agentPreset: string
}

/**
 * Reads only active, exact Lark direct-message routes. This intentionally does
 * not inspect inbound text or construct a model prompt.
 */
export function findActiveOwnerDmBindingsLocally(input: LocalOwnerDmBindingQuery): ConversationBinding[] {
  const store = new DeliveryStore({ path: input.databasePath })
  try {
    return store.listActiveBindings().filter(binding =>
      binding.conversation.channel === 'lark'
      && binding.conversation.account === input.account
      && binding.conversation.tenant === input.tenant
      && binding.conversation.kind === 'dm'
      && binding.principal.channel === 'lark'
      && binding.principal.account === input.account
      && binding.principal.tenant === input.tenant
      && binding.workspace === input.workspace
      && binding.agentPreset === input.agentPreset
      && store.getPrincipal(binding.principal)?.role === 'owner'
      && store.getPrincipal(binding.principal)?.status === 'active',
    )
  } finally {
    store.close()
  }
}
