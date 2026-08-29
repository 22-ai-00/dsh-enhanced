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
  /** Advertised route context capacity in tokens; independent of tool availability. */
  contextWindow: number
}

export type CodexTransport = 'cli' | 'direct-responses'

export interface CodexProviderConfig extends ProviderConfig {
  /** Execution path. The private Responses transport must be selected explicitly. */
  transport: CodexTransport
  /** Concrete backend model used when DSH selects the `default` alias. */
  directModel: string
  /** Reasoning efforts accepted by the configured direct private Responses model. */
  directReasoningEfforts: string[]
  /** Reasoning effort materialized by DSH when a direct request omits one. */
  directDefaultReasoningEffort: string
  /** Maximum serialized private Responses request bytes, including base64 images. */
  maxRequestBytes: number
  /** Maximum accumulated base64 image payload before older images are offloaded. */
  maxRequestImageBytes: number
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
  codex: CodexProviderConfig
  claude: ProviderConfig
  cursor: ProviderConfig
  grok: GrokProviderConfig
}

const modelId = Schema.string().min(1).pattern(/\S/)
const command = Schema.string().min(1).pattern(/\S/)

const codexProviderSchema = Schema.object({
  enabled: Schema.boolean().default(true),
  command: command.default('codex'),
  models: Schema.array(modelId).min(1).default(['default']),
  maxTurns: Schema.natural().min(1).max(100).default(1),
  contextWindow: Schema.natural().min(1_024).max(16 * 1024 * 1024).default(128_000),
  transport: Schema.union(['cli', 'direct-responses'] as const).default('cli'),
  directModel: modelId.default('gpt-5.6-sol'),
  directReasoningEfforts: Schema.array(modelId).min(1)
    .default(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  directDefaultReasoningEffort: modelId.default('low'),
  maxRequestBytes: Schema.natural().min(1_024).max(128 * 1024 * 1024).default(32 * 1024 * 1024),
  maxRequestImageBytes: Schema.natural().min(1_024).max(96 * 1024 * 1024).default(24 * 1024 * 1024),
}).default({
  enabled: true,
  command: 'codex',
  models: ['default'],
  maxTurns: 1,
  contextWindow: 128_000,
  transport: 'cli',
  directModel: 'gpt-5.6-sol',
  directReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  directDefaultReasoningEffort: 'low',
  maxRequestBytes: 32 * 1024 * 1024,
  maxRequestImageBytes: 24 * 1024 * 1024,
}) as Schema<CodexProviderConfig>

function providerSchema(defaultCommand: string, defaultEnabled = true): Schema<ProviderConfig> {
  return Schema.object({
    enabled: Schema.boolean().default(defaultEnabled),
    command: command.default(defaultCommand),
    models: Schema.array(modelId).min(1).default(['default']),
    maxTurns: Schema.natural().min(1).max(100).default(1),
    contextWindow: Schema.natural().min(1_024).max(16 * 1024 * 1024).default(128_000),
  }).default({
    enabled: defaultEnabled,
    command: defaultCommand,
    models: ['default'],
    maxTurns: 1,
    contextWindow: 128_000,
  }) as Schema<ProviderConfig>
}

const grokProviderSchema = Schema.object({
  enabled: Schema.boolean().default(false),
  command: command.default('grok'),
  models: Schema.array(modelId).min(1).default(['default']),
  maxTurns: Schema.natural().min(1).max(100).default(1),
  contextWindow: Schema.natural().min(1_024).max(16 * 1024 * 1024).default(128_000),
  userVerifiedSubscription: Schema.boolean().default(false),
}).default({
  enabled: false,
  command: 'grok',
  models: ['default'],
  maxTurns: 1,
  contextWindow: 128_000,
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
  maxPromptBytes: Schema.natural().min(1_024).max(64 * 1024 * 1024).default(4 * 1024 * 1024),
  extraEnvNames: Schema.array(Schema.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
  logDiagnostics: Schema.boolean().default(false),
  codex: codexProviderSchema,
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
  if (normalized.codex.maxRequestImageBytes > normalized.codex.maxRequestBytes) {
    throw new Error('codex.maxRequestImageBytes must not exceed codex.maxRequestBytes')
  }
  if (new Set(normalized.codex.directReasoningEfforts).size !== normalized.codex.directReasoningEfforts.length) {
    throw new Error('duplicate reasoning effort in codex.directReasoningEfforts')
  }
  if (!normalized.codex.directReasoningEfforts.includes(normalized.codex.directDefaultReasoningEffort)) {
    throw new Error('codex.directDefaultReasoningEffort must be present in codex.directReasoningEfforts')
  }
  return normalized
}

export function configForProvider(config: CodingSubscriptionProviderConfig, provider: ProviderId): ProviderConfig {
  return config[provider]
}
