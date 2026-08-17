import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, name } from '../src/index.ts'

describe('{{PLUGIN_ID}}', () => {
  it('exposes stable plugin identity', () => {
    expect(name).toBe('{{PLUGIN_ID}}')
  })

  it('loads through the Cordis entrypoint', () => {
    const info = vi.fn()
    apply({ logger: { info } } as unknown as Context)
    expect(info).toHaveBeenCalledOnce()
  })
})
