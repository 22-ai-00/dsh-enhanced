import type { EvolutionMutation } from './types.js'

export interface EvolutionMutationReview {
  action: 'evolution.adopt' | 'evolution.retire' | 'evolution.owner-undo'
  resource: Readonly<{ kind: 'evolution'; id: string }>
  summary: string
  diff: string
}

function boundedSummary(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= 120) return value
  let bounded = ''
  for (const character of value) {
    if (Buffer.byteLength(`${bounded}${character}...`, 'utf8') > 120) break
    bounded += character
  }
  return `${bounded}...`
}

/** Canonical owner-review tuple for every behaviour-affecting mutation field. */
export function evolutionMutationReview(mutation: EvolutionMutation): EvolutionMutationReview {
  if (mutation.op === 'adopt') {
    const projection = {
      op: mutation.op,
      ruleId: mutation.ruleId,
      scopeKey: mutation.input.scopeKey,
      situation: mutation.input.situation,
      guidance: mutation.input.guidance,
      baseline: mutation.baseline,
      evidence: mutation.evidence,
    }
    return Object.freeze({
      action: 'evolution.adopt',
      resource: Object.freeze({ kind: 'evolution', id: `situation:${mutation.input.situation}` }),
      summary: boundedSummary(`Adopt learned guidance for ${mutation.input.situation}`),
      diff: JSON.stringify(projection),
    })
  }
  if (mutation.op === 'owner-undo') {
    const projection = {
      op: mutation.op,
      scopeKey: mutation.scopeKey,
      ruleId: mutation.ruleId,
      situation: mutation.situation,
      guidance: mutation.guidance,
      generation: mutation.generation,
      expectedVersion: mutation.expectedVersion,
      reason: mutation.reason,
    }
    return Object.freeze({
      action: 'evolution.owner-undo',
      resource: Object.freeze({ kind: 'evolution', id: `rule:${mutation.ruleId}` }),
      summary: boundedSummary(`Undo learned guidance rule ${mutation.ruleId}`),
      diff: JSON.stringify(projection),
    })
  }
  const projection = {
    op: mutation.op,
    scopeKey: mutation.scopeKey,
    ruleId: mutation.ruleId,
    situation: mutation.situation,
    guidance: mutation.guidance,
    generation: mutation.generation,
    expectedVersion: mutation.expectedVersion,
    reason: mutation.reason,
    evaluation: mutation.evaluation,
    baseline: mutation.baseline,
    evidence: mutation.evidence,
  }
  return Object.freeze({
    action: 'evolution.retire',
    resource: Object.freeze({ kind: 'evolution', id: `rule:${mutation.ruleId}` }),
    summary: boundedSummary(`Retire learned guidance rule ${mutation.ruleId}`),
    diff: JSON.stringify(projection),
  })
}
