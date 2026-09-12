import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { describe, expect, it } from 'vitest'
import {
  HOLDOUT_PROTOCOL_V1, holdoutAuthorityKeyId, holdoutEnvelopeDigest, holdoutInputBytes, holdoutUnsignedCanonicalJson, holdoutVerdictsDigest,
  parseSignedHoldoutFinish, parseSignedHoldoutInput, parseSignedHoldoutManifest, parseSignedHoldoutVerdict, verifyHoldoutEnvelopeSignature,
} from '../../src/benchmark/holdout-protocol.js'
import type { SignedHoldoutFinish, SignedHoldoutInput, SignedHoldoutManifest, SignedHoldoutVerdict } from '../../src/benchmark/holdout-protocol.js'
import type { BenchmarkCell } from '../../src/benchmark/types.js'

const keys = generateKeyPairSync('ed25519')
const otherKeys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString()
const hex = (value: string): string => createHash('sha256').update(value).digest('hex')
const signed = <T extends object>(value: T): T & { signature: string } => ({ ...value, signature: sign(null, Buffer.from(holdoutUnsignedCanonicalJson(value)), keys.privateKey).toString('base64url') })

const cases = [
  { id: 'case-a', domain: 'research' as const, inputDigest: hex('private input'), acceptanceDigest: hex('private oracle') },
  { id: 'case-b', domain: 'injection' as const, inputDigest: hex('second input'), acceptanceDigest: hex('second oracle') },
]
const dataset = { id: 'private-suite', version: 'v1', split: 'holdout' as const, digest: acceptanceDigest({ id: 'private-suite', version: 'v1', split: 'holdout', cases }) }
const manifest = (): SignedHoldoutManifest => signed({ protocol: HOLDOUT_PROTOCOL_V1, kind: 'manifest' as const, manifestId: 'manifest-1', authorityKeyId: holdoutAuthorityKeyId(publicKey), dataset, cases, issuedAt: 100 })
const planDigest = hex('plan')
const cells: BenchmarkCell[] = [
  { id: hex('cell-a'), caseId: 'case-a', variantId: 'baseline', repeat: 0, seed: 7 },
  { id: hex('cell-b'), caseId: 'case-a', variantId: 'candidate', repeat: 0, seed: 7 },
]
const input = (cell = cells[0]!, text = 'private input'): SignedHoldoutInput => signed({
  protocol: HOLDOUT_PROTOCOL_V1, kind: 'input' as const, authorityKeyId: holdoutAuthorityKeyId(publicKey), manifestDigest: holdoutEnvelopeDigest(manifest()),
  planDigest, cell, inputDigest: hex(text), contentType: 'text/plain; charset=utf-8', inputBase64url: Buffer.from(text).toString('base64url'),
})
const verdict = (cell = cells[0]!, outputDigest = hex('output')): SignedHoldoutVerdict => signed({
  protocol: HOLDOUT_PROTOCOL_V1, kind: 'verdict' as const, authorityKeyId: holdoutAuthorityKeyId(publicKey), manifestDigest: holdoutEnvelopeDigest(manifest()),
  planDigest, cell, inputDigest: cases[0]!.inputDigest, acceptanceDigest: cases[0]!.acceptanceDigest, outputDigest, verdict: 'achieved' as const, evaluatedAt: 200,
})

