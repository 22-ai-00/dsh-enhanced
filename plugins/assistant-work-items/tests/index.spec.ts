import { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  AssistantWorkItemsService,
  ConfigSchema,
  type Config,
  isActive,
  normalizeConfig,
  version,
} from '../src/index.ts'
import * as entrypoint from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function location() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-work-items-config-'))
  roots.push(root)
  return { root, databasePath: join(root, 'state', 'state.sqlite'), workRoot: join(root, 'work') }
}

function active(overrides: Record<string, unknown> = {}): Config {
  const now = Date.now()
  return {
    enabled: true,
    mode: 'active',
    databasePath: '/state/work-items.sqlite',
    workRoot: '/state/work',
    workerAutomationId: 'work-items-worker',
    scope: {
      workspace: '/work/alpha',
      preset: 'primary',
      principalId: 'owner:me',
      ownerRouteId: 'route-1',
      expiresAt: now + 3_600_000,
    },
    admission: { allowedKinds: ['review'] },
    ...overrides,
  } as Config
}

describe('dsh-enhanced-assistant-work-items entrypoint', () => {
  test('exposes stable identity, service and config', () => {
    expect(entrypoint.name).toBe('dsh-enhanced-assistant-work-items')
    expect(version).toBe(manifest.version)
    expect(entrypoint.default).toBe(AssistantWorkItemsService)
    expect(ConfigSchema).toBe(AssistantWorkItemsService.Config)
  })

  test('defaults to disabled observe mode', async () => {
    const paths = await location()
    const config = normalizeConfig({ databasePath: paths.databasePath, workRoot: paths.workRoot }, Date.now())
    expect(config.enabled).toBe(false)
    expect(config.mode).toBe('observe')
    expect(config.intakeSourceId).toBe('work-items/v1')
    expect(config.workerAutomationId).toBeNull()
    expect(config.scope).toBeNull()
    expect(config.admission).toMatchObject({ allowedKinds: [], maxOpenItems: 8, maxAdmitsPerHour: 4 })
    expect(config.limits).toMatchObject({ leaseMs: 900_000, maxAttempts: 3, maxReportsPerItem: 20 })
    expect(config.notifyOn).toEqual(['ready', 'blocked', 'failed'])
    expect(isActive(config)).toBe(false)
  })

  test('rejects unknown fields and unsafe paths', async () => {
    const paths = await location()
    expect(() => normalizeConfig({ databasePath: paths.databasePath, workRoot: paths.workRoot, extra: true } as unknown as Config, Date.now()))
      .toThrow(/unknown field extra/)
    expect(() => normalizeConfig({ databasePath: 'relative.sqlite', workRoot: paths.workRoot }, Date.now()))
      .toThrow(/absolute path/)
    expect(() => normalizeConfig({ databasePath: paths.databasePath, workRoot: '/' }, Date.now()))
      .toThrow(/filesystem root/)
    expect(() => normalizeConfig({ databasePath: paths.workRoot, workRoot: paths.workRoot }, Date.now()))
      .toThrow(/must differ/)
  })

  test('active mode fails closed without a worker, owner scope and kind allowlist', () => {
    const now = Date.now()
    expect(() => normalizeConfig(active({ workerAutomationId: undefined }), now)).toThrow(/workerAutomationId/)
    expect(() => normalizeConfig(active({ scope: undefined }), now)).toThrow(/scope/)
    expect(() => normalizeConfig(active({ admission: { allowedKinds: [] } }), now)).toThrow(/allowedKinds/)
    expect(() => normalizeConfig(active({
      scope: { ...active().scope!, expiresAt: now - 1 },
    }), now)).toThrow(/expiresAt/)
  })

  test('accepts observe mode without an active worker automation', async () => {
    const paths = await location()
    const config = normalizeConfig({ databasePath: paths.databasePath, workRoot: paths.workRoot, enabled: true, mode: 'observe' }, Date.now())
    expect(config.enabled).toBe(true)
    expect(config.mode).toBe('observe')
    expect(isActive(config)).toBe(false)
  })

  test('a disabled service opens no directory and reports a neutral health view', async () => {
    const paths = await location()
    const ctx = new Context()
    const service = new AssistantWorkItemsService(ctx, {
      enabled: false,
      databasePath: paths.databasePath,
      workRoot: paths.workRoot,
    })
    expect(service.enabled).toBe(false)
    expect(service.mode).toBe('observe')
    expect(await readdir(paths.root)).toEqual([])
    expect(service.health()).toEqual({
      enabled: false,
      mode: 'observe',
      openItems: 0,
      lastAdmitAt: null,
      lastDispatchAt: null,
      dispatchUnknown: 0,
      workerConnected: false,
      ownerRouteValid: false,
    })
    service.close()
    expect(await readdir(paths.root)).toEqual([])
  })
})
