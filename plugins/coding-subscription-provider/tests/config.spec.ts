import { describe, expect, it } from 'vitest'
import { Config, configForProvider, normalizeConfig } from '../src/config.ts'

describe('configuration', () => {
  it('materializes safe local-subscription defaults', () => {
    const config = Config()
    expect(config.codex).toMatchObject({
      enabled: true,
      command: 'codex',
      models: ['default'],
      contextWindow: 128_000,
      transport: 'cli',
      directModel: 'gpt-5.6-sol',
      directReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      directDefaultReasoningEffort: 'low',
      maxRequestBytes: 32 * 1024 * 1024,
      maxRequestImageBytes: 24 * 1024 * 1024,
    })
    expect(config.claude.command).toBe('claude')
    expect(config.cursor.command).toBe('cursor-agent')
    expect(config.grok.command).toBe('grok')
    expect(config.claude.enabled).toBe(false)
    expect(config.grok).toMatchObject({ enabled: false, userVerifiedSubscription: false })
    expect(config.maxPromptBytes).toBe(4 * 1024 * 1024)
    expect(['codex', 'claude', 'cursor', 'grok'].map(provider => (
      configForProvider(config, provider as 'codex' | 'claude' | 'cursor' | 'grok').contextWindow
    ))).toEqual([128_000, 128_000, 128_000, 128_000])
    expect(config.extraEnvNames).toEqual([])
    expect(config.logDiagnostics).toBe(false)
  })

  it('accepts only the explicit private Codex transport modes and valid request bounds', () => {
    expect(Config({ codex: { transport: 'direct-responses' } } as never).codex.transport)
      .toBe('direct-responses')
    expect(() => Config({ codex: { transport: 'private-magic' } } as never)).toThrow()
    expect(() => Config({ codex: { directModel: ' ' } } as never)).toThrow()
    expect(() => normalizeConfig(Config({
      codex: { maxRequestImageBytes: 4096, maxRequestBytes: 1024 },
    } as never))).toThrow(/maxRequestImageBytes/)
  })

  it('rejects empty model lists and invalid environment names', () => {
    expect(() => Config({ codex: { models: [] } } as never)).toThrow()
    expect(() => Config({ cursor: { contextWindow: 0 } } as never)).toThrow()
    expect(() => Config({ cursor: { contextWindow: 1_023 } } as never)).toThrow()
    expect(Config({ cursor: { contextWindow: 200_000 } } as never).cursor.contextWindow).toBe(200_000)
    expect(() => Config({ extraEnvNames: ['API-KEY'] } as never)).toThrow()
  })

  it('rejects whitespace commands and duplicate model ids during normalization', () => {
    expect(() => Config({ codex: { command: ' ' } } as never)).toThrow()
    const config = Config()
    config.codex.models = ['default', 'default']
    expect(() => normalizeConfig(config)).toThrow(/duplicate model id/)
  })

  it('validates direct Responses reasoning efforts and their default', () => {
    expect(() => Config({ codex: { directReasoningEfforts: [] } } as never)).toThrow()
    expect(() => Config({ codex: { directReasoningEfforts: ['low', ' '] } } as never)).toThrow()
    expect(() => Config({ codex: { directDefaultReasoningEffort: ' ' } } as never)).toThrow()

    const duplicate = Config({
      codex: { directReasoningEfforts: ['low', 'high', 'low'] },
    } as never)
    expect(() => normalizeConfig(duplicate)).toThrow(/duplicate reasoning effort/)

    const missingDefault = Config({
      codex: {
        directReasoningEfforts: ['medium', 'high'],
        directDefaultReasoningEffort: 'low',
      },
    } as never)
    expect(() => normalizeConfig(missingDefault)).toThrow(/directDefaultReasoningEffort/)
  })

  it('requires an explicit Grok subscription attestation before enabling it', () => {
    const config = Config()
    config.grok.enabled = true
    expect(() => normalizeConfig(config)).toThrow(/userVerifiedSubscription/)
    config.grok.userVerifiedSubscription = true
    expect(normalizeConfig(config).grok.enabled).toBe(true)
  })
})
