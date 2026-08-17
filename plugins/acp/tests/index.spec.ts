import { describe, expect, it } from 'vitest'
import { Config, inject, name } from '../src/index.ts'

describe('@dsh-enhanced/acp package contract', () => {
  it('uses the stable Cordis identity and native service injections', () => {
    expect(name).toBe('dsh-enhanced-acp')
    expect(inject).toEqual(['agentDefaultModel', 'agents', 'llm', 'planMode'])
  })

  it('defaults lossless DSH event metadata on', () => {
    expect(Config({})).toMatchObject({ includeRawEvents: true })
  })
})
