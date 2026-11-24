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
    expect(value.pollerEnabled).toBe(true)
    expect(value.webhookListen).toBeUndefined()
    expect(value.pollIntervalMs).toBe(5_000)
    expect(value.pollConcurrency).toBe(8)
    expect(value.maxBodyBytes).toBe(65_536)
    expect(value.allowedHttpOrigins).toEqual(['https://api.example.com'])
    expect(value.ipv6Mode).toBe('deny')
    expect(normalizeEventTriggersConfig({
      databasePath: '/state/events.sqlite', pollerEnabled: false, triggers: [],
    }).pollerEnabled).toBe(false)
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

  test('accepts explicit commit delivery mode while retaining the scoped base branch', () => {
    const trigger = {
      id: 'repository-commit', kind: 'github-repository' as const, automationId: 'repository-source', repository: 'owner/repository', branch: 'delivery/fix', baseBranch: 'main', deliveryMode: 'commit' as const,
      credentialHandle: 'github', observer: { workspace: '/state', preset: 'primary', principalId: 'owner:one', principalRecordId: 'record', principalVersion: 1, ownerRouteId: 'route', expiresAt: 2_000_000_000_000, budgetId: 'polls' },
    }
    expect(normalizeEventTriggersConfig({ databasePath: '/state/events.sqlite', triggers: [trigger] }).triggers[0]).toMatchObject({ deliveryMode: 'commit', baseBranch: 'main' })
  })

  test.each([
    ['pullRequestNumber', 7],
    ['reviewerIds', [42]],
    ['minApprovals', 1],
  ])('rejects PR-only commit trigger field %s', (field, value) => {
    const trigger = {
      id: 'repository-commit', kind: 'github-repository' as const, automationId: 'repository-source', repository: 'owner/repository', branch: 'delivery/fix', baseBranch: 'main', deliveryMode: 'commit' as const,
      credentialHandle: 'github', observer: { workspace: '/state', preset: 'primary', principalId: 'owner:one', principalRecordId: 'record', principalVersion: 1, ownerRouteId: 'route', expiresAt: 2_000_000_000_000, budgetId: 'polls' }, [field]: value,
    }
    expect(() => normalizeEventTriggersConfig({ databasePath: '/state/events.sqlite', triggers: [trigger] } as never)).toThrow(/configuration|event-triggers/i)
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

  test('normalizes lark-calendar rolling windows and rejects mixed or empty windows', () => {
    const observer = {
      workspace: '/state', preset: 'primary', principalId: 'owner:one', principalRecordId: 'record',
      principalVersion: 1, ownerRouteId: 'route', expiresAt: 2_000_000_000_000, budgetId: 'polls',
    }
    const rolling = normalizeEventTriggersConfig({
      databasePath: '/state/events.sqlite',
      triggers: [{
        id: 'cal-roll', kind: 'lark-calendar', automationId: 'cal-auto', calendarId: 'cal_1',
        lookbackSeconds: 300, lookaheadSeconds: 3600, windowStepSeconds: 60, observer,
      }],
    }).triggers[0]!
    expect(rolling).toMatchObject({
      kind: 'lark-calendar', lookbackSeconds: 300, lookaheadSeconds: 3600, windowStepSeconds: 60,
    })
    expect('startTime' in rolling).toBe(false)
    expect('endTime' in rolling).toBe(false)

    for (const invalid of [
      { startTime: 1, endTime: 100, lookaheadSeconds: 60 },
      { lookbackSeconds: 0, lookaheadSeconds: 0 },
      { lookbackSeconds: 30, lookaheadSeconds: 30, windowStepSeconds: 120 },
      {},
    ]) {
      expect(() => normalizeEventTriggersConfig({
        databasePath: '/state/events.sqlite',
        triggers: [{ id: 'cal-bad', kind: 'lark-calendar', automationId: 'cal-auto', calendarId: 'cal_1', observer, ...invalid }],
      })).toThrow(/Lark calendar/i)
    }
  })

  test('normalizes webhookListen loopback defaults, auth modes, and route uniqueness', () => {
    const normalized = normalizeEventTriggersConfig({
      databasePath: '/state/events.sqlite',
      webhookListen: {},
      triggers: [
        { id: 'hook-1', kind: 'webhook', automationId: 'a1', credentialHandle: 'h1' },
        { id: 'hook-2', kind: 'webhook', automationId: 'a2', credentialHandle: 'h2', path: '/custom/ci', authMode: 'shared-secret', secretHeader: 'X-Custom-Token' },
      ],
    })
    expect(normalized.webhookListen).toEqual({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      basePath: '/webhooks',
      allowNonLoopback: false,
      maxConcurrentRequests: 64,
      drainTimeoutMs: 5_000,
    })
    expect(normalized.triggers[1]).toMatchObject({
      path: '/custom/ci', authMode: 'shared-secret', secretHeader: 'x-custom-token',
    })

    expect(normalizeEventTriggersConfig({
      databasePath: '/state/events.sqlite',
      webhookListen: { host: '0.0.0.0', port: 8080, allowNonLoopback: true },
      triggers: [],
    }).webhookListen).toMatchObject({ host: '0.0.0.0', port: 8080, allowNonLoopback: true })

    expect(normalizeEventTriggersConfig({
      databasePath: '/state/events.sqlite',
      webhookListen: { host: '[::1]' },
      triggers: [],
    }).webhookListen).toMatchObject({ host: '::1', allowNonLoopback: false })

    expect(normalizeEventTriggersConfig({
      databasePath: '/state/events.sqlite',
      webhookListen: { host: '[2001:db8::1]', allowNonLoopback: true },
      triggers: [],
    }).webhookListen).toMatchObject({ host: '2001:db8::1', allowNonLoopback: true })

    for (const badHost of ['[localhost]', '[127.0.0.1]', '[::1', '[]']) {
      expect(() => normalizeEventTriggersConfig({
        databasePath: '/state/events.sqlite',
        webhookListen: { host: badHost, allowNonLoopback: true },
        triggers: [],
      })).toThrow(/webhookListen\.host/i)
    }

    expect(() => normalizeEventTriggersConfig({
      databasePath: '/state/events.sqlite',
      webhookListen: { basePath: '/webhooks' },
      triggers: [
        { id: 'hook-a', kind: 'webhook', automationId: 'a1', credentialHandle: 'h1', path: '/webhooks/dup' },
        { id: 'dup', kind: 'webhook', automationId: 'a2', credentialHandle: 'h2' },
      ],
    })).toThrow(/duplicate webhook route/i)
  })

  test('normalizes task-system, calendar, and email trigger configs with HTTPS origin checks', () => {
    const normalized = normalizeEventTriggersConfig({
      databasePath: '/state/events.sqlite',
      allowedHttpOrigins: ['https://tasks.example.com', 'https://cal.example.com', 'https://mail.example.com'],
      triggers: [
        {
          id: 'tasks', kind: 'task-system', automationId: 'auto-tasks', url: 'https://tasks.example.com/api/tasks',
          itemsPointer: '/data/items', fields: { id: 'key', title: 'summary' }, statusFilter: ['open', 'in_progress'],
          since: '2026-01-01T00:00:00Z', credentialHandle: 'tasks-tok', authScheme: 'x-api-key',
        },
        {
          id: 'cal-ics', kind: 'calendar', automationId: 'auto-cal', url: 'https://cal.example.com/feed.ics',
          format: 'ics', window: { mode: 'rolling', lookbackSeconds: 600, lookaheadSeconds: 3600 },
          windowParams: { startParam: 'start', endParam: 'end', format: 'iso' },
        },
        {
          id: 'mail-jmap', kind: 'email', automationId: 'auto-mail', url: 'https://mail.example.com/jmap',
          protocol: 'jmap', accountId: 'acc-1', mailboxId: 'mb-inbox', fromFilter: ['Alerts@Example.com'],
          subjectContains: 'Build failed', unreadOnly: true, credentialHandle: 'mail-tok',
        },
      ],
    })
    expect(normalized.triggers.map(t => t.kind)).toEqual(['task-system', 'calendar', 'email'])
    expect(normalized.triggers[0]).toMatchObject({ authScheme: 'x-api-key', credentialHandle: 'tasks-tok' })
    expect(normalized.triggers[1]).toMatchObject({ format: 'ics', maxEvents: 500 })
    expect(normalized.triggers[2]).toMatchObject({ protocol: 'jmap', accountId: 'acc-1', fromFilter: ['alerts@example.com'] })

    expect(() => normalizeEventTriggersConfig({
      databasePath: '/state/events.sqlite',
      allowedHttpOrigins: ['https://mail.example.com'],
      triggers: [{ id: 'bad-jmap', kind: 'email', automationId: 'a', url: 'https://mail.example.com/jmap', protocol: 'jmap' }],
    })).toThrow(/accountId/i)
    expect(() => normalizeEventTriggersConfig({
      databasePath: '/state/events.sqlite',
      allowedHttpOrigins: ['https://cal.example.com'],
      triggers: [{
        id: 'bad-ics', kind: 'calendar', automationId: 'a', url: 'https://cal.example.com/feed.ics',
        format: 'ics', itemsPointer: '/items',
      }],
    })).toThrow(/itemsPointer/i)
  })
})
