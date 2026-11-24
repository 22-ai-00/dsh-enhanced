import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { CompensationRegistry, RecoveryCompensationError } from '../src/index.js'

describe('CompensationRegistry', () => {
  it('registers handlers across all categories, lists sorted descriptors, and rejects conflicts', () => {
    const registry = new CompensationRegistry()
    const categories = ['revert', 'delete', 'cancel', 'notify-undo', 'rollback-state', 'custom'] as const
    for (const [index, category] of categories.entries()) {
      registry.register({
        kind: `test.${category}`,
        category,
        description: `Handler ${index}`,
        ...(index % 2 === 0 ? { capturePreimage: () => ({ ok: true }) } : {}),
        ...(index % 3 === 0 ? { authorize: () => true } : {}),
        compensate: () => ({ status: 'succeeded', resultCode: 'ok' }),
      })
    }

    expect(registry.has('test.revert')).toBe(true)
    expect(registry.has('missing.kind')).toBe(false)
    expect(registry.list().map(entry => entry.kind)).toEqual([
      'test.cancel',
      'test.custom',
      'test.delete',
      'test.notify-undo',
      'test.revert',
      'test.rollback-state',
    ])
    expect(registry.list().find(entry => entry.kind === 'test.revert')).toEqual({
      kind: 'test.revert',
      category: 'revert',
      description: 'Handler 0',
      capturesPreimage: true,
      hasAuthorizer: true,
    })

    expect(() =>
      registry.register({
        kind: 'test.revert',
        category: 'revert',
        compensate: () => ({ status: 'succeeded', resultCode: 'ok' }),
      }),
    ).toThrowError(expect.objectContaining<Partial<RecoveryCompensationError>>({ code: 'handler-conflict' }))

    expect(() =>
      registry.register({
        kind: 'Invalid Kind!',
        category: 'custom',
        compensate: () => ({ status: 'succeeded', resultCode: 'ok' }),
      }),
    ).toThrowError(expect.objectContaining<Partial<RecoveryCompensationError>>({ code: 'invalid-input' }))
  })

  it('auto-unregisters on ownerCtx disposal and ignores stale disposers after replacement', async () => {
    const registry = new CompensationRegistry()
    const root = new Context()
    const child = root.extend()

    const firstUnregister = registry.register(
      {
        kind: 'fs.restore',
        category: 'rollback-state',
        compensate: () => ({ status: 'succeeded', resultCode: 'v1' }),
      },
      { ownerCtx: child },
    )
    expect(registry.has('fs.restore')).toBe(true)

    const replacement = registry.register(
      {
        kind: 'fs.restore',
        category: 'rollback-state',
        compensate: () => ({ status: 'succeeded', resultCode: 'v2' }),
      },
      { replace: true },
    )

    // Disposing the original ownerCtx / calling firstUnregister must NOT remove the replacement.
    await child.fiber.dispose()
    firstUnregister()
    expect(registry.has('fs.restore')).toBe(true)
    expect(registry.get('fs.restore')?.compensate({} as never)).toEqual({ status: 'succeeded', resultCode: 'v2' })

    replacement()
    expect(registry.has('fs.restore')).toBe(false)
    await root.fiber.dispose()
  })
})
