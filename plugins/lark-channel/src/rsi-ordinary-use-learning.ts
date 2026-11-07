/**
 * Fresh-install half of the ordinary-use learning loop that needs no new
 * signing-key material:
 *
 * - an observe-only production intake evaluator (`assistant-proactive`) whose
 *   model route is taken from the existing Delivery deployment or from an
 *   explicit setup input, never guessed;
 * - the WorkItems evaluation switch that accepts the evaluator;
 * - the `workItemExperiences` flag on all three memory-learning grants.
 *
 * Revision capabilities and Growth `workItemFailures` pins remain outside this
 * slice because they need owner-generated key material or signed authority
 * pins. This module performs no I/O and grants no execution authority by itself.
 */

export const RSI_INTAKE_EVALUATION_RULE_ID = 'ordinary-use-intake' as const
export type RsiIntakeEvaluationCeiling = 'digest' | 'notify'

export interface RsiIntakeEvaluationRule {
  readonly ruleId: string
  readonly ceiling: RsiIntakeEvaluationCeiling
}

/** Exact `assistant-proactive.intakeEvaluation` section emitted by owner setup. */
export interface RsiIntakeEvaluationSetup {
  readonly enabled: true
  readonly rules: readonly RsiIntakeEvaluationRule[]
  readonly provider: string
  readonly model: string
}

/** Durable manifest section; adding a term here must also add it to every compiler. */
export interface RsiOrdinaryUseLearningSetup {
  readonly intakeEvaluation: RsiIntakeEvaluationSetup
}

const routePattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+~-]*$/u
const ruleIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const MAX_ROUTE_CHARS = 200
const MAX_RULES = 16
const ceilings: ReadonlySet<string> = new Set(['digest', 'notify'])

function fail(message: string): never { throw new Error(`rsi ordinary-use learning: ${message}`) }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be an object`)
  return value as Record<string, unknown>
}
function route(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ROUTE_CHARS || !routePattern.test(value)) {
    fail(`${label} must be a configured provider/model id of at most ${MAX_ROUTE_CHARS} characters`)
  }
  return value
}
function rules(value: unknown): readonly RsiIntakeEvaluationRule[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_RULES) fail(`rules must list 1 to ${MAX_RULES} entries`)
  const seen = new Set<string>()
  return value.map(entry => {
    const rule = object(entry, 'intake rule')
    const keys = Object.keys(rule).sort().join(',')
    if (keys !== 'ceiling,ruleId') fail('intake rules accept exactly ruleId and ceiling')
    const ruleId = rule.ruleId, ceiling = rule.ceiling
    if (typeof ruleId !== 'string' || !ruleIdPattern.test(ruleId) || seen.has(ruleId)) fail('intake rule ids must be unique valid ids')
    if (typeof ceiling !== 'string' || !ceilings.has(ceiling)) fail('intake rule ceilings are limited to digest or notify in this slice')
    seen.add(ruleId)
    return { ruleId, ceiling: ceiling as RsiIntakeEvaluationCeiling }
  })
}

/** Validate the persisted section; `accept`/`ignore` ceilings are rejected because this slice is observe/notify only. */
export function validateRsiOrdinaryUseLearningSetup(input: unknown): RsiOrdinaryUseLearningSetup {
  const value = object(input, 'ordinaryUseLearning')
  if (Object.keys(value).sort().join(',') !== 'intakeEvaluation') fail('ordinaryUseLearning accepts exactly intakeEvaluation')
  const evaluation = object(value.intakeEvaluation, 'intakeEvaluation')
  if (Object.keys(evaluation).sort().join(',') !== 'enabled,model,provider,rules') fail('intakeEvaluation accepts exactly enabled, rules, provider and model')
  if (evaluation.enabled !== true) fail('intakeEvaluation.enabled must be true when the section is present')
  return Object.freeze({
    intakeEvaluation: Object.freeze({
      enabled: true as const,
      rules: Object.freeze(rules(evaluation.rules).slice()) as readonly RsiIntakeEvaluationRule[],
      provider: route(evaluation.provider, 'intakeEvaluation.provider'),
      model: route(evaluation.model, 'intakeEvaluation.model'),
    }),
  })
}

/**
 * Resolve the evaluator route without inventing one. An explicit route wins;
 * otherwise the composed Delivery deployment route is used. Both values must
 * come from the caller, and a partially supplied pair fails closed.
 */
export function resolveRsiIntakeRoute(input: {
  deliveryConfig: Record<string, unknown>
  intakeProvider?: string | undefined
  intakeModel?: string | undefined
}): { provider: string; model: string } {
  const hasProvider = input.intakeProvider !== undefined
  const hasModel = input.intakeModel !== undefined
  if (hasProvider !== hasModel) fail('explicit intake provider and model must be provided together')
  const provider = hasProvider ? input.intakeProvider : input.deliveryConfig.agentProvider
  const model = hasModel ? input.intakeModel : input.deliveryConfig.agentModel
  if (typeof provider !== 'string' || typeof model !== 'string') {
    fail('ordinary-use learning requires Delivery agentProvider/agentModel or an explicit intake provider/model')
  }
  return { provider: route(provider, 'intake route provider'), model: route(model, 'intake route model') }
}

/** Build the one-time, observe-only evaluator section for a fresh installation. */
export function createRsiOrdinaryUseLearningSetup(input: {
  deliveryConfig: Record<string, unknown>
  intakeProvider?: string | undefined
  intakeModel?: string | undefined
}): RsiOrdinaryUseLearningSetup {
  const route = resolveRsiIntakeRoute(input)
  return validateRsiOrdinaryUseLearningSetup({
    intakeEvaluation: {
      enabled: true,
      rules: [{ ruleId: RSI_INTAKE_EVALUATION_RULE_ID, ceiling: 'digest' }],
      provider: route.provider,
      model: route.model,
    },
  })
}
