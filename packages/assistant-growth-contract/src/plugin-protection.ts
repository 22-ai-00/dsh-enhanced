/**
 * Single source of truth for the two protected-plugin trust boundaries.
 *
 * This module lives inside the inert growth-contract package because that
 * package is already part of the sealed RSI bootstrap dependency closure
 * (plugin-control-plane + assistant-growth-contract). Introducing a third
 * runtime package into the control-plane dependency graph would break the
 * sealed manifest validation in rsi-authority-runtime, which bounds and
 * audits exactly those two packages.
 *
 * `MODEL_PROPOSAL_PROTECTED_PLUGINS` (23 names) is the growth-proposal
 * boundary: plugins the growth model may never read targets for, read source
 * of, or prepare modify/revision proposals against. Both defence layers
 * (growth-driver allowlist and control-plane worktree gate) consume it.
 *
 * `OWNER_REPAIR_PROTECTED_PLUGINS` (12 immutable safety roots) is the strict
 * subset that also excludes plugins from the owner source-repair channel and
 * its signature authorities. Governance machinery added later (growth-driver,
 * recovery, evolution, …) must stay repairable by the owner channel, so it
 * joins only the model-proposal set.
 *
 * Plain data only: no bundle, no services, no I/O.
 */

export const MODEL_PROPOSAL_PROTECTED_PLUGINS: ReadonlySet<string> = new Set([
  'assistant-delivery',
  'lark-channel',
  'assistant-automations',
  'assistant-policy',
  'credentials-keychain',
  'assistant-evaluation',
  'assistant-verifier',
  'assistant-deepseek-budget',
  'assistant-skills',
  'assistant-isolation',
  'assistant-web-owner',
  'plugin-control-plane',
  'assistant-growth-driver',
  'assistant-recovery',
  'assistant-evolution',
  'owner-console',
  'assistant-actions',
  'assistant-work-items',
  'assistant-goals',
  'event-triggers',
  'assistant-heartbeat',
  'assistant-proactive',
  'assistant-memory-learning',
])

/** Immutable safety roots excluded even from the owner source-repair channel. */
export const OWNER_REPAIR_PROTECTED_PLUGINS: ReadonlySet<string> = new Set([
  'assistant-delivery',
  'lark-channel',
  'assistant-automations',
  'assistant-policy',
  'credentials-keychain',
  'assistant-evaluation',
  'assistant-verifier',
  'assistant-deepseek-budget',
  'assistant-skills',
  'assistant-isolation',
  'assistant-web-owner',
  'plugin-control-plane',
])

export function assertProtectedSetsConsistent(): void {
  for (const name of OWNER_REPAIR_PROTECTED_PLUGINS) {
    if (!MODEL_PROPOSAL_PROTECTED_PLUGINS.has(name)) {
      throw new Error(`owner-repair protected plugin ${name} must also be model-proposal protected`)
    }
  }
  if (MODEL_PROPOSAL_PROTECTED_PLUGINS.size <= OWNER_REPAIR_PROTECTED_PLUGINS.size) {
    throw new Error('model-proposal protection must be a strict superset of owner-repair protection')
  }
}

assertProtectedSetsConsistent()
