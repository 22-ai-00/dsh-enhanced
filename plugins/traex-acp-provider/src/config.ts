import Schema from '@deepseek-ai/schemastery'

export type AgySessionMode = 'default' | 'plan'
export type AcpCwdMode = 'session' | 'exact'

/**
 * Antigravity CLI (`agy acp`) wraps `session/prompt` in `<USER_REQUEST>` and silently
 * truncates input above ~192 KiB without raising an ACP error. Keep the prompt ceiling
 * safely below that cliff, while setting `DEFAULT_AGY_CONTEXT_WINDOW` to `128_000`:
 * `@deepseek-ai/dsh-compaction-basic` reserves `headroomTokens` (`65_536`) + request
 * `maxTokens` (`8_192`), so `128_000` yields a `54_272`-token pressure threshold and
 * `19_169`-token retention budget (avoiding both `MODEL_SWITCH_COMPACTION_FAILED` below
 * `86_212` and double-compaction thrashing at `112_000`), while `buildPrompt` compacts
 * large tool schemas and older tool outputs to stay within `DEFAULT_AGY_MAX_PROMPT_BYTES`.
 */
export const AGY_MAX_PROMPT_BYTES_CEILING = 190_000
export const DEFAULT_AGY_MAX_PROMPT_BYTES = 180 * 1024
export const DEFAULT_AGY_CONTEXT_WINDOW = 128_000
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 24 * 1024 * 1024

export interface TraexAcpProviderConfig {
  /** Register the experimental TraeX route (`traex-agent`) after the local runtime is prepared. */
  enabled: boolean
  /** TraeX executable name or absolute path. No shell parsing is performed. */
  command: string
  /** Fallback/pinned working directory exposed to the local ACP session. */
  cwd: string
  /** Whether a stream runs in each live DSH session workspace (`session`) or pins strictly to `cwd` (`exact`). */
  cwdMode: AcpCwdMode
  /**
   * Additional advisory TraeX model ids shown beside the live ACP catalog. `default` uses
   * TraeX's active model. Execution always validates model and reasoning selections against the fresh session.
   */
  models: string[]
  /** Register the Antigravity CLI route (`agy-agent`) over `agy acp`. */
  agyEnabled: boolean
  /** Antigravity executable name or absolute path. No shell parsing is performed. */
  agyCommand: string
  /**
   * Additional advisory Antigravity model ids shown beside the live ACP catalog. `default` uses
   * Antigravity's active model. Execution always validates selections against the fresh session.
   */
  agyModels: string[]
  /** Pass default built-in Antigravity customizations into `agy acp` (disabled by default for clean DSH backend use). */
  agyIncludeDefaultCustomizations: boolean
  /** Pass `--disable-telemetry` to `agy acp`. */
  agyDisableTelemetry: boolean
  /** Session permission mode selected after `agy acp` `session/new`. */
  agyMode: AgySessionMode
  /** Whole ACP prompt deadline. */
  timeoutMs: number
  /** Advertised context capacity (tokens) reported for `traex-agent` compaction checks. */
  contextWindow: number
  /** Advertised context capacity (tokens) reported for `agy-agent` compaction checks. */
  agyContextWindow: number
  /** Deadline for the non-model auth/catalog readiness probe. */
  authProbeTimeoutMs: number
  /** Maximum stdout/stderr bytes captured from the login-status probe. */
  maxAuthProbeBytes: number
  /** Grace period between ACP cancellation/SIGINT and SIGKILL. */
  killGraceMs: number
  /** Maximum bytes accepted in one ACP NDJSON message. */
  maxMessageBytes: number
  /** Maximum cumulative ACP stdout bytes accepted per invocation. */
  maxProtocolBytes: number
  /** Maximum ACP messages accepted per invocation. */
  maxProtocolMessages: number
  /** Maximum UTF-8 bytes of assistant text accepted per invocation. */
  maxOutputBytes: number
  /** Maximum UTF-8 bytes retained from child stderr. */
  maxStderrBytes: number
  /**
   * Maximum UTF-8 bytes in the serialized DSH request. The prompt travels as an ACP
   * `session/prompt` text block over stdin, never as an argv element, so no OS command-line
   * length limit applies here. This bound only guards against unbounded local memory and
   * NDJSON framing growth; the coding CLI still enforces its own model context window.
   */
  maxPromptBytes: number
  /**
   * Maximum UTF-8 bytes in the serialized DSH request sent to `agy-agent`. Capped at
   * `AGY_MAX_PROMPT_BYTES_CEILING` (190,000 bytes) because `agy acp` silently truncates
   * `<USER_REQUEST>` payloads above ~192 KiB. Effective limit is `min(maxPromptBytes, agyMaxPromptBytes)`.
   */
  agyMaxPromptBytes: number
  /** Maximum cumulative raw bytes of attached images forwarded in one ACP prompt request. */
  maxRequestImageBytes: number
  /** Additional environment variable names inherited by the child process. */
  extraEnvNames: string[]
  /** Include a redacted tail of child stderr in host logs. */
  logDiagnostics: boolean
}

