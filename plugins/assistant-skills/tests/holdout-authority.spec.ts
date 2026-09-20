import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { HoldoutAuthority, verifyHoldoutSignature, verifyProspectiveBenchmarkManifest, type CellObservation, type HoldoutDataset } from '../src/holdout-authority.ts'
import { createProspectiveCertificate, generateProspectiveDataset, generatorDigest, prospectiveDatasetDigest, prospectiveGeneratorDigest, verifyProspectiveCertificate } from '../src/prospective-holdout.ts'

const hex = (letter: string) => letter.repeat(64)
const canonical = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
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

  test('signs answer-free prospective commitments only before the first issued cell', () => {
    const prospectiveDataset = generateProspectiveDataset(), frozen = { ...binding, expiresAt: Date.now() + 60_000 }
    const certificate = createProspectiveCertificate(frozen, prospectiveDataset, keys.privateKey, '123e4567-e89b-42d3-a456-426614174010')
    const authority = HoldoutAuthority.create({ dataset: prospectiveDataset, privateKey: keys.privateKey, limits: { maxToolCalls: 2, maxOutputBytes: 1024 }, prospective: certificate })
    const manifest = authority.begin(frozen) && authority.manifest()
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    expect(verifyProspectiveBenchmarkManifest(manifest, frozen, publicKey, certificate.generatorDigest)).toBe(true)
    const wrongBegin = { ...manifest.begin, datasetDigest: hex('e') }
    wrongBegin.planDigest = createHash('sha256').update(canonical({ sessionId: wrongBegin.sessionId, datasetDigest: wrongBegin.datasetDigest, binding: frozen, limits: wrongBegin.limits, cells: manifest.cells })).digest('hex')
    const { signature: _signature, ...body } = { ...manifest, begin: wrongBegin }
    const resigned = { ...body, signature: sign(null, Buffer.from(canonical(body)), keys.privateKey).toString('base64url') }
    expect(verifyHoldoutSignature(resigned as unknown as Record<string, unknown>, publicKey)).toBe(true)
    expect(verifyProspectiveBenchmarkManifest(resigned, frozen, publicKey, certificate.generatorDigest)).toBe(false)
    expect(JSON.stringify(manifest)).not.toMatch(/expectedStdout|stdin/u)
    expect(manifest.cases).toHaveLength(prospectiveDataset.cases.length)
    expect(manifest.cells).toHaveLength(prospectiveDataset.cases.length * frozen.repeats * 2)
    expect(verifyProspectiveBenchmarkManifest({ ...manifest, begin: { ...manifest.begin, budgetDigest: hex('f') } }, frozen, publicKey, certificate.generatorDigest)).toBe(false)
    expect(verifyProspectiveBenchmarkManifest(manifest, frozen, publicKey, hex('f'))).toBe(false)
    expect(verifyProspectiveBenchmarkManifest({ ...manifest, cells: [{ ...manifest.cells[0]!, armDigest: hex('f') }, ...manifest.cells.slice(1)] }, frozen, publicKey, certificate.generatorDigest)).toBe(false)
    expect(verifyProspectiveBenchmarkManifest({ ...manifest, cells: [...manifest.cells.slice(0, -1), manifest.cells[0]!] }, frozen, publicKey, certificate.generatorDigest)).toBe(false)
    const replacement = manifest.signature[0] === 'A' ? 'B' : 'A'
    expect(verifyProspectiveBenchmarkManifest({ ...manifest, signature: `${replacement}${manifest.signature.slice(1)}` }, frozen, publicKey, certificate.generatorDigest)).toBe(false)
    authority.next()
    expect(() => authority.manifest()).toThrow(/after cell issuance/)
    const fixed = HoldoutAuthority.create(config(() => Date.now()))
    fixed.begin({ ...binding, expiresAt: Date.now() + 60_000 })
    expect(() => fixed.manifest()).toThrow(/requires a prospective qualification/)
    let clock = 1
    const expiringCertificate = createProspectiveCertificate(binding, prospectiveDataset, keys.privateKey, '123e4567-e89b-42d3-a456-426614174011')
    const expiring = HoldoutAuthority.create({ dataset: prospectiveDataset, privateKey: keys.privateKey, limits: { maxToolCalls: 2, maxOutputBytes: 1024 }, prospective: expiringCertificate, now: () => clock })
    expiring.begin(binding); clock = binding.expiresAt
    expect(expiring.next()).toBeUndefined()
    expect(() => expiring.manifest()).toThrow(/expiry or stop/)
  })

  test('supports amountCents v2 with negative and empty cases under its own generator pin', () => {
    const v2 = generateProspectiveDataset('order-summary/v2'), freezeId = '123e4567-e89b-42d3-a456-426614174001'
    const certificate = createProspectiveCertificate(binding, v2, keys.privateKey, freezeId), pin = prospectiveGeneratorDigest('order-summary/v2')
    expect(v2.version).toBe('order-summary/v2')
    expect(v2.cases.find(value => value.kind === 'replay')?.expectedStdout).toBe('{}\n')
    const sample = v2.cases.find(value => value.kind === 'evaluation')!
    const orders = JSON.parse(sample.stdin) as { currency: string; amountCents: number; status: string }[]
    const currencies = [...new Set(orders.filter(order => order.status !== 'cancelled').map(order => order.currency))].sort()
    const totals = Object.fromEntries(currencies.map(currency => [currency, orders.filter(order => order.status !== 'cancelled' && order.currency === currency).reduce((sum, order) => sum + order.amountCents, 0)]))
    expect(sample.expectedStdout).toBe(JSON.stringify(totals) + '\n')
    expect(Object.values(totals).every(total => total < 0)).toBe(true)
    expect(orders.some(order => order.status === 'cancelled' && order.amountCents > 0)).toBe(true)
    expect(orders.every(order => !Object.hasOwn(order, 'cents'))).toBe(true)
    expect(certificate.generatorDigest).toBe(pin)
    expect(verifyProspectiveCertificate(certificate, binding, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), pin)).toBe(true)
    expect(verifyProspectiveCertificate(certificate, binding, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), generatorDigest)).toBe(false)
    const authority = HoldoutAuthority.create({ dataset: v2, privateKey: keys.privateKey, limits: { maxToolCalls: 2, maxOutputBytes: 1024 }, prospective: certificate, now: () => 1 })
    expect(authority.begin(binding).prospective?.generatorDigest).toBe(pin)
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
    // Deterministically flip the signature's first character. The base64url
    // signature is key-random, so a fixed replacement letter (e.g. "x") is a
    // ~1/64 no-op whenever the original first character already equals it; pick
    // a letter guaranteed to differ and assert the bytes really changed.
    const firstSignatureChar = JSON.parse(saved).signature[0] as string
    const replacement = firstSignatureChar === 'A' ? 'B' : 'A'
    const tampered = saved.replace(
      `"signature":"${firstSignatureChar}`,
      `"signature":"${replacement}`,
    )
    expect(tampered).not.toBe(saved)
    expect(() => HoldoutAuthority.restore(tampered, config())).toThrow(/signature is invalid/)
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
