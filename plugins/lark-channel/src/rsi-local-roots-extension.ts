export type RsiLocalRootExtension = 'memory-learning'

const learner = 'assistant-memory-learning'
const required = ['personal-assistant', 'assistant-delivery', 'assistant-evaluation', 'assistant-verifier']
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** The only supported change to a pre-owner frozen profile's selected roots. */
export function rsiLocalUpdateBundles(original: readonly string[], extension?: RsiLocalRootExtension): string[] {
  if (!Array.isArray(original) || !original.length || original.some(value => typeof value !== 'string' || !slug.test(value))
    || new Set(original).size !== original.length) throw new Error('rsi local roots extension: invalid original roots')
  if (extension === undefined) return [...original].sort()
  if (extension !== 'memory-learning') throw new Error('rsi local roots extension: unsupported extension')
  if (original.includes(learner)) throw new Error('rsi local roots extension: learner root already installed')
  for (const value of required) if (!original.includes(value)) {
    throw new Error(`rsi local roots extension: required provider root is missing: ${value}`)
  }
  return [...original, learner].sort()
}

/** Matches the learner bundle's published cordis.patch.yml initial row. */
export const rsiMemoryLearningInitialRow = Object.freeze({
  id: 'dsh-enhanced-assistant-memory-learning',
  name: '@dsh-enhanced/assistant-memory-learning',
  disabled: true,
  inject: Object.freeze([
    'assistantDelivery', 'assistantEvaluation', 'assistantAutomations', 'personalMemory', 'assistantVerifier',
    'assistantPolicy', 'agents', 'sessions', 'tools', 'llm', 'systemPrompt',
  ]),
})
