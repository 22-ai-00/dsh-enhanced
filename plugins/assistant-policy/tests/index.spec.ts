import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as entrypoint from '../src/index.ts'
import { apply, name, version } from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
  dependencies: Record<string, string>
  peerDependencies: Record<string, string>
}
const bundle = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

describe('dsh-enhanced-assistant-policy', () => {
  it('exposes stable plugin identity', () => {
    expect(name).toBe('dsh-enhanced-assistant-policy')
    expect(version).toBe(manifest.version)
    expect(entrypoint).not.toHaveProperty('PolicyLedger')
    expect(entrypoint).not.toHaveProperty('PolicyLedgerError')
    expect(entrypoint.APPROVAL_DISPLAY_BUDGET).toEqual({
      maxTextBytes: 64 * 1_024,
      maxSummaryBytes: 120,
      renderingReserveBytes: 4 * 1_024,
      maxDiffBytes: 60 * 1_024,
    })
    expect(Object.isFrozen(entrypoint.APPROVAL_DISPLAY_BUDGET)).toBe(true)
    expect(entrypoint.isAutoReviewEscalation).toBeTypeOf('function')
    expect(entrypoint.AUTO_REVIEW_APPROVAL_REASON).toContain('ask-review')
    expect(entrypoint.HUMAN_APPROVAL_REASON).toContain('ask-human')
  })

  it('ships a private DSH-home database default and the verified host peers', () => {
    expect(bundle).toContain("dshHomePath('assistant-policy/policy.sqlite')")
    expect(bundle).toContain('toolDefaultEffect: deny')
    expect(bundle).toContain('autoReview:')
    expect(bundle).toContain('enabled: true')
    expect(bundle).toContain('rules: []')
    expect(bundle).toContain('budgets: []')
    expect(manifest.dependencies['@deepseek-ai/schemastery']).toBe('catalog:')
    expect(manifest.peerDependencies['@deepseek-ai/dsh-llm']).toBe('>=0.1.0-rc.8 <0.2.0')
    expect(manifest.peerDependencies['@deepseek-ai/dsh-tools']).toBe('>=0.1.0-rc.8 <0.2.0')
  })

  it('loads through the Cordis entrypoint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-policy-entry-'))
    const ctx = new Context()
    try {
      apply(ctx, { databasePath: join(root, 'policy.sqlite'), rules: [] })
      expect(ctx.get('assistantPolicy')).toBeDefined()
      await ctx.fiber.restart()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
