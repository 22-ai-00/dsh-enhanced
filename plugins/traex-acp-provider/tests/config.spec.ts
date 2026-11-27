import { describe, expect, it } from 'vitest'
import {
  AGY_MAX_PROMPT_BYTES_CEILING,
  Config,
  DEFAULT_AGY_CONTEXT_WINDOW,
  DEFAULT_AGY_MAX_PROMPT_BYTES,
  normalizeConfig,
} from '../src/config.ts'

describe('configuration', () => {
  it('materializes bounded local ACP defaults', () => {
    const config = Config()
    expect(config).toMatchObject({
      enabled: false,
      command: 'traex',
      cwd: '.',
      cwdMode: 'session',
      models: ['default'],
      agyEnabled: false,
      agyCommand: 'agy',
      agyModels: ['default'],
      agyIncludeDefaultCustomizations: false,
      agyDisableTelemetry: true,
      agyMode: 'default',
      contextWindow: 200_000,
      agyContextWindow: DEFAULT_AGY_CONTEXT_WINDOW,
      maxMessageBytes: 2 * 1024 * 1024,
      agyMaxPromptBytes: DEFAULT_AGY_MAX_PROMPT_BYTES,
      authProbeTimeoutMs: 30_000,
      extraEnvNames: [],
      logDiagnostics: false,
    })
    expect(DEFAULT_AGY_CONTEXT_WINDOW).toBe(128_000)
    expect(config.agyContextWindow).toBe(128_000)
    expect(config.agyMaxPromptBytes).toBe(184_320)
    expect(config.agyMaxPromptBytes).toBeLessThanOrEqual(AGY_MAX_PROMPT_BYTES_CEILING)
    expect(config.timeoutMs).toBeGreaterThan(0)
    expect(config.maxMessageBytes).toBeGreaterThan(0)
    expect(config.maxProtocolBytes).toBeGreaterThan(config.maxMessageBytes)
    expect(config.maxProtocolMessages).toBeGreaterThan(0)
  })

  it('rejects empty models, whitespace commands, invalid agyMode, excessive agyMaxPromptBytes and invalid environment names', () => {
    expect(() => Config({ models: [] } as never)).toThrow()
    expect(() => Config({ agyModels: [] } as never)).toThrow()
    expect(() => Config({ command: ' ' } as never)).toThrow()
    expect(() => Config({ agyCommand: ' ' } as never)).toThrow()
    expect(() => Config({ agyMode: 'bypass' } as never)).toThrow()
    expect(() => Config({ cwdMode: 'anywhere' } as never)).toThrow()
    expect(() => Config({ contextWindow: 1024 } as never)).toThrow()
    expect(() => Config({ agyContextWindow: 1024 } as never)).toThrow()
    expect(() => Config({ agyMaxPromptBytes: 200_000 } as never)).toThrow()
    expect(() => Config({ extraEnvNames: ['API-KEY'] } as never)).toThrow()
  })

  it('rejects duplicate model ids during normalization', () => {
    const config = Config()
    config.models = ['default', 'default']
    expect(() => normalizeConfig(config)).toThrow(/duplicate model id in models/)

    const agyConfig = Config()
    agyConfig.agyModels = ['gemini-4-carbon', 'gemini-4-carbon']
    expect(() => normalizeConfig(agyConfig)).toThrow(/duplicate model id in agyModels/)
  })
})

describe('live-editable provider fields', () => {
  it('exposes only route enablement and command fields to the Host settings service', () => {
    const schema = Config as unknown as { dict: Record<string, { meta?: { volatile?: boolean } }> }
    expect(schema.dict['enabled']?.meta?.volatile).toBe(true)
    expect(schema.dict['command']?.meta?.volatile).toBe(true)
    expect(schema.dict['agyEnabled']?.meta?.volatile).toBe(true)
    expect(schema.dict['agyCommand']?.meta?.volatile).toBe(true)
    expect(schema.dict['cwdMode']?.meta?.volatile).toBe(true)
    expect(schema.dict['cwd']?.meta?.volatile).toBeFalsy()
    expect(schema.dict['agyMode']?.meta?.volatile).toBeFalsy()
    expect(schema.dict['agyIncludeDefaultCustomizations']?.meta?.volatile).toBeFalsy()
    expect(normalizeConfig({
      enabled: true,
      command: 'traex-next',
      cwdMode: 'exact',
      agyEnabled: true,
      agyCommand: '/usr/local/bin/agy',
    } as never)).toMatchObject({
      enabled: true,
      command: 'traex-next',
      cwdMode: 'exact',
      agyEnabled: true,
      agyCommand: '/usr/local/bin/agy',
    })
  })

  it('unwraps volatile getter references for both TraeX and Antigravity live fields', () => {
    const volatile = <T,>(value: T) => ({ get: () => value })
    const config = Config({
      enabled: volatile(false),
      command: volatile('traex'),
      cwdMode: volatile('exact'),
      agyEnabled: volatile(true),
      agyCommand: volatile('/opt/agy/bin/agy'),
    } as never)
    expect(config).toMatchObject({
      enabled: false,
      command: 'traex',
      cwdMode: 'exact',
      agyEnabled: true,
      agyCommand: '/opt/agy/bin/agy',
    })
  })
})
