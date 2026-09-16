import Schema from '@deepseek-ai/schemastery'

export interface SuperRelayGoalMeteredConfig {
  enabled?: boolean
  /** Credential reference only; this plugin never accepts a literal API key. */
  apiKeyEnv?: string
  timeoutMs?: number
  maxResponseBytes?: number
  defaultMaxTokens?: number
}

const fields = new Set(['enabled', 'apiKeyEnv', 'timeoutMs', 'maxResponseBytes', 'defaultMaxTokens'])
const ref = Schema.string().pattern(/^[A-Z_][A-Z0-9_]*$/u)

const schema = Schema.object({
  enabled: Schema.boolean().default(false),
  apiKeyEnv: ref.default('SUPER_RELAY_API_KEY'),
  timeoutMs: Schema.natural().min(1_000).max(300_000).default(60_000),
  maxResponseBytes: Schema.natural().min(1_024).max(32 * 1024 * 1024).default(4 * 1024 * 1024),
  defaultMaxTokens: Schema.natural().min(1).max(32_768).default(8_192),
}) as Schema<SuperRelayGoalMeteredConfig>

export const Config = new Proxy(schema, {
  apply(target, thisArg, argumentsList: [unknown]) {
    const value = argumentsList[0]
    if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) throw new Error('assistant-super-relay-budget: config must be an object')
    if (value !== undefined) for (const key of Object.keys(value as object)) if (!fields.has(key)) throw new Error(`assistant-super-relay-budget: unknown config field: ${key}`)
    return Reflect.apply(target, thisArg, argumentsList) as SuperRelayGoalMeteredConfig
  },
}) as Schema<SuperRelayGoalMeteredConfig>

export function normalizeConfig(input?: SuperRelayGoalMeteredConfig): Readonly<Required<SuperRelayGoalMeteredConfig>> {
  const config = Config(input) as Required<SuperRelayGoalMeteredConfig>
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(config.apiKeyEnv)) throw new Error('assistant-super-relay-budget: invalid apiKeyEnv')
  return Object.freeze({ ...config })
}
