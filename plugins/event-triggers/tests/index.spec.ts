import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, test, vi } from 'vitest'
import * as entrypoint from '../src/index.ts'
import plugin, { apply, Config, EventTriggersService, name, version } from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

describe('dsh-enhanced-event-triggers entrypoint', () => {
  test('exports stable identity, service, and validated config', () => {
    expect(name).toBe('dsh-enhanced-event-triggers')
    expect(version).toBe(manifest.version)
    expect(plugin).toEqual({ name, Config, apply })
    expect(Config).toBe(EventTriggersService.Config)
  })

  test('declares webhook credentials as a conditional Cordis dependency', () => {
    const injectOptional = vi.fn()
    apply({ inject: injectOptional } as unknown as Context, {
      databasePath: '/state/events.sqlite',
      triggers: [{
        id: 'hook',
        kind: 'webhook',
        automationId: 'scheduled-task',
        credentialHandle: 'hook-secret',
      }],
    })

    expect(injectOptional).toHaveBeenCalledOnce()
    expect(injectOptional).toHaveBeenCalledWith(['credentialsKeychain'], expect.any(Function))
  })

  test('injects assistantActions without Keychain for an external GitHub source', () => {
    const inject = vi.fn()
    apply({ inject } as unknown as Context, {
      databasePath: '/state/events.sqlite',
      triggers: [{ id: 'repository', kind: 'github-repository', automationId: 'repository-source', repository: 'owner/repository', branch: 'delivery/fix', baseBranch: 'main',
        externalGrant: { id: 'grant', revision: 1, digest: 'a'.repeat(64) }, observerLifetime: 'goal',
        observer: { workspace: '/state', preset: 'primary', principalId: 'owner:one', principalRecordId: 'record', principalVersion: 1, ownerRouteId: 'route', expiresAt: 2_000_000_000_000, budgetId: 'polls' } }],
    })
    expect(inject).toHaveBeenCalledWith(['assistantActions', 'assistantDelivery'], expect.any(Function))
  })

  test('does not expose its SQLite store as a cross-plugin API', () => {
    expect(entrypoint).not.toHaveProperty('EventTriggerStore')
    expect(entrypoint).not.toHaveProperty('EventTriggerStoreError')
    expect(entrypoint).not.toHaveProperty('readFileObservation')
    expect(entrypoint).not.toHaveProperty('readHttpJsonObservation')
  })
})
