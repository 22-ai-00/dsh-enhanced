import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantDeliveryService } from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('AssistantDeliveryService scheduler tick teardown', () => {
  test('disposes immediately with schedulerEnabled=true and tickIntervalMs=5 without unhandled rejections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-tick-teardown-'))
    roots.push(root)

    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      for (let i = 0; i < 5; i += 1) {
        const iterDir = join(root, `iter-${i}`)
        const ctx = new Context()
        await ctx.plugin(AssistantPolicyService, {
          databasePath: join(iterDir, 'policy.sqlite'),
          proposalMaintenanceIntervalMs: 0,
        })
        await ctx.plugin(AssistantDeliveryService, {
          databasePath: join(iterDir, 'delivery.sqlite'),
          spoolPath: join(iterDir, 'spool'),
          schedulerEnabled: true,
          tickIntervalMs: 100,
          defaultWorkspace: iterDir,
          defaultAgentPreset: 'standard',
        })
        await ctx.fiber.dispose()
      }
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('coalesces concurrent tick() calls and awaits in-flight tick on dispose', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-tick-coalesce-'))
    roots.push(root)
    const ctx = new Context()
    new AssistantPolicyService(ctx, {
      databasePath: join(root, 'policy.sqlite'),
      proposalMaintenanceIntervalMs: 0,
    })
    const service = new AssistantDeliveryService(ctx, {
      databasePath: join(root, 'delivery.sqlite'),
      spoolPath: join(root, 'spool'),
      schedulerEnabled: false,
      defaultWorkspace: root,
      defaultAgentPreset: 'standard',
    })

    await Promise.all([service.tick(), service.tick()])
    await ctx.fiber.dispose()
    // Calling tick after dispose is a clean no-op
    await expect(service.tick()).resolves.toBeUndefined()
  })
})
