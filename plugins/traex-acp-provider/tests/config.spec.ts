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
