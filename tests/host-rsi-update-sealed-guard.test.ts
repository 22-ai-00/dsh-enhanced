import { expect, test } from 'vitest'
import { assertNoSealedAdoptionChain } from '../scripts/install/host-rsi-update.mjs'

const program = (update: Record<string, unknown>) => ({ kind: 'rsi-owner-program-update-overlay', update })

test('Host update refuses an owner chain that contains a sealed adoption handoff anywhere', () => {
  const sealed = program({ sealedAdoptionHandoff: { protocol: 'dsh-owner-sealed-adoption-handoff/v1' } })
  expect(() => assertNoSealedAdoptionChain([sealed])).toThrow('sealed-aware Host update')
  // Earlier sealed overlay followed by a Host overlay is still refused.
  expect(() => assertNoSealedAdoptionChain([sealed, { kind: 'rsi-host-update-overlay' }])).toThrow('sealed-aware Host update')
})

test('Host update keeps accepting chains without a sealed handoff', () => {
  expect(() => assertNoSealedAdoptionChain([])).not.toThrow()
  expect(() => assertNoSealedAdoptionChain([program({ emptyAdoptionHandoff: {} }), { kind: 'rsi-owner-repair-overlay' },
    { kind: 'rsi-host-update-overlay' }])).not.toThrow()
  expect(() => assertNoSealedAdoptionChain(undefined as never)).toThrow('chain is invalid')
})
