import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { HoldoutAuthority, verifyHoldoutSignature, type CellObservation, type HoldoutDataset } from '../src/holdout-authority.ts'
import { createProspectiveCertificate, generateProspectiveDataset, generatorDigest, prospectiveDatasetDigest, verifyProspectiveCertificate } from '../src/prospective-holdout.ts'

const hex = (letter: string) => letter.repeat(64)
const dataset: HoldoutDataset = {
  id: 'private-suite', version: '1', cases: [
    { id: 'r', kind: 'replay', stdin: 'replay secret', expectedStdout: 'replay ok', expectedExitCode: 0 },
    { id: 'e', kind: 'evaluation', stdin: 'evaluation secret', expectedStdout: 'evaluation ok', expectedExitCode: 0 },
    { id: 'g', kind: 'regression', stdin: 'regression secret', expectedStdout: 'regression ok', expectedExitCode: 0 },
  ],
}
const keys = generateKeyPairSync('ed25519')
const binding = { scopeDigest: hex('a'), baselineDigest: hex('b'), candidateDigest: hex('c'), budgetDigest: hex('d'), expiresAt: 10_000, repeats: 2 }
const config = (now = () => 1) => ({ dataset, privateKey: keys.privateKey, limits: { maxToolCalls: 2, maxOutputBytes: 1024 }, now })
const observation = (cellId: string, armDigest: string, stdout = 'replay ok'): CellObservation => ({ cellId, armDigest, stdout, exitCode: 0, quiescent: true, status: 'completed', artifactDigest: hex('e'), toolCalls: [] })

