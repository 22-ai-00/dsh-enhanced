import Schema from '@deepseek-ai/schemastery'

export interface TraexAcpProviderConfig {
  /** Register the experimental TraeX route after the local runtime is prepared. */
  enabled: boolean
  /** TraeX executable name or absolute path. No shell parsing is performed. */
  command: string
  /** Working directory exposed to the TraeX ACP session. */
  cwd: string
  /**
   * Additional advisory model ids shown beside the live ACP catalog. `default` uses TraeX's active
   * model. Execution always validates model and reasoning selections against the fresh session.
   */
  models: string[]
  /** Whole ACP prompt deadline. */
  timeoutMs: number
  /** Deadline for the non-model TraeX login-status probe. */
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
  /** Maximum UTF-8 bytes retained from TraeX stderr. */
  maxStderrBytes: number
  /**
   * Maximum UTF-8 bytes in the serialized DSH request. The prompt travels as an ACP
   * `session/prompt` text block over stdin, never as an argv element, so no OS command-line
   * length limit applies here. This bound only guards against unbounded local memory and
   * NDJSON framing growth; TraeX still enforces its own model context window.
   */
  maxPromptBytes: number
  /** Additional environment variable names inherited by the child process. */
  extraEnvNames: string[]
  /** Include a redacted tail of TraeX stderr in host logs. */
  logDiagnostics: boolean
}

const modelId = Schema.string().min(1).pattern(/\S/)
const command = Schema.string().min(1).pattern(/\S/)

export const Config: Schema<TraexAcpProviderConfig> = Schema.object({
  enabled: Schema.boolean().default(false),
  command: command.default('traex'),
  cwd: Schema.string().min(1).default('.'),
  models: Schema.array(modelId).min(1).default(['default']),
  timeoutMs: Schema.natural().min(1_000).max(60 * 60_000).default(10 * 60_000),
  authProbeTimeoutMs: Schema.natural().min(1_000).max(60_000).default(10_000),
  maxAuthProbeBytes: Schema.natural().min(1_024).max(1024 * 1024).default(32 * 1024),
  killGraceMs: Schema.natural().min(100).max(30_000).default(3_000),
  maxMessageBytes: Schema.natural().min(1_024).max(16 * 1024 * 1024).default(256 * 1024),
  maxProtocolBytes: Schema.natural().min(4 * 1_024).max(256 * 1024 * 1024).default(16 * 1024 * 1024),
  maxProtocolMessages: Schema.natural().min(16).max(1_000_000).default(10_000),
  maxOutputBytes: Schema.natural().min(1_024).max(64 * 1024 * 1024).default(2 * 1024 * 1024),
  maxStderrBytes: Schema.natural().min(256).max(4 * 1024 * 1024).default(32 * 1024),
  maxPromptBytes: Schema.natural().min(1_024).max(64 * 1024 * 1024).default(4 * 1024 * 1024),
  extraEnvNames: Schema.array(Schema.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
  logDiagnostics: Schema.boolean().default(false),
}) as Schema<TraexAcpProviderConfig>

export function normalizeConfig(input?: TraexAcpProviderConfig): TraexAcpProviderConfig {
  const config = Config(input)
  if (new Set(config.models).size !== config.models.length) {
    throw new Error('duplicate model id in models')
  }
  return config
}
