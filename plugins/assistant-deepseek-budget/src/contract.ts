/** Short-lived primary-source contract. Expiry disables both dispatch and metering. */
export const DEEPSEEK_CHAT_COMPLETIONS_CONTRACT = Object.freeze({
  id: 'deepseek-chat-completions-2026-09-07',
  checkedAt: '2026-09-07T00:00:00.000Z',
  expiresAt: '2026-10-08T00:00:00.000Z',
  links: Object.freeze([
    'https://api-docs.deepseek.com/api/create-chat-completion/',
    'https://api-docs.deepseek.com/quick_start/pricing/',
  ]),
})

export const DEEPSEEK_PROVIDER = 'deepseek-goal-metered'
export const DEEPSEEK_MODELS = Object.freeze(['deepseek-v4-flash', 'deepseek-v4-pro'] as const)
export type DeepSeekModel = typeof DEEPSEEK_MODELS[number]
export const DEEPSEEK_INPUT_TOKEN_UPPER_BOUND = 2_097_152

export function assertCurrentContract(now = Date.now()): void {
  if (!Number.isFinite(now) || now >= Date.parse(DEEPSEEK_CHAT_COMPLETIONS_CONTRACT.expiresAt)) {
    throw new Error('assistant-deepseek-budget: DeepSeek protocol contract has expired; update and review it before dispatch')
  }
}

export function isDeepSeekModel(value: unknown): value is DeepSeekModel {
  return typeof value === 'string' && (DEEPSEEK_MODELS as readonly string[]).includes(value)
}
