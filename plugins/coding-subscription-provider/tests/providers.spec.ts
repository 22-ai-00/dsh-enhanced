import { describe, expect, it } from 'vitest'
import { buildInvocation, providerPresets } from '../src/providers.ts'

describe('provider presets', () => {
  it('uses fixed, credential-free Codex argv and a read-only sandbox', () => {
    expect(buildInvocation('codex', { cwd: '/repo', prompt: 'review' })).toMatchObject({
      command: 'codex', cwd: '/repo', shell: false,
      args: ['exec', '--json', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', 'review'],
    })
  })

  it('makes Claude text-only, prints Cursor output, and does not force Cursor', () => {
    expect(providerPresets.claude.args).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk', '--tools', '', '--include-partial-messages', '--no-session-persistence', '--safe-mode']))
    expect(providerPresets.cursor.args).toContain('--print')
    expect(providerPresets.cursor.args.join(' ')).not.toContain('force')
  })

  it('uses non-interactive verbatim Grok mode and honours safe model/max-turns/command options', () => {
    const invocation = buildInvocation('grok', { cwd: '/repo', prompt: 'hi', model: 'grok-code', maxTurns: 3, command: '/opt/grok' })
    expect(invocation.command).toBe('/opt/grok')
    expect(invocation.args).toEqual([
      '-p', 'hi',
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
      'exec', '--json', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only',
      '--model', 'gpt-5.6-sol',
      '--config', 'model_reasoning_effort="xhigh"',
      'hi',
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
