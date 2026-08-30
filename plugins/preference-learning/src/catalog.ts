export const preferenceRiskTiers = ['T0', 'T1', 'T2', 'T3'] as const
export type PreferenceRiskTier = typeof preferenceRiskTiers[number]

/**
 * Host-owned catalog. Callers select an exact key/value pair; they cannot add
 * values, render instructions, or lower a key's risk tier.
 */
export const preferenceCatalog = Object.freeze({
  'feedback.response': Object.freeze({
    riskTier: 'T0',
    values: Object.freeze([
      'helpful', 'not-helpful', 'too-long', 'too-short', 'wrong-format',
      'wrong-action', 'unwanted-reminder',
    ]),
  }),
  'interaction.response': Object.freeze({
    riskTier: 'T0',
    values: Object.freeze(['acknowledged', 'ignored', 'retried', 'corrected']),
  }),
  'response.verbosity': Object.freeze({
    riskTier: 'T1', values: Object.freeze(['concise', 'balanced', 'detailed']),
  }),
  'response.structure': Object.freeze({
    riskTier: 'T1', values: Object.freeze(['prose', 'bullets', 'mixed']),
  }),
  'response.language': Object.freeze({
    riskTier: 'T1', values: Object.freeze(['zh-CN', 'en']),
  }),
  'response.explanation_depth': Object.freeze({
    riskTier: 'T1', values: Object.freeze(['result-first', 'balanced', 'tutorial']),
  }),
  'suggestion.frequency': Object.freeze({
    riskTier: 'T1', values: Object.freeze(['low', 'normal']),
  }),
  'recommendation.ranking': Object.freeze({
    riskTier: 'T1', values: Object.freeze(['recency', 'familiarity', 'evidence']),
  }),
  'memory.retention': Object.freeze({
    riskTier: 'T2', values: Object.freeze(['session-only', 'long-term']),
  }),
  'automation.notification_time': Object.freeze({
    riskTier: 'T2', values: Object.freeze(['fixed', 'learned']),
  }),
  'external.commitments': Object.freeze({
    riskTier: 'T2', values: Object.freeze(['approval-required', 'preauthorized']),
  }),
  'provider.data_boundary': Object.freeze({
    riskTier: 'T2', values: Object.freeze(['local-only', 'configured-provider']),
  }),
  'budget.strategy': Object.freeze({
    riskTier: 'T2', values: Object.freeze(['fixed', 'adaptive']),
  }),
  'policy.approval_boundary': Object.freeze({
    riskTier: 'T3', values: Object.freeze(['host-defined']),
  }),
  'credentials.access': Object.freeze({
    riskTier: 'T3', values: Object.freeze(['host-defined']),
  }),
  'safety.risk_catalog': Object.freeze({
    riskTier: 'T3', values: Object.freeze(['host-defined']),
  }),
  'destructive.defaults': Object.freeze({
    riskTier: 'T3', values: Object.freeze(['host-defined']),
  }),
} as const)

export type PreferenceKey = keyof typeof preferenceCatalog

export interface CatalogSelection {
  key: PreferenceKey
  value: string
  riskTier: PreferenceRiskTier
}

export class PreferenceCatalogError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PreferenceCatalogError'
  }
}

export function catalogSelection(keyInput: unknown, valueInput: unknown): CatalogSelection {
  if (typeof keyInput !== 'string' || !Object.hasOwn(preferenceCatalog, keyInput)) {
    throw new PreferenceCatalogError('preferenceKey is not in the Host preference catalog')
  }
  if (typeof valueInput !== 'string') {
    throw new PreferenceCatalogError('candidateValue must be a catalog string')
  }
  const key = keyInput as PreferenceKey
  const entry = preferenceCatalog[key]
  if (!(entry.values as readonly string[]).includes(valueInput)) {
    throw new PreferenceCatalogError(`candidateValue is not allowed for ${key}`)
  }
  return Object.freeze({ key, value: valueInput, riskTier: entry.riskTier })
}

const t1Renderers: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  'response.verbosity': Object.freeze({
    concise: 'Prefer concise responses.',
    balanced: 'Prefer balanced response length.',
    detailed: 'Prefer detailed responses when useful.',
  }),
  'response.structure': Object.freeze({
    prose: 'Prefer prose over lists.',
    bullets: 'Prefer bullet lists when they improve scanning.',
    mixed: 'Use a mix of prose and lists according to the content.',
  }),
  'response.language': Object.freeze({
    'zh-CN': 'Respond in Simplified Chinese unless the current request requires another language.',
    en: 'Respond in English unless the current request requires another language.',
  }),
  'response.explanation_depth': Object.freeze({
    'result-first': 'Lead with the result and keep explanation secondary.',
    balanced: 'Balance the result with enough explanation to verify it.',
    tutorial: 'Explain unfamiliar work in a tutorial style.',
  }),
  'suggestion.frequency': Object.freeze({
    low: 'Offer optional suggestions sparingly.',
    normal: 'Offer relevant optional suggestions at a normal frequency.',
  }),
  'recommendation.ranking': Object.freeze({
    recency: 'Prefer recent options when evidence is otherwise comparable.',
    familiarity: 'Prefer options already familiar to the user when evidence is otherwise comparable.',
    evidence: 'Prefer the option with the strongest evidence.',
  }),
})

export function renderCatalogPreference(keyInput: unknown, valueInput: unknown): string {
  const selection = catalogSelection(keyInput, valueInput)
  if (selection.riskTier !== 'T1') {
    throw new PreferenceCatalogError('only T1 preferences have an automatic overlay renderer')
  }
  const rendered = t1Renderers[selection.key]?.[selection.value]
  if (rendered === undefined) throw new PreferenceCatalogError('catalog renderer is incomplete')
  return rendered
}
