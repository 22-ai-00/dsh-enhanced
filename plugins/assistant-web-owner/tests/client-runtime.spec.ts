import * as Cordis from '@deepseek-ai/cordis'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it, vi } from 'vitest'
import { TYPERT_REMOTE } from '../src/typert.ts'

describe('notice client Remote namespace lifecycle', () => {
  it('makes the mounted namespace available only to a dynamic Cordis injection', async () => {
    let registration: { factory(require: (id: string) => unknown): { apply(ctx: Context): void } } | undefined
    const previousWindow = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = { __ModuleLoader__: { load: (value: typeof registration) => { registration = value } } }
    await import('@deepseek-ai/dsh-api-gateway/client')
    if (registration === undefined) throw new Error('Gateway client did not register a ModuleLoader factory')
    const GatewayClient = registration.factory((id) => {
      if (id === '@deepseek-ai/cordis') return Cordis
      throw new Error(`unexpected Gateway client dependency ${id}`)
    })
    const ctx = new Context()
    const call = vi.fn(async () => ({ ok: true, value: [{ id: 'notice-1', text: '已准备', createdAt: 1 }] }))
    let released = 0
    try {
      ctx.provide('connection' as never, {
        rpc: { call, open: async () => { throw new Error('stream is not used by a unary notice read') } },
        start: () => () => undefined,
        registerGenerationSource: () => () => undefined,
      } as never)
      await ctx.plugin(TypertRegistry)
      GatewayClient.apply(ctx)
      expect(ctx.get('remote.deliveryNotices' as never)).toBeUndefined()
      const unmount = await ctx.remote.$mount(TYPERT_REMOTE)
      const fiber = ctx.inject(['remote.deliveryNotices'], (runtime) => {
        const namespace = (runtime.remote as unknown as { deliveryNotices: { list(sessionId: string): Promise<unknown> } }).deliveryNotices
        expect(namespace).toBeDefined()
        void namespace.list('owned-session')
        return () => { released += 1 }
      })
      await fiber
      await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/api', 'deliveryNotices/list', {
        args: { sessionId: 'owned-session' },
      }, expect.any(AbortSignal)))
      await unmount()
      await vi.waitFor(() => expect(released).toBe(1))
      expect(ctx.get('remote.deliveryNotices' as never)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })
})
