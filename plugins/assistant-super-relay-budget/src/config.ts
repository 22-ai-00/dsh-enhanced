import Schema from '@deepseek-ai/schemastery'

export interface SuperRelayGoalMeteredConfig {
  enabled?: boolean
  /** Credential reference only; this plugin never accepts a literal API key. */
  apiKeyEnv?: string
  /**
   * Gateway base URL. Must be provided by the deployment (profile config or
   * the `SUPER_RELAY_BASE_URL` environment variable); no endpoint is baked in.
   */
  baseUrl?: string
  timeoutMs?: number
  maxResponseBytes?: number
  defaultMaxTokens?: number
}

const fields = new Set(['enabled', 'apiKeyEnv', 'baseUrl', 'timeoutMs', 'maxResponseBytes', 'defaultMaxTokens'])
const ref = Schema.string().pattern(/^[A-Z_][A-Z0-9_]*$/u)

const schema = Schema.object({
  enabled: Schema.boolean().default(false),
  apiKeyEnv: ref.default('SUPER_RELAY_API_KEY'),
  baseUrl: Schema.string().pattern(/^https?:\/\/[A-Za-z0-9._-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/u),
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

export interface NormalizedSuperRelayConfig extends Required<Omit<SuperRelayGoalMeteredConfig, 'baseUrl'>> {
  /** Normalized base URL without a trailing slash; empty when the deployment did not configure one. */
  readonly baseUrl: string
}

/**
 * Resolve the gateway base URL from config or `SUPER_RELAY_BASE_URL`. No
 * endpoint is compiled into the package: the internal gateway address belongs
 * to the deployment, not to a publicly published bundle.
 */
export function normalizeConfig(input?: SuperRelayGoalMeteredConfig,
  environment: Readonly<Record<string, string | undefined>> = {}): Readonly<NormalizedSuperRelayConfig> {
  const config = Config(input) as SuperRelayGoalMeteredConfig
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(String(config.apiKeyEnv))) throw new Error('assistant-super-relay-budget: invalid apiKeyEnv')
  const baseUrl = (config.baseUrl ?? environment.SUPER_RELAY_BASE_URL ?? '').replace(/\/+$/u, '')
  if (baseUrl.length > 0 && !/^https?:\/\/[A-Za-z0-9._-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/u.test(baseUrl)) {
    throw new Error('assistant-super-relay-budget: invalid baseUrl')
  }
  return Object.freeze({ ...(config as Required<Omit<SuperRelayGoalMeteredConfig, 'baseUrl'>>), baseUrl })
}
