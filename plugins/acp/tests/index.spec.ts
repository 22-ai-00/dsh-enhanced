import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Config, inject, name, version } from '../src/index.ts'

const bundle = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const license = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
  dependencies: Record<string, string>
  peerDependencies: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  devDependencies: Record<string, string>
}

const DSH_HOST_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-agent-presets',
  '@deepseek-ai/dsh-cordis-host-runner',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-title',
  '@deepseek-ai/dsh-user-approval',
] as const

describe('@dsh-enhanced/acp package contract', () => {
  it('uses the stable Cordis identity and native service injections', () => {
    expect(name).toBe('dsh-enhanced-acp')
    expect(inject).toEqual(['agentDefaultModel', 'agentPresets', 'agents', 'llm'])
  })

  it('keeps raw durable DSH events opt-in', () => {
    expect(Config({})).toMatchObject({ includeRawEvents: false })
    expect(bundle).toContain('includeRawEvents: false')
  })

  it('composes the DSH agent preset roster required by ACP modes', () => {
    expect(bundle).toContain("id: agent-presets")
    expect(bundle).toContain("name: '@deepseek-ai/dsh-agent-presets'")
    expect(bundle).toContain('default: standard')
    expect(bundle).toContain("name: '@deepseek-ai/dsh-cordis-host-runner'")
  })

  it('keeps the runtime version synchronized with the package revision', () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(version).toBe(manifest.version)
  })

  it('leaves DSH host packages to the profile runtime fallback', () => {
    for (const packageName of DSH_HOST_PACKAGES) {
      expect(manifest.dependencies).not.toHaveProperty(packageName)
      expect(manifest.peerDependencies[packageName]).toBeDefined()
      expect(manifest.peerDependenciesMeta?.[packageName]).toEqual({ optional: true })
      expect(manifest.devDependencies[packageName]).toBe('catalog:')
    }
  })

  it('targets the verified DSH release and carries ACP runtime libraries', () => {
    expect(manifest.dependencies.zod).toBe('catalog:')
    expect(Object.values(manifest.peerDependencies)).not.toContain('>=0.1.0-rc.5 <0.2.0')
    expect(manifest.peerDependencies['@deepseek-ai/dsh-agent']).toBe('>=0.1.0-rc.6 <0.2.0')
  })

  it('retains the upstream DeepSeek MIT attribution', () => {
    expect(license).toContain('Portions Copyright (c) 2026 DeepSeek')
  })
})
