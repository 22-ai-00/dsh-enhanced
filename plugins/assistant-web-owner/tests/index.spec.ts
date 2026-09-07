import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { name, version } from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}

describe('dsh-enhanced-assistant-web-owner', () => {
  it('exposes stable plugin identity', () => {
    expect(name).toBe('dsh-enhanced-assistant-web-owner')
    expect(version).toBe(manifest.version)
  })

  it('disables the upstream controller before mounting its own stable row', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain("id: session-controller")
    expect(patch).toContain('disabled: true')
    expect(patch).toContain("name: '@dsh-enhanced/assistant-web-owner'")
  })
})
