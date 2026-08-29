/** Local coding-tool invocations. Credentials deliberately remain owned by each CLI. */
export type ProviderId = 'codex' | 'claude' | 'cursor' | 'grok'

export interface ProviderPreset {
  readonly id: ProviderId
  readonly command: string
  /** Fixed CLI arguments. They never contain credentials or prompt content. */
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
  /** Serialized DSH request. It is transported out-of-band and must never enter argv. */
  readonly prompt: string
  /** Grok consumes a private prompt file; every other CLI consumes stdin. */
  readonly promptTransport: 'stdin' | 'secure-temporary-file'
  readonly cwd: string
  readonly shell: false
}

/**
 * Codex 0.147 feature keys that can expose a provider-owned executor, lifecycle
 * hook, skill/plugin instruction, or capability-discovery path. Keep this list
 * mirrored by scripts/capture-cli-fixtures.mjs and covered by the exact argv
 * tests below. The protocol decoder remains the final fail-closed boundary.
 */
export const CODEX_DISABLED_NATIVE_FEATURES = [
  'shell_tool',
  'shell_zsh_fork',
  'unified_exec_zsh_fork',
  'shell_snapshot',
  'deferred_executor',
  'js_repl',
  'js_repl_tools_only',
  'view_image',
  'hooks',
  'code_mode',
  'code_mode_buffered_exec',
  'code_mode_host',
  'code_mode_only',
  'web_search_request',
  'web_search_cached',
  'search_tool',
  'memories',
  'external_agent_memory_import',
  'apply_patch_freeform',
  'apply_patch_streaming_events',
  'exec_permission_approvals',
  'request_rule',
  'multi_agent',
  'multi_agent_v2',
  'multi_agent_mode',
  'collaboration_modes',
  'apps',
  'enable_mcp_apps',
  'mcp_2026_07_28',
  'apps_mcp_path_override',
  'tool_search',
  'deferred_tool_world_state',
  'non_prefixed_mcp_tool_names',
  'unavailable_dummy_tools',
  'tool_suggest',
  'recommended_plugins',
  'plugins',
  'executor_capability_discovery',
  'plugin_hooks',
  'in_app_browser',
  'browser_use',
  'browser_use_full_cdp_access',
  'browser_use_external',
  'computer_use',
  'remote_plugin',
  'plugin_sharing',
  'image_generation',
  'skill_mcp_dependency_install',
  'skill_search',
  'skill_env_var_dependency_prompt',
  'standalone_web_search',
  'default_mode_request_user_input',
  'request_permissions_tool',
  'token_budget',
  'current_time_reminder',
  'terminal_visualization_instructions',
  'guardian_approval',
  'guardianv2',
  'goals',
  'tool_call_mcp_elicitation',
  'auth_elicitation',
  'artifact',
  'workspace_dependencies',
] as const

const codexDisabledNativeFeatureArgs = CODEX_DISABLED_NATIVE_FEATURES
  .flatMap(feature => ['--disable', feature])

/** Codex config paths that suppress repository-, skill-, and host-owned prompt/tool injection. */
export const CODEX_NATIVE_BOUNDARY_CONFIG_OVERRIDES = [
  'project_doc_max_bytes=0',
  'skills.include_instructions=false',
  'skills.bundled.enabled=false',
  'orchestrator.skills.enabled=false',
  'orchestrator.mcp.enabled=false',
  'include_apps_instructions=false',
  'include_permissions_instructions=false',
  'include_environment_context=false',
  'include_collaboration_mode_instructions=false',
  'tools.update_plan.enabled=false',
  'tools.experimental_request_user_input.enabled=false',
  'web_search="disabled"',
  'agents.enabled=false',
] as const

const codexNativeBoundaryConfigArgs = CODEX_NATIVE_BOUNDARY_CONFIG_OVERRIDES
  .flatMap(value => ['--config', value])

export const providerPresets: Readonly<Record<ProviderId, ProviderPreset>> = {
  codex: {
    id: 'codex',
    command: 'codex',
    // Codex owns its own authenticated subscription session. Ignore local config/rules,
    // remove known model-visible native capabilities, and keep residual built-ins read-only.
    // The stdout decoder still rejects any native tool lifecycle event that escapes
    // these best-effort launch boundaries.
    args: [
      'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      // The cwd has already been reconstructed from the live Host session and
      // compared by canonical realpath.  The standard assistant workspace is
      // intentionally not required to be a Git repository.
      '--skip-git-repo-check',
      ...codexDisabledNativeFeatureArgs,
      ...codexNativeBoundaryConfigArgs,
      '--sandbox', 'read-only',
    ],
    output: 'ndjson',
  },
  claude: {
    id: 'claude',
    command: 'claude',
    // Disable Claude-native tools; DSH calls return through the outer JSON bridge.
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence', '--safe-mode', '--permission-mode', 'dontAsk', '--tools', ''],
    output: 'ndjson',
  },
  cursor: {
    id: 'cursor',
    command: 'cursor-agent',
    // Ask mode is the strongest current headless boundary. Intentionally never
    // pass --force or another approval bypass; read-only search may still occur.
    args: ['--print', '--output-format', 'stream-json', '--mode=ask'],
    output: 'ndjson',
  },
  grok: {
    id: 'grok',
    command: 'grok',
    // Grok treats an empty --tools value as no filter, so allow then deny its
    // always-on MCP meta-tools to produce an actually empty native tool set. DSH
    // calls use the outer JSON bridge instead of Grok's internal executor.
    args: [
      '--output-format', 'streaming-json', '--permission-mode', 'dontAsk',
      '--no-auto-update', '--no-memory', '--no-subagents', '--disable-web-search', '--verbatim',
      '--tools', 'search_tool', '--disallowed-tools', 'search_tool,use_tool',
    ],
    output: 'ndjson',
  },
}

export function buildInvocation(
  provider: ProviderId,
  options: InvocationOptions,
  _platform: NodeJS.Platform = process.platform,
): CliInvocation {
  const preset = providerPresets[provider]
  // Grok 1.0.5 reopens its --prompt-file path instead of consuming the inherited
  // stdin stream. `/dev/stdin` can therefore fail with ENXIO under child_process,
  // so use the same private-file transport on every supported platform.
  const promptTransport = provider === 'grok'
    ? 'secure-temporary-file'
    : 'stdin'
  const args = [...preset.args]

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
  // Use the documented positional sentinel even though some Codex releases
  // also infer stdin when PROMPT is omitted.  Keeping it last prevents a future
  // parser change from treating a following option as prompt content.
  if (provider === 'codex') args.push('-')

  return {
    provider,
    command: options.command ?? preset.command,
    args,
    prompt: options.prompt,
    promptTransport,
    cwd: options.cwd,
    shell: false,
  }
}
