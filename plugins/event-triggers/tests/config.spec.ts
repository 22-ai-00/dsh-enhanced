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
    expect(value.pollConcurrency).toBe(8)
    expect(value.maxBodyBytes).toBe(65_536)
    expect(value.allowedHttpOrigins).toEqual(['https://api.example.com'])
    expect(value.ipv6Mode).toBe('deny')
  })

  test('requires an explicit native-network assertion before enabling public IPv6', () => {
    expect(normalizeEventTriggersConfig({
      databasePath: '/state/events.sqlite', ipv6Mode: 'native-only', triggers: [],
    }).ipv6Mode).toBe('native-only')
    expect(() => normalizeEventTriggersConfig({
      databasePath: '/state/events.sqlite', ipv6Mode: 'nat64' as never, triggers: [],
    })).toThrow(/configuration|ipv6/i)
  })

  test('accepts an external GitHub grant only with its dedicated owner-bound goal lifetime', () => {
    const trigger = {
      id: 'repository', kind: 'github-repository' as const, automationId: 'repository-source', repository: 'owner/repository', branch: 'delivery/fix', baseBranch: 'main',
      externalGrant: { id: 'operator-grant', revision: 2, digest: 'a'.repeat(64) }, observerLifetime: 'goal' as const,
      observer: { workspace: '/state', preset: 'primary', principalId: 'owner:one', principalRecordId: 'record', principalVersion: 1, ownerRouteId: 'route', expiresAt: 2_000_000_000_000, budgetId: 'polls' },
    }
    expect(normalizeEventTriggersConfig({ databasePath: '/state/events.sqlite', triggers: [trigger] }).triggers[0]).toMatchObject({ externalGrant: trigger.externalGrant, credentialHandle: undefined })
    const withGrant = (externalGrant: typeof trigger.externalGrant) => normalizeEventTriggersConfig({ databasePath: '/state/events.sqlite', triggers: [{ ...trigger, externalGrant }] })
    expect(withGrant(Object.assign(Object.create(null), trigger.externalGrant)).triggers[0]).toMatchObject({ externalGrant: trigger.externalGrant })
    for (const externalGrant of [
      Object.assign(Object.create(trigger.externalGrant), { a: 1, b: 2, c: 3 }),
      Object.assign(Object.create({ inherited: true }), trigger.externalGrant),
      { ...trigger.externalGrant, [Symbol('extra')]: true },
      Object.defineProperty({ ...trigger.externalGrant }, 'id', { get: () => 'operator-grant' }),
      Object.defineProperty({ ...trigger.externalGrant }, 'id', { enumerable: false }),
      { id: 'operator-grant', revision: 2, unrelated: 'a'.repeat(64) },
    ]) expect(() => withGrant(externalGrant as typeof trigger.externalGrant)).toThrow(/external GitHub grant/i)
    expect(() => normalizeEventTriggersConfig({ databasePath: '/state/events.sqlite', triggers: [{ ...trigger, credentialHandle: 'github' }] })).toThrow(/exactly one/i)
    expect(() => normalizeEventTriggersConfig({ databasePath: '/state/events.sqlite', triggers: [{ ...trigger, observerLifetime: 'shared' }] })).toThrow(/goal lifetime/i)
  })

  test('requires a non-default port to be listed as an exact HTTPS origin', () => {
    const trigger = { id: 'api', kind: 'http-json' as const, automationId: 'a',
      url: 'https://api.example.com:8443/state', pointer: '', fireWhen: 'changed' as const,
      debounceMs: 0, cooldownMs: 0, maxFires: 1 }
    expect(() => normalizeEventTriggersConfig({
      databasePath: '/state/events.sqlite', allowedHttpHosts: ['api.example.com'], triggers: [trigger],
    })).toThrow(/origin|allowlist/i)
    expect(normalizeEventTriggersConfig({
      databasePath: '/state/events.sqlite', allowedHttpOrigins: ['https://api.example.com:8443'], triggers: [trigger],
    }).allowedHttpOrigins).toEqual(['https://api.example.com:8443'])
  })

  test.each([
    'http://api.example.com',
    'https://user@api.example.com',
    'https://api.example.com/path',
    'https://api.example.com?query=1',
  ])('rejects an invalid HTTP origin %s', origin => {
    expect(() => normalizeEventTriggersConfig({
      databasePath: '/state/events.sqlite', allowedHttpOrigins: [origin], triggers: [],
    })).toThrow(/origin/i)
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