const modelId = Schema.string().min(1).pattern(/\S/)
const command = Schema.string().min(1).pattern(/\S/)

/** Volatile schema fields validate as stable references; this provider consumes plain values. */
function unwrapConfig(config: TraexAcpProviderConfig): TraexAcpProviderConfig {
  const record = config as unknown as Record<string, unknown>
  return Object.fromEntries(Object.entries(record).map(([key, value]) => {
    const getter = value !== null && typeof value === 'object' ? (value as { get?: unknown }).get : undefined
    return [key, typeof getter === 'function' ? (value as { get(): unknown }).get() : value]
  })) as unknown as TraexAcpProviderConfig
}

const schema = Schema.object({
  enabled: Schema.boolean().default(false).volatile(),
  command: command.default('traex').volatile(),
  cwd: Schema.string().min(1).default('.'),
  cwdMode: Schema.union(['session', 'exact'] as const).default('session').volatile(),
  models: Schema.array(modelId).min(1).default(['default']),
  agyEnabled: Schema.boolean().default(false).volatile(),
  agyCommand: command.default('agy').volatile(),
  agyModels: Schema.array(modelId).min(1).default(['default']),
  agyIncludeDefaultCustomizations: Schema.boolean().default(false),
  agyDisableTelemetry: Schema.boolean().default(true),
  agyMode: Schema.union(['default', 'plan'] as const).default('default'),
  timeoutMs: Schema.natural().min(1_000).max(60 * 60_000).default(10 * 60_000),
  contextWindow: Schema.natural().min(4_096).max(10_000_000).default(200_000),
  agyContextWindow: Schema.natural().min(4_096).max(10_000_000).default(DEFAULT_AGY_CONTEXT_WINDOW),
  authProbeTimeoutMs: Schema.natural().min(1_000).max(120_000).default(30_000),
  maxAuthProbeBytes: Schema.natural().min(1_024).max(1024 * 1024).default(32 * 1024),
  killGraceMs: Schema.natural().min(100).max(30_000).default(3_000),
  maxMessageBytes: Schema.natural().min(1_024).max(16 * 1024 * 1024).default(2 * 1024 * 1024),
  maxProtocolBytes: Schema.natural().min(4 * 1_024).max(256 * 1024 * 1024).default(16 * 1024 * 1024),
  maxProtocolMessages: Schema.natural().min(16).max(1_000_000).default(10_000),
  maxOutputBytes: Schema.natural().min(1_024).max(64 * 1024 * 1024).default(2 * 1024 * 1024),
  maxStderrBytes: Schema.natural().min(256).max(4 * 1024 * 1024).default(32 * 1024),
  maxPromptBytes: Schema.natural().min(1_024).max(64 * 1024 * 1024).default(4 * 1024 * 1024),
  agyMaxPromptBytes: Schema.natural().min(1_024).max(AGY_MAX_PROMPT_BYTES_CEILING).default(DEFAULT_AGY_MAX_PROMPT_BYTES),
  maxRequestImageBytes: Schema.natural().min(1_024).max(64 * 1024 * 1024).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
  extraEnvNames: Schema.array(Schema.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
  logDiagnostics: Schema.boolean().default(false),
})

/** A live settings update hands back stable references for volatile fields; accept both. */
function unwrap(value: unknown): unknown {
  const getter = value !== null && typeof value === 'object' ? (value as { get?: unknown }).get : undefined
  return typeof getter === 'function' ? (value as { get(): unknown }).get() : value
}

export const Config = new Proxy(schema, {
  apply(target, thisArg, argumentsList: [unknown?]) {
    const raw = argumentsList[0]
    const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, unwrap(value)]))
      : raw
    return unwrapConfig(Reflect.apply(target, thisArg, [input]) as TraexAcpProviderConfig)
  },
}) as unknown as Schema<TraexAcpProviderConfig>

export function normalizeConfig(input?: TraexAcpProviderConfig): TraexAcpProviderConfig {
  const config = Config(input)
  if (new Set(config.models).size !== config.models.length) {
    throw new Error('duplicate model id in models')
  }
  if (new Set(config.agyModels).size !== config.agyModels.length) {
    throw new Error('duplicate model id in agyModels')
  }
  return config
}
