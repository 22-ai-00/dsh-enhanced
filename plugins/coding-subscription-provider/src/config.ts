import Schema from '@deepseek-ai/schemastery'
import type { ProviderId } from './providers.js'

export interface ProviderConfig {
  /** Register this local CLI as a selectable DSH provider. */
  enabled: boolean
  /** Executable name or absolute path. No shell parsing is performed. */
  command: string
  /** Static aliases shown by DSH; every provider also merges its live CLI catalog. */
  models: string[]
  /** Maximum coding-agent turns when the CLI exposes that control. */
  maxTurns: number
}

export interface GrokProviderConfig extends ProviderConfig {
  /** User attests that `grok inspect` shows session OAuth and no model API-key override. */
  userVerifiedSubscription: boolean
}

export interface CodingSubscriptionProviderConfig {
  /** Working directory exposed to each coding CLI. */
  cwd: string
  /** Whole invocation deadline. */
  timeoutMs: number
  /** Deadline for a non-model authentication status probe. */
  authProbeTimeoutMs: number
  /** Maximum stdout/stderr bytes captured from an authentication status probe. */
  maxAuthProbeBytes: number
  /** Grace period between SIGINT and SIGKILL. */
  killGraceMs: number
  /** Maximum UTF-8 bytes accepted in one stdout/stderr line. */
  maxLineBytes: number
  /** Maximum UTF-8 bytes of assistant text accepted per invocation. */
  maxOutputBytes: number
  /** Maximum UTF-8 bytes retained from stderr for a diagnostic. */
  maxStderrBytes: number
  /** Maximum UTF-8 bytes in the serialized DSH request. */
  maxPromptBytes: number
  /** Additional environment variable names inherited by the child process. */
  extraEnvNames: string[]
  /** Include a redacted tail of CLI stderr in host logs. */
  logDiagnostics: boolean
  codex: ProviderConfig
  claude: ProviderConfig
  cursor: ProviderConfig
  grok: GrokProviderConfig
}

const modelId = Schema.string().min(1).pattern(/\S/)
const command = Schema.string().min(1).pattern(/\S/)

function providerSchema(defaultCommand: string, defaultEnabled = true): Schema<ProviderConfig> {
  return Schema.object({
    enabled: Schema.boolean().default(defaultEnabled),
    command: command.default(defaultCommand),
    models: Schema.array(modelId).min(1).default(['default']),
    maxTurns: Schema.natural().min(1).max(100).default(1),
  }).default({
    enabled: defaultEnabled,
    command: defaultCommand,
    models: ['default'],
    maxTurns: 1,
  }) as Schema<ProviderConfig>
}

const grokProviderSchema = Schema.object({
  enabled: Schema.boolean().default(false),
  command: command.default('grok'),
  models: Schema.array(modelId).min(1).default(['default']),
  maxTurns: Schema.natural().min(1).max(100).default(1),
  userVerifiedSubscription: Schema.boolean().default(false),
}).default({
  enabled: false,
  command: 'grok',
  models: ['default'],
  maxTurns: 1,
  userVerifiedSubscription: false,
}) as Schema<GrokProviderConfig>

export const Config: Schema<CodingSubscriptionProviderConfig> = Schema.object({
  cwd: Schema.string().min(1).default('.'),
  timeoutMs: Schema.natural().min(1_000).max(60 * 60_000).default(10 * 60_000),
  authProbeTimeoutMs: Schema.natural().min(1_000).max(60_000).default(10_000),
  maxAuthProbeBytes: Schema.natural().min(1_024).max(1024 * 1024).default(32 * 1024),
  killGraceMs: Schema.natural().min(100).max(30_000).default(3_000),
  maxLineBytes: Schema.natural().min(1_024).max(16 * 1024 * 1024).default(256 * 1024),
  maxOutputBytes: Schema.natural().min(1_024).max(64 * 1024 * 1024).default(2 * 1024 * 1024),
  maxStderrBytes: Schema.natural().min(256).max(4 * 1024 * 1024).default(32 * 1024),
  maxPromptBytes: Schema.natural().min(1_024).max(64 * 1024 * 1024).default(128 * 1024),
  extraEnvNames: Schema.array(Schema.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
  logDiagnostics: Schema.boolean().default(false),
  codex: providerSchema('codex'),
  // Public third-party subscription delegation has an Anthropic policy caveat.
  claude: providerSchema('claude', false),
  cursor: providerSchema('cursor-agent'),
  // Grok CLI config can override OAuth with a per-model API key, so opt in only
  // after the local user verifies the effective model configuration.
  grok: grokProviderSchema,
}) as Schema<CodingSubscriptionProviderConfig>

export function normalizeConfig(config?: CodingSubscriptionProviderConfig): CodingSubscriptionProviderConfig {
  const normalized = Config(config)
  for (const provider of ['codex', 'claude', 'cursor', 'grok'] as const) {
    const models = normalized[provider].models
    if (new Set(models).size !== models.length) {
      throw new Error(`duplicate model id in ${provider}.models`)
    }
  }
  if (normalized.grok.enabled && !normalized.grok.userVerifiedSubscription) {
    throw new Error('grok.userVerifiedSubscription must be true after verifying session OAuth and model configuration')
  }
  return normalized
}

export function configForProvider(config: CodingSubscriptionProviderConfig, provider: ProviderId): ProviderConfig {
  return config[provider]
}
