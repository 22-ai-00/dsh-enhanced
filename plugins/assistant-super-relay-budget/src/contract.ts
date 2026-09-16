/**
 * Short-lived primary-source contract for the internal Super Relay OpenAI
 * Responses route. Expiry disables both dispatch and metering.
 *
 * The gateway publishes no public protocol/pricing documentation; the contract
 * was established against the live endpoint with real, non-synthetic probes
 * (see checkedAt). It must be re-verified before expiry.
 */
export const SUPER_RELAY_RESPONSES_CONTRACT = Object.freeze({
  id: 'super-relay-responses-2026-09-14',
  checkedAt: '2026-09-14T00:00:00.000Z',
  expiresAt: '2026-10-14T00:00:00.000Z',
  links: Object.freeze([
    'https://super-relay.byted.org/v1',
  ]),
})

export const SUPER_RELAY_PROVIDER = 'super-relay'
export const SUPER_RELAY_MODELS = Object.freeze(['auto_model/alwaysday1'] as const)
export type SuperRelayModel = typeof SUPER_RELAY_MODELS[number]
/**
 * Conservative per-request input upper bound. `auto_model/alwaysday1` declares
 * no context window; this is a deliberately conservative fail-closed ceiling
 * well below the 1,000,000-token windows the gateway declares for its other
 * models, NOT an estimate of what any request will consume. Real measured
 * strategy probes stayed under 1,000 input tokens.
 */
export const SUPER_RELAY_INPUT_TOKEN_UPPER_BOUND = 200_000

export function assertCurrentContract(now = Date.now()): void {
  if (!Number.isFinite(now) || now >= Date.parse(SUPER_RELAY_RESPONSES_CONTRACT.expiresAt)) {
    throw new Error('assistant-super-relay-budget: Super Relay protocol contract has expired; update and review it before dispatch')
  }
}

export function isSuperRelayModel(value: unknown): value is SuperRelayModel {
  return typeof value === 'string' && (SUPER_RELAY_MODELS as readonly string[]).includes(value)
}
