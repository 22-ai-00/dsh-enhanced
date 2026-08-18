/** Local coding-tool invocations. Credentials deliberately remain owned by each CLI. */
export type ProviderId = 'codex' | 'claude' | 'cursor' | 'grok'

export interface ProviderPreset {
  readonly id: ProviderId
  readonly command: string
  /** Arguments preceding the user task. They never contain credentials. */
  readonly args: readonly string[]
  readonly output: 'ndjson' | 'text'
}

export interface InvocationOptions {
  readonly cwd: string
  readonly prompt: string
  /** `default` leaves model selection to the authenticated CLI subscription. */
  readonly model?: string
  /** Provider-supported reasoning effort, encoded as one separate fixed argv value. */
  readonly reasoningEffort?: string
  readonly maxTurns?: number
  /** Local executable override only; arguments remain fixed by this module. */
  readonly command?: string
}

export interface CliInvocation {
  readonly provider: ProviderId
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly shell: false
}

export const providerPresets: Readonly<Record<ProviderId, ProviderPreset>> = {
  codex: {
    id: 'codex',
    command: 'codex',
    // Codex owns its own authenticated subscription session. The sandbox blocks writes.
    args: ['exec', '--json', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only'],
    output: 'ndjson',
  },
  claude: {
    id: 'claude',
    command: 'claude',
    // No tools means DSH receives a text-only delegation by default.
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence', '--safe-mode', '--permission-mode', 'dontAsk', '--tools', ''],
    output: 'ndjson',
  },
  cursor: {
    id: 'cursor',
    command: 'cursor-agent',
    // Intentionally no --force or equivalent approval-bypass flag.
    args: ['--print', '--output-format', 'stream-json'],
    output: 'ndjson',
  },
  grok: {
    id: 'grok',
    command: 'grok',
    // `-p` consumes the following argv item, so buildInvocation inserts the task
    // immediately after it before appending these fixed headless flags. Grok treats
    // an empty --tools value as no filter, so allow then deny its always-on MCP
    // meta-tools to produce an actually empty tool set for this text-only route.
    args: [
      '--output-format', 'streaming-json', '--permission-mode', 'dontAsk',
      '--no-auto-update', '--no-memory', '--no-subagents', '--disable-web-search', '--verbatim',
      '--tools', 'search_tool', '--disallowed-tools', 'search_tool,use_tool',
    ],
    output: 'ndjson',
  },
}

export function buildInvocation(provider: ProviderId, options: InvocationOptions): CliInvocation {
  const preset = providerPresets[provider]
  const args = provider === 'grok'
    ? ['-p', options.prompt, ...preset.args]
    : [...preset.args]

  if (options.model && options.model !== 'default') args.push('--model', options.model)
  if (provider === 'codex' && options.reasoningEffort) {
    args.push('--config', `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`)
  } else if (provider === 'claude' && options.reasoningEffort) {
    args.push('--effort', options.reasoningEffort)
  } else if (provider === 'grok' && options.reasoningEffort) {
    args.push('--reasoning-effort', options.reasoningEffort)
  }
  if (options.maxTurns !== undefined && (provider === 'claude' || provider === 'grok')) {
    args.push('--max-turns', String(options.maxTurns))
  }

  if (provider !== 'grok') args.push(options.prompt)
  return { provider, command: options.command ?? preset.command, args, cwd: options.cwd, shell: false }
}