describe('independent holdout authority', () => {
  test('binds a prospective certificate to the frozen arms, generated dataset, key, and sequence', () => {
    const prospectiveDataset = generateProspectiveDataset(), freezeId = '123e4567-e89b-42d3-a456-426614174000'
    const certificate = createProspectiveCertificate(binding, prospectiveDataset, keys.privateKey, freezeId)
    expect(prospectiveDatasetDigest(prospectiveDataset)).toBe(certificate.datasetDigest)
    expect(verifyProspectiveCertificate(certificate, binding, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), generatorDigest)).toBe(true)
    expect(verifyProspectiveCertificate({ ...certificate, binding: { ...binding, candidateDigest: hex('e') } }, binding, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), generatorDigest)).toBe(false)
    expect(verifyProspectiveCertificate({ ...certificate, datasetDigest: hex('e') }, binding, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), generatorDigest)).toBe(false)
    expect(verifyProspectiveCertificate({ ...certificate, generatedSequence: 1 }, binding, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), generatorDigest)).toBe(false)
    expect(verifyProspectiveCertificate(certificate, binding, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString(), generatorDigest)).toBe(false)
    const authority = HoldoutAuthority.create({ dataset: prospectiveDataset, privateKey: keys.privateKey, limits: { maxToolCalls: 2, maxOutputBytes: 1024 }, prospective: certificate, now: () => 1 })
    expect(authority.begin(binding).prospective).toEqual(certificate)
  })

  test('binds a plan and signs cells and receipts without exposing expected answers', () => {
    const authority = HoldoutAuthority.create(config())
    const begin = authority.begin(binding)
    expect(JSON.stringify(begin)).not.toContain('secret')
    expect(JSON.stringify(begin)).not.toContain('replay ok')
    const first = authority.next()!
    expect(first.stdin).toBe('replay secret')
    expect(verifyHoldoutSignature(first as unknown as Record<string, unknown>, begin.publicKey)).toBe(true)
    expect(verifyHoldoutSignature({ ...first, stdin: 'altered' } as unknown as Record<string, unknown>, begin.publicKey)).toBe(false)
    authority.record(observation(first.cellId, first.armDigest))
    while (true) {
      const cell = authority.next(); if (!cell) break
      const expected = dataset.cases.find(item => cell.stdin === item.stdin)!
      authority.record(observation(cell.cellId, cell.armDigest, expected.expectedStdout))
    }
    const receipt = authority.finish()
    expect(receipt.complete).toBe(true)
    expect(verifyHoldoutSignature(receipt as unknown as Record<string, unknown>, begin.publicKey)).toBe(true)
    expect(JSON.stringify(receipt)).not.toContain('secret')
    expect(JSON.stringify(receipt)).not.toContain('expectedStdout')
    expect(JSON.stringify(receipt)).not.toContain('promotion')
  })

  test('rejects out-of-order and duplicate settlement, and evaluates itself', () => {
    const authority = HoldoutAuthority.create(config()); authority.begin(binding)
    const first = authority.next()!
    expect(() => authority.next()).toThrow(/must be settled/)
    expect(() => authority.record(observation('cell-2', first.armDigest))).toThrow(/not issued/)
    expect(() => authority.record(observation(first.cellId, hex('f')))).toThrow(/does not match/)
    expect(authority.record(observation(first.cellId, first.armDigest, 'caller says good'))).toBe('not-achieved')
    expect(() => authority.record(observation(first.cellId, first.armDigest))).toThrow(/already been settled/)
  })

  test('recovery turns an outstanding cell and remaining cells into unknown and emits incomplete receipt', () => {
    const authority = HoldoutAuthority.create(config()); authority.begin(binding)
    authority.next()
    const restored = HoldoutAuthority.restore(authority.serialize(), config())
    expect(restored.next()).toBeUndefined()
    const receipt = restored.finish()
    expect(receipt.complete).toBe(false)
    expect(receipt.stoppedReason).toBe('recovered-outstanding')
    expect(receipt.cellVerdicts.every(cell => cell.verdict === 'unknown')).toBe(true)
  })

  test('fails closed for tampering, expiry, missing exit code, and excessive tool calls', () => {
    const authority = HoldoutAuthority.create(config()); authority.begin(binding)
    const saved = authority.serialize()
    expect(() => HoldoutAuthority.restore(saved.replace(/"signature":"./u, '"signature":"x'), config())).toThrow(/signature is invalid/)
    const issued = authority.next()!
    expect(authority.record({ ...observation(issued.cellId, issued.armDigest), exitCode: null })).toBe('unknown')
    expect(authority.finish().complete).toBe(false)

    const over = HoldoutAuthority.create(config()); over.begin(binding); const cell = over.next()!
    expect(() => over.record({ ...observation(cell.cellId, cell.armDigest), toolCalls: [{ name: 'a', inputDigest: hex('a') }, { name: 'b', inputDigest: hex('b') }, { name: 'c', inputDigest: hex('c') }] })).toThrow(/exceed/)

    const expired = HoldoutAuthority.create(config(() => 10_001));
    expect(() => expired.begin(binding)).toThrow(/future timestamp/)
    let clock = 1
    const delayed = HoldoutAuthority.create(config(() => clock)); clock = 10_001
    expect(() => delayed.begin(binding)).toThrow(/future timestamp/)
    const started = HoldoutAuthority.create(config()); started.begin(binding)
    const later = HoldoutAuthority.restore(started.serialize(), config(() => 10_001))
    expect(later.finish().complete).toBe(false)
    expect(later.finish().stoppedReason).toBe('expired')
  })

  test('requires distinct arms, bounded exit codes, an Ed25519 key, and immutable restore limits', () => {
    const sameArms = { ...binding, candidateDigest: binding.baselineDigest }
    expect(() => HoldoutAuthority.create(config()).begin(sameArms)).toThrow(/must differ/)
    expect(() => HoldoutAuthority.create({ ...config(), privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey })).toThrow(/Ed25519/)
    const authority = HoldoutAuthority.create(config()); authority.begin(binding); const cell = authority.next()!
    expect(() => authority.record({ ...observation(cell.cellId, cell.armDigest), exitCode: 256 })).toThrow(/execution status is invalid/)
    expect(() => HoldoutAuthority.restore(authority.serialize(), { ...config(), limits: { maxToolCalls: 32, maxOutputBytes: 262144 } })).toThrow(/limits/)
    expect(() => HoldoutAuthority.create(config()).begin({ ...binding, planDigest: hex('f') } as never)).toThrow(/binding shape/)
    const clean = HoldoutAuthority.create(config()); clean.begin(binding); const current = clean.next()!
    expect(() => clean.record({ ...observation(current.cellId, current.armDigest), verdict: 'achieved' } as never)).toThrow(/observation shape/)
  })
})
