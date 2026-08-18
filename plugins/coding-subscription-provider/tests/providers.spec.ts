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

  it('uses non-interactive Grok flags and honours safe model/max-turns/command options', () => {
    const invocation = buildInvocation('grok', { cwd: '/repo', prompt: 'hi', model: 'grok-code', maxTurns: 3, command: '/opt/grok' })
    expect(invocation.command).toBe('/opt/grok')
    expect(invocation.args).toEqual([
      '-p', 'hi',
      '--output-format', 'streaming-json',
      '--permission-mode', 'dontAsk',
      '--no-auto-update', '--no-memory', '--no-subagents', '--disable-web-search',
      '--model', 'grok-code', '--max-turns', '3',
    ])
    expect(buildInvocation('codex', { cwd: '/repo', prompt: 'hi', model: 'default' }).args).not.toContain('--model')
    expect(buildInvocation('codex', { cwd: '/repo', prompt: 'hi', maxTurns: 3 }).args).not.toContain('--max-turns')
    expect(buildInvocation('cursor', { cwd: '/repo', prompt: 'hi', maxTurns: 3 }).args).not.toContain('--max-turns')
  })
})
