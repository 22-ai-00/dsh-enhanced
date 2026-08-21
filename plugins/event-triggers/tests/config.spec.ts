import { describe, expect, test } from 'vitest'
import { normalizeEventTriggersConfig, type FileTriggerConfig } from '../src/config.ts'

function file(overrides: Record<string, unknown> = {}): FileTriggerConfig {
  return {
    id: 'inbox-ready', kind: 'file' as const, automationId: 'review-inbox', path: '/work/inbox/READY',
    fireWhen: 'truthy' as const, debounceMs: 500, cooldownMs: 1_000, maxFires: 10, ...overrides,
  } as FileTriggerConfig
}

describe('event trigger configuration', () => {
  test('normalizes bounded file, HTTP, and webhook definitions', () => {
    const value = normalizeEventTriggersConfig({
      databasePath: '/state/events.sqlite', allowedFileRoots: ['/work/inbox'], allowedHttpHosts: ['api.example.com'],
      triggers: [
        file(),
        { id: 'api-state', kind: 'http-json', automationId: 'review-api', url: 'https://api.example.com/state',
          pointer: '/ready', fireWhen: 'truthy', debounceMs: 0, cooldownMs: 60_000, maxFires: 100 },
        { id: 'hook', kind: 'webhook', automationId: 'hook-task', credentialHandle: 'hook-secret',
          maxSkewMs: 60_000, cooldownMs: 0, maxFires: 100 },
      ],
    })
    expect(value.triggers.map(item => item.kind)).toEqual(['file', 'http-json', 'webhook'])
    expect(value.pollIntervalMs).toBe(5_000)
    expect(value.maxBodyBytes).toBe(65_536)
  })

  test.each([
    { databasePath: 'relative.sqlite' },
    { allowedFileRoots: ['relative'] },
    { triggers: [file({ path: '/outside/READY' })] },
    { triggers: [file({ id: '../escape' })] },
    { triggers: [file(), file()] },
    { allowedHttpHosts: ['api.example.com'], triggers: [{ id: 'api', kind: 'http-json', automationId: 'a',
      url: 'http://api.example.com', pointer: '', fireWhen: 'changed', debounceMs: 0, cooldownMs: 0, maxFires: 1 }] },
    { webhookListen: { host: '0.0.0.0', port: 8080 } },
    { triggers: [{ id: 'command', kind: 'command', automationId: 'a', command: 'whoami' }] },
  ])('rejects unsafe configuration %#', override => {
    const input = { databasePath: '/state/events.sqlite', allowedFileRoots: ['/work/inbox'],
      allowedHttpHosts: [], triggers: [file()], ...override }
    expect(() => normalizeEventTriggersConfig(input as never)).toThrow(/event-triggers/i)
  })
})
