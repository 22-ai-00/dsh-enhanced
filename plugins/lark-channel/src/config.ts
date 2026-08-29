import Schema from '@deepseek-ai/schemastery'

export interface Config {
  enabled?: boolean
  account: string
  tenant: string
  appId: string
  appSecretEnv?: string
  credentialHandle?: string
  credentialPurpose?: string
  credentialLeaseMs?: number
  domain?: 'feishu' | 'lark'
  requireMentionInGroups?: boolean
  showProgress?: boolean
  progressDetails?: 'off' | 'direct'
  statusReactions?: boolean
  maxTextBytes?: number
  staleAfterMs?: number
  handshakeTimeoutMs?: number
  imageDownloadTimeoutMs?: number
}

const schema = Schema.object({
  enabled: Schema.boolean().default(false),
  account: Schema.string().min(1).pattern(/^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/).required(),
  tenant: Schema.string().min(1).pattern(/^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/).required(),
  appId: Schema.string().pattern(/^cli_[0-9a-fA-F]{16}$/).required(),
  appSecretEnv: Schema.string().pattern(/^[A-Z_][A-Z0-9_]*$/),
  credentialHandle: Schema.string().pattern(/^[A-Za-z0-9][A-Za-z0-9._@/-]{0,127}$/),
  credentialPurpose: Schema.string().pattern(/^[A-Za-z0-9][A-Za-z0-9._@/-]{0,127}$/).default('connect'),
  credentialLeaseMs: Schema.number().step(1).min(1_000).max(86_400_000).default(86_400_000),
  domain: Schema.union(['feishu', 'lark'] as const).default('feishu'),
  requireMentionInGroups: Schema.boolean().default(true),
  showProgress: Schema.boolean().default(true),
  progressDetails: Schema.union(['off', 'direct'] as const).default('direct'),
  statusReactions: Schema.boolean().default(true),
  maxTextBytes: Schema.number().step(1).min(1).max(1024 * 1024).default(65_536),
  staleAfterMs: Schema.number().step(1).min(1_000).max(86_400_000).default(300_000),
  handshakeTimeoutMs: Schema.number().step(1).min(1_000).max(120_000).default(15_000),
  imageDownloadTimeoutMs: Schema.number().step(1).min(1_000).max(120_000).default(30_000),
}) as Schema<Config>

const fields = new Set([
  'account',
  'appId',
  'appSecretEnv',
  'credentialHandle',
  'credentialLeaseMs',
  'credentialPurpose',
  'domain',
  'enabled',
  'handshakeTimeoutMs',
  'imageDownloadTimeoutMs',
  'maxTextBytes',
  'progressDetails',
  'requireMentionInGroups',
  'showProgress',
  'staleAfterMs',
  'statusReactions',
  'tenant',
])

export const Config = new Proxy(schema, {
  apply(target, thisArg, argumentsList: [unknown]) {
    const input = argumentsList[0]
    if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
      const unknown = Object.keys(input).find(field => !fields.has(field))
      if (unknown !== undefined) throw new Error(`lark-channel: unknown configuration field: ${unknown}`)
    }
    const parsed = Reflect.apply(target, thisArg, argumentsList) as Config
    if (parsed.appSecretEnv !== undefined && parsed.credentialHandle !== undefined) {
      throw new Error('lark-channel: configure credentialHandle or appSecretEnv, not both')
    }
    if (parsed.enabled && parsed.appSecretEnv === undefined && parsed.credentialHandle === undefined) {
      throw new Error('lark-channel: enabled channel requires credentialHandle or appSecretEnv')
    }
    return parsed
  },
}) as Schema<Config>
