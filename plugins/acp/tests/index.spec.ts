import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Config, inject, name } from '../src/index.ts'

const bundle = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

describe('@dsh-enhanced/acp package contract', () => {
  it('uses the stable Cordis identity and native service injections', () => {
    expect(name).toBe('dsh-enhanced-acp')
    expect(inject).toEqual(['agentDefaultModel', 'agentPresets', 'agents', 'llm'])
  })

  it('defaults lossless DSH event metadata on', () => {
    expect(Config({})).toMatchObject({ includeRawEvents: true })
  })

  it('composes the DSH agent preset roster required by ACP modes', () => {
    expect(bundle).toContain("id: agent-presets")
    expect(bundle).toContain("name: '@deepseek-ai/dsh-agent-presets'")
    expect(bundle).toContain('default: standard')
    expect(bundle).toContain("name: '@deepseek-ai/dsh-cordis-host-runner'")
  })
})
