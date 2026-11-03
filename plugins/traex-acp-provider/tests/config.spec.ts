import { describe, expect, it } from 'vitest'
import { Config, normalizeConfig } from '../src/config.ts'

describe('configuration', () => {
  it('materializes bounded local ACP defaults', () => {
    const config = Config()
    expect(config).toMatchObject({
      enabled: false,
      command: 'traex',
      cwd: '.',
      models: ['default'],
      extraEnvNames: [],
      logDiagnostics: false,
    })
    expect(config.timeoutMs).toBeGreaterThan(0)
    expect(config.maxMessageBytes).toBeGreaterThan(0)
    expect(config.maxProtocolBytes).toBeGreaterThan(config.maxMessageBytes)
    expect(config.maxProtocolMessages).toBeGreaterThan(0)
  })

  it('rejects empty models, whitespace commands and invalid environment names', () => {
    expect(() => Config({ models: [] } as never)).toThrow()
    expect(() => Config({ command: ' ' } as never)).toThrow()
    expect(() => Config({ extraEnvNames: ['API-KEY'] } as never)).toThrow()
  })

  it('rejects duplicate model ids during normalization', () => {
    const config = Config()
    config.models = ['default', 'default']
    expect(() => normalizeConfig(config)).toThrow(/duplicate model id/)
  })
})

describe('live-editable provider fields', () => {
  it('exposes only enabled and command to the Host settings service', () => {
    const schema = Config as unknown as { dict: Record<string, { meta?: { volatile?: boolean } }> }
    expect(schema.dict['enabled']?.meta?.volatile).toBe(true)
    expect(schema.dict['command']?.meta?.volatile).toBe(true)
    expect(schema.dict['cwd']?.meta?.volatile).toBeFalsy()
    expect(normalizeConfig({ enabled: true, command: 'traex-next' } as never)).toMatchObject({ enabled: true, command: 'traex-next' })
  })
})
