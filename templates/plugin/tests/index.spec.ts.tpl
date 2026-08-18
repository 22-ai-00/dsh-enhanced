import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { apply, name, version } from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}

describe('{{PLUGIN_ID}}', () => {
  it('exposes stable plugin identity', () => {
    expect(name).toBe('{{PLUGIN_ID}}')
    expect(version).toBe(manifest.version)
  })

  it('loads through the Cordis entrypoint', () => {
    const info = vi.fn()
    apply({ logger: { info } } as unknown as Context)
    expect(info).toHaveBeenCalledOnce()
  })
})
