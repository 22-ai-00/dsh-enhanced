import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { name, version } from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}

describe('dsh-ray-assistant-growth-experiments', () => {
  it('exposes stable plugin identity', () => {
    expect(name).toBe('dsh-ray-assistant-growth-experiments')
    expect(version).toBe(manifest.version)
  })
})
