import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, helloMessage, name } from '../src/index.ts'

describe('dsh-enhanced-hello', () => {
  it('exposes stable plugin identity', () => {
    expect(name).toBe('dsh-enhanced-hello')
  })

  it('logs its activation', () => {
    const info = vi.fn()
    apply({ logger: { info } } as unknown as Context)
    expect(info).toHaveBeenCalledWith(helloMessage)
  })
})
