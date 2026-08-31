/** Host-owned T1 preference keys shared by Delivery validation and learning. */
export const assistantT1PreferenceKeys = Object.freeze([
  'response.verbosity',
  'response.structure',
  'response.language',
  'response.explanation_depth',
  'suggestion.frequency',
  'recommendation.ranking',
] as const)

export type AssistantT1PreferenceKey = typeof assistantT1PreferenceKeys[number]

/** Closed values that may be exported or applied as reversible T1 overlays. */
export const assistantT1PreferenceValues = Object.freeze({
  'response.verbosity': Object.freeze(['concise', 'balanced', 'detailed']),
  'response.structure': Object.freeze(['prose', 'bullets', 'mixed']),
  'response.language': Object.freeze(['zh-CN', 'en']),
  'response.explanation_depth': Object.freeze(['result-first', 'balanced', 'tutorial']),
  'suggestion.frequency': Object.freeze(['low', 'normal']),
  'recommendation.ranking': Object.freeze(['recency', 'familiarity', 'evidence']),
} satisfies Readonly<Record<AssistantT1PreferenceKey, readonly string[]>>)
