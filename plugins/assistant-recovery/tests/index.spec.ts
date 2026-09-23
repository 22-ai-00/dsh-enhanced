import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Config, inject, name, version } from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

describe('dsh-enhanced-assistant-recovery', () => {
  it('exposes stable plugin identity', () => {
    expect(name).toBe('dsh-enhanced-assistant-recovery')
    expect(version).toBe(manifest.version)
  })

  it('publishes the exact Cordis dependency and configuration contract', () => {
    const expectedInject = [
      'assistantAutomations', 'assistantDelivery', 'assistantEvaluation', 'assistantEvolution',
      'assistantGoals', 'assistantPreferenceLearning', 'assistantHealth',
    ]
    expect(inject).toEqual(expectedInject)
    for (const service of expectedInject) {
      expect(patch).toContain(`        - ${service}\n`)
    }
    expect(Config({ databasePath: '/state/recovery.sqlite' })).toMatchObject({
      databasePath: '/state/recovery.sqlite', jobs: [], maxStepDurationMs: 10_000,
    })
  })
})
