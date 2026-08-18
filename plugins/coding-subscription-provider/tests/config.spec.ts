import { describe, expect, it } from 'vitest'
import { Config, normalizeConfig } from '../src/config.ts'

describe('configuration', () => {
  it('materializes safe local-subscription defaults', () => {
    const config = Config()
    expect(config.codex).toMatchObject({ enabled: true, command: 'codex', models: ['default'] })
    expect(config.claude.command).toBe('claude')
    expect(config.cursor.command).toBe('cursor-agent')
    expect(config.grok.command).toBe('grok')
    expect(config.claude.enabled).toBe(false)
    expect(config.grok).toMatchObject({ enabled: false, userVerifiedSubscription: false })
    expect(config.extraEnvNames).toEqual([])
    expect(config.logDiagnostics).toBe(false)
  })

  it('rejects empty model lists and invalid environment names', () => {
    expect(() => Config({ codex: { models: [] } } as never)).toThrow()
    expect(() => Config({ extraEnvNames: ['API-KEY'] } as never)).toThrow()
  })

  it('rejects whitespace commands and duplicate model ids during normalization', () => {
    expect(() => Config({ codex: { command: ' ' } } as never)).toThrow()
    const config = Config()
    config.codex.models = ['default', 'default']
    expect(() => normalizeConfig(config)).toThrow(/duplicate model id/)
  })

  it('requires an explicit Grok subscription attestation before enabling it', () => {
    const config = Config()
    config.grok.enabled = true
    expect(() => normalizeConfig(config)).toThrow(/userVerifiedSubscription/)
    config.grok.userVerifiedSubscription = true
    expect(normalizeConfig(config).grok.enabled).toBe(true)
  })
})
