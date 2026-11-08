/**
 * Deterministic matching of a failed WorkItem's objective against the adopted
 * capabilities that are eligible for revision. Never uses a model: the corridor
 * must not infer a repair target from prose, so matching is exact word-boundary
 * against capability names only, and ambiguity (zero or multiple targets) fails
 * closed by returning undefined.
 */

export interface RevisionTargetCandidate {
  parentPlanId: string
  name: string
  parentSourceDigest: string
}

export interface RevisionTargetMatch {
  parentPlanId: string
  name: string
}

const MAX_OBJECTIVE_BYTES = 16_384
const MAX_TARGETS = 64
const NAME_PATTERN = /^[a-z][a-z0-9-]{1,63}$/u

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A capability name is a run of [a-z0-9-] surrounded by a non-name boundary
 * (start/end or any other character), so it appears as a distinct token.
 */
function containsNameAsToken(objective: string, name: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9-])${escapeRegExp(name)}(?:[^a-z0-9-]|$)`, 'u').test(objective)
}

/**
 * Returns the single adopted capability whose name appears as a distinct token
 * in the objective. Undefined when there is no match or more than one match,
 * when the objective is out of bounds, or when the candidate list is empty.
 */
export function matchRevisionTarget(objective: string, targets: readonly RevisionTargetCandidate[]): RevisionTargetMatch | undefined {
  if (typeof objective !== 'string' || objective.length === 0
    || Buffer.byteLength(objective, 'utf8') > MAX_OBJECTIVE_BYTES
    || !Array.isArray(targets) || targets.length === 0 || targets.length > MAX_TARGETS) {
    return undefined
  }
  const matches: RevisionTargetMatch[] = []
  const seenNames = new Map<string, string>()
  for (const target of targets) {
    if (!target || typeof target.name !== 'string' || !NAME_PATTERN.test(target.name)
      || typeof target.parentPlanId !== 'string' || !target.parentPlanId) continue
    // The same capability name behind two parent plans is an ambiguous target: fail closed.
    if (seenNames.has(target.name)) {
      if (seenNames.get(target.name) !== target.parentPlanId) return undefined
      continue
    }
    seenNames.set(target.name, target.parentPlanId)
    if (containsNameAsToken(objective, target.name)) {
      matches.push({ parentPlanId: target.parentPlanId, name: target.name })
    }
  }
  return matches.length === 1 ? matches[0] : undefined
}
