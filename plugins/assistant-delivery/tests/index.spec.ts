import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import plugin, {
  AssistantDeliveryService,
  Config,
  collectDeliveryVersionReport,
  formatAssistantVersionSummary,
  name,
  parseOwnerSelfIterationCommand,
  parseOwnerVersionQuery,
  version,
} from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}

describe('dsh-ray-assistant-delivery', () => {
  it('exposes stable plugin identity', () => {
    expect(name).toBe('dsh-ray-assistant-delivery')
    expect(version).toBe(manifest.version)
  })

  it('exports the Cordis service and validated config entrypoint', () => {
    expect(plugin).toBe(AssistantDeliveryService)
    expect(Config).toBe(AssistantDeliveryService.Config)
  })

  it('re-exports parseOwnerSelfIterationCommand cleanly', () => {
    expect(parseOwnerSelfIterationCommand('开启自迭代')?.action).toBe('enableSelfIteration')
    expect(parseOwnerSelfIterationCommand('今天北京天气怎么样？')).toBeUndefined()
  })

  it('re-exports version query parser, collector, and formatter cleanly', () => {
    expect(parseOwnerVersionQuery('/version')?.kind).toBe('version')
    expect(parseOwnerVersionQuery('自己迭代了多少次？')?.kind).toBe('natural-language')
    expect(parseOwnerVersionQuery('/version extra')).toBeUndefined()
    expect(typeof collectDeliveryVersionReport).toBe('function')
    expect(typeof formatAssistantVersionSummary).toBe('function')
  })
})