describe('independent holdout signed protocol', () => {
  it('accepts a bounded canonical manifest containing commitments but no oracle material', () => {
    const parsed = parseSignedHoldoutManifest(manifest(), publicKey)
    expect(parsed.dataset.split).toBe('holdout')
    expect(parsed.cases).toEqual(cases)
    expect(Object.isFrozen(parsed.cases)).toBe(true)
    expect(JSON.stringify(parsed)).not.toMatch(/answer|oracle|judge|expected|prompt|source|path/iu)
    expect(verifyHoldoutEnvelopeSignature(parsed, publicKey)).toBe(true)
    expect(verifyHoldoutEnvelopeSignature(parsed, otherKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString())).toBe(false)
  })

  it('rejects unknown fields, unsafe data shapes, excessive complexity, and a digest not derived from public commitments', () => {
    expect(() => parseSignedHoldoutManifest(signed({ ...manifest(), answer: 'leak' }), publicKey)).toThrow(/unexpected fields/u)
    expect(() => parseSignedHoldoutManifest(signed({ ...manifest(), dataset: { ...dataset, digest: hex('wrong') } }), publicKey)).toThrow(/dataset digest/u)
    const getter = manifest() as unknown as Record<string, unknown>
    Object.defineProperty(getter, 'manifestId', { enumerable: true, get: () => 'manifest-1' })
    expect(() => parseSignedHoldoutManifest(getter, publicKey)).toThrow(/unsafe property/u)
    const sparse = [...manifest().cases]; sparse.length++
    expect(() => parseSignedHoldoutManifest(signed({ ...manifest(), cases: sparse }), publicKey)).toThrow(/sparse/u)
    let nested: unknown = null
    for (let index = 0; index < 18; index++) nested = { nested }
    expect(() => parseSignedHoldoutManifest({ ...manifest(), nested }, publicKey)).toThrow(/complex|unexpected/u)
  })

  it('binds signed input bytes to the exact manifest, plan, cell, and case without exposing acceptance data', () => {
    const parsed = parseSignedHoldoutInput(input(), manifest(), planDigest, cells[0]!, publicKey)
    expect(Buffer.from(holdoutInputBytes(parsed)).toString()).toBe('private input')
    expect(parsed).not.toHaveProperty('acceptanceDigest')
    expect(JSON.stringify(parsed)).not.toMatch(/answer|oracle|judge|expected/iu)
    expect(() => parseSignedHoldoutInput(input(cells[1]!), manifest(), planDigest, cells[0]!, publicKey)).toThrow(/cell identity/u)
    expect(() => parseSignedHoldoutInput(input(cells[0]!, 'changed'), manifest(), planDigest, cells[0]!, publicKey)).toThrow(/case commitment/u)
    expect(() => parseSignedHoldoutInput(signed({ ...input(), inputBase64url: '***' }), manifest(), planDigest, cells[0]!, publicKey)).toThrow(/encoding/u)
  })

  it('binds a signed verdict to the exact output, input, acceptance commitment, plan, and cell', () => {
    const outputDigest = hex('output')
    const parsed = parseSignedHoldoutVerdict(verdict(cells[0]!, outputDigest), manifest(), planDigest, cells[0]!, outputDigest, publicKey)
    expect(parsed.verdict).toBe('achieved')
    expect(() => parseSignedHoldoutVerdict(verdict(), manifest(), planDigest, cells[0]!, hex('other-output'), publicKey)).toThrow(/output identity/u)
    expect(() => parseSignedHoldoutVerdict(signed({ ...verdict(), acceptanceDigest: hex('other') }), manifest(), planDigest, cells[0]!, outputDigest, publicKey)).toThrow(/case commitment/u)
    expect(() => parseSignedHoldoutVerdict(signed({ ...verdict(), verdict: 'passed' }), manifest(), planDigest, cells[0]!, outputDigest, publicKey)).toThrow(/verdict value/u)
  })

  it('binds finish to the ordered exact cell identities and signed verdict envelope digests', () => {
    const verdictDigests = [holdoutEnvelopeDigest(verdict(cells[0]!)), holdoutEnvelopeDigest(verdict(cells[1]!))]
    const finish: SignedHoldoutFinish = signed({ protocol: HOLDOUT_PROTOCOL_V1, kind: 'finish' as const, authorityKeyId: holdoutAuthorityKeyId(publicKey),
      manifestDigest: holdoutEnvelopeDigest(manifest()), planDigest, cellCount: 2, verdictsDigest: holdoutVerdictsDigest(cells, verdictDigests), complete: true, finalizedAt: 300 })
    expect(parseSignedHoldoutFinish(finish, manifest(), planDigest, cells, verdictDigests, publicKey).complete).toBe(true)
    expect(() => parseSignedHoldoutFinish(finish, manifest(), planDigest, [...cells].reverse(), verdictDigests, publicKey)).toThrow(/verdict chain/u)
    expect(() => parseSignedHoldoutFinish(signed({ ...finish, cellCount: 1 }), manifest(), planDigest, cells, verdictDigests, publicKey)).toThrow(/completion metadata/u)
    const partial = signed({ ...finish, cellCount: 1, verdictsDigest: holdoutVerdictsDigest(cells.slice(0, 1), verdictDigests.slice(0, 1)), complete: false })
    expect(parseSignedHoldoutFinish(partial, manifest(), planDigest, cells, verdictDigests.slice(0, 1), publicKey).complete).toBe(false)
  })
})
