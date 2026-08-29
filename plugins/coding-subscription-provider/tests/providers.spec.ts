import { describe, expect, it } from 'vitest'
import {
  CODEX_DISABLED_NATIVE_FEATURES,
  CODEX_NATIVE_BOUNDARY_CONFIG_OVERRIDES,
  buildInvocation,
  providerPresets,
} from '../src/providers.ts'

const codexDisabledNativeFeatureArgs = CODEX_DISABLED_NATIVE_FEATURES
  .flatMap(feature => ['--disable', feature])
const codexNativeBoundaryConfigArgs = CODEX_NATIVE_BOUNDARY_CONFIG_OVERRIDES
  .flatMap(value => ['--config', value])

describe('provider presets', () => {
  it('uses fixed, credential-free Codex argv with native capabilities disabled and a read-only sandbox', () => {
    expect(buildInvocation('codex', { cwd: '/repo', prompt: 'review' })).toMatchObject({
      command: 'codex', cwd: '/repo', shell: false,
      prompt: 'review', promptTransport: 'stdin',
      args: [
        'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
        '--skip-git-repo-check',
        ...codexDisabledNativeFeatureArgs,
        ...codexNativeBoundaryConfigArgs,
        '--sandbox', 'read-only',
        '-',
      ],
    })
  })

  it.each(['codex', 'claude', 'cursor'] as const)('keeps the %s prompt on stdin and out of argv', provider => {
    const prompt = `private prompt for ${provider}`
    const invocation = buildInvocation(provider, { cwd: '/repo', prompt }, 'linux')
    expect(invocation.prompt).toBe(prompt)
    expect(invocation.args).not.toContain(prompt)
    expect(invocation.args.join('\0')).not.toContain(prompt)
    expect(invocation.promptTransport).toBe('stdin')
  })

  it.each(['linux', 'darwin', 'win32'] as const)('uses a private Grok prompt file on %s without putting content in argv', platform => {
    const prompt = `private prompt for grok on ${platform}`
    const invocation = buildInvocation('grok', { cwd: '/repo', prompt }, platform)
    expect(invocation.prompt).toBe(prompt)
    expect(invocation.promptTransport).toBe('secure-temporary-file')
    expect(invocation.args).not.toContain(prompt)
    expect(invocation.args.join('\0')).not.toContain(prompt)
    expect(invocation.args).not.toContain('--prompt-file')
    expect(invocation.args).not.toContain('/dev/stdin')
  })

  it('pins every Codex native executor and skill-injection feature once', () => {
    expect(CODEX_DISABLED_NATIVE_FEATURES).toEqual(expect.arrayContaining([
      'shell_tool', 'shell_snapshot', 'view_image', 'hooks',
      'js_repl', 'deferred_executor',
      'code_mode', 'code_mode_buffered_exec', 'code_mode_host', 'code_mode_only',
      'web_search_request', 'web_search_cached', 'search_tool',
      'memories', 'apply_patch_freeform',
      'multi_agent', 'multi_agent_v2', 'collaboration_modes',
      'apps', 'enable_mcp_apps', 'tool_suggest', 'recommended_plugins', 'plugins',
      'executor_capability_discovery', 'remote_plugin', 'plugin_sharing',
      'tool_search', 'in_app_browser',
      'browser_use', 'browser_use_full_cdp_access', 'browser_use_external',
      'computer_use', 'image_generation',
      'skill_mcp_dependency_install', 'skill_search',
      'standalone_web_search', 'request_permissions_tool', 'current_time_reminder',
      'goals', 'tool_call_mcp_elicitation', 'auth_elicitation',
      'artifact', 'workspace_dependencies',
    ]))
    expect(new Set(CODEX_DISABLED_NATIVE_FEATURES).size).toBe(CODEX_DISABLED_NATIVE_FEATURES.length)
  })

  it('suppresses Codex project, skill, orchestrator, and utility-tool injection', () => {
    expect(CODEX_NATIVE_BOUNDARY_CONFIG_OVERRIDES).toEqual([
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
    ])
  })

  it('disables Claude tools and pins Cursor to ask mode without forcing it', () => {
    expect(providerPresets.claude.args).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk', '--tools', '', '--include-partial-messages', '--no-session-persistence', '--safe-mode']))
    expect(providerPresets.cursor.args).toEqual([
      '--print', '--output-format', 'stream-json', '--mode=ask',
    ])
    expect(providerPresets.cursor.args.join(' ')).not.toContain('force')
  })

  it('uses non-interactive verbatim Grok mode and honours safe model/max-turns/command options', () => {
    const invocation = buildInvocation('grok', { cwd: '/repo', prompt: 'hi', model: 'grok-code', maxTurns: 3, command: '/opt/grok' }, 'linux')
    expect(invocation.command).toBe('/opt/grok')
    expect(invocation.args).toEqual([
      '--output-format', 'streaming-json',
      '--permission-mode', 'dontAsk',
      '--no-auto-update', '--no-memory', '--no-subagents', '--disable-web-search', '--verbatim',
      '--tools', 'search_tool', '--disallowed-tools', 'search_tool,use_tool',
      '--model', 'grok-code', '--max-turns', '3',
    ])
    expect(buildInvocation('codex', { cwd: '/repo', prompt: 'hi', model: 'default' }).args).not.toContain('--model')
    expect(buildInvocation('codex', { cwd: '/repo', prompt: 'hi', maxTurns: 3 }).args).not.toContain('--max-turns')
    expect(buildInvocation('cursor', { cwd: '/repo', prompt: 'hi', maxTurns: 3 }).args).not.toContain('--max-turns')
  })

  it('passes Codex reasoning effort as a fixed config override without shell interpolation', () => {
    const invocation = buildInvocation('codex', {
      cwd: '/repo',
      prompt: 'hi',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
    } as never)

    expect(invocation.args).toEqual([
      'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--skip-git-repo-check',
      ...codexDisabledNativeFeatureArgs,
      ...codexNativeBoundaryConfigArgs,
      '--sandbox', 'read-only',
      '--model', 'gpt-5.6-sol',
      '--config', 'model_reasoning_effort="xhigh"',
      '-',
    ])
    expect(invocation.shell).toBe(false)
  })

  it.each([
    ['claude', '--effort'],
    ['grok', '--reasoning-effort'],
  ] as const)('passes %s reasoning effort as a separate fixed argv value', (provider, flag) => {
    const invocation = buildInvocation(provider, {
      cwd: '/repo',
      prompt: 'hi',
      model: 'model-a',
      reasoningEffort: 'xhigh',
    } as never)

    expect(invocation.args).toEqual(expect.arrayContaining([flag, 'xhigh']))
    expect(invocation.shell).toBe(false)
  })
})
