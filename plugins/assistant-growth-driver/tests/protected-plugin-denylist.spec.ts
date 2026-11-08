import { describe, expect, test } from 'vitest'
import { PROTECTED_PLUGIN_DENYLIST } from '@dsh-enhanced/plugin-control-plane'
import { GROWTH_PROTECTED_PLUGIN_DENYLIST } from '../src/source-port.ts'

describe('protected plugin denylists', () => {
  test('growth-side and control-plane layers guard the exact same safety roots', () => {
    expect([...GROWTH_PROTECTED_PLUGIN_DENYLIST].sort()).toEqual([...PROTECTED_PLUGIN_DENYLIST].sort())
  })

  test('the growth driver itself and other self-evolution roots stay immutable', () => {
    for (const name of [
      'assistant-growth-driver',
      'plugin-control-plane',
      'assistant-policy',
      'assistant-verifier',
      'assistant-recovery',
      'assistant-evolution',
      'owner-console',
      'assistant-web-owner',
      'assistant-actions',
      'assistant-work-items',
    ]) {
      expect(GROWTH_PROTECTED_PLUGIN_DENYLIST.has(name), name).toBe(true)
    }
  })
})
