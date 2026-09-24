import { describe, expect, test, vi } from 'vitest'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { HumanApprovalRouter } from '../src/approval-routing.ts'

const request = (signal = new AbortController().signal): ApprovalRequest => ({ signal } as ApprovalRequest)

describe('human approval channel composition', () => {
  test('a claiming owner channel precedes the generic frontend and unregisters cleanly', async () => {
    const router = new HumanApprovalRouter()
    const native = vi.fn(async () => 'rejected' as const)
    const owner = vi.fn(async () => 'allowed-once' as const)
    const dispose = router.register(owner)
    await expect(router.dispatch(request(), native)).resolves.toBe('allowed-once')
    expect(owner).toHaveBeenCalledOnce()
    expect(native).not.toHaveBeenCalled()
    dispose()
    await expect(router.dispatch(request(), native)).resolves.toBe('rejected')
    expect(native).toHaveBeenCalledOnce()
    expect(owner).toHaveBeenCalledOnce()
  })

  test('unbound channels preserve the exact request and delegate to the Web frontend once', async () => {
    const router = new HumanApprovalRouter()
    const input = request()
    router.register(async (received, next) => {
      expect(received).toBe(input)
      const first = await next()
      await expect(next()).resolves.toBe('unavailable')
      return first
    })
    const native = vi.fn(async () => 'allowed-once' as const)
    await expect(router.dispatch(input, native)).resolves.toBe('allowed-once')
    expect(native).toHaveBeenCalledOnce()
  })

  test('unload and cancellation cannot turn a late channel reply into an authorization', async () => {
    for (const mode of ['unload', 'cancel'] as const) {
      const router = new HumanApprovalRouter()
      const controller = new AbortController()
      let answer!: (value: 'allowed-once') => void
      const entered = Promise.withResolvers<void>()
      const dispose = router.register(() => { entered.resolve(); return new Promise(resolve => { answer = resolve }) })
      const native = vi.fn(async () => 'allowed-once' as const)
      const pending = router.dispatch(request(controller.signal), native)
      await entered.promise
      if (mode === 'unload') dispose()
      else controller.abort()
      answer('allowed-once')
      await expect(pending).resolves.toBe(mode === 'unload' ? 'unavailable' : 'cancelled')
      expect(native).not.toHaveBeenCalled()
    }
  })

  test('a registration removed before dispatch is never invoked', async () => {
    const router = new HumanApprovalRouter()
    const owner = vi.fn(async () => 'allowed-once' as const)
    const dispose = router.register(owner)
    const native = vi.fn(async () => 'unavailable' as const)
    const pending = router.dispatch(request(), native)
    dispose()
    await expect(pending).resolves.toBe('unavailable')
    expect(owner).not.toHaveBeenCalled()
    expect(native).toHaveBeenCalledOnce()
  })
})
