import { generateKeyPairSync, sign } from 'node:crypto'
import { expect, test } from 'vitest'
import { HoldoutAuthority, verifyHoldoutSignature } from '../src/holdout-authority.ts'
import { createProspectiveCertificate, generateProspectiveDataset, generatorDigest, prospectiveDatasetDigest, prospectiveGeneratorDigest, prospectiveGeneratorProfile, verifyProspectiveCertificate } from '../src/prospective-holdout.ts'

const hex = (letter: string) => letter.repeat(64)
const binding = { scopeDigest: hex('a'), baselineDigest: hex('b'), candidateDigest: hex('c'), budgetDigest: hex('d'), expiresAt: 10_000, repeats: 2 }
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

test('generator profiles keep legacy pins stable and give the second family an exact version and digest', () => {
  expect(prospectiveGeneratorProfile('order-summary/v1')).toEqual({ version: 'order-summary/v1', digest: generatorDigest })
  expect(generatorDigest).toBe('08e42db3920adf0c7f9d8aaa739cb623136f40797d7cd527a04bfcdd13542cc3')
  expect(prospectiveGeneratorDigest('order-summary/v2')).toBe('943b57b083f3577404af882f7a97da72f3f8a0da79f23a53107b89062e6fb057')
  expect(prospectiveGeneratorProfile('template-render/v1')).toEqual({ version: 'template-render/v1', digest: '9cccbf2de23f24b53bd432ff7f651769c909184d373a2997ad8bc3b7ed7d40d9' })
})

test('template-render privately generates replay, evaluation, and regression samples with literal non-recursive replacement', () => {
  const first = generateProspectiveDataset('template-render/v1'), second = generateProspectiveDataset('template-render/v1')
  expect(first.version).toBe('template-render/v1')
  expect(first.cases.map(value => value.kind)).toEqual(['replay', 'evaluation', 'regression'])
  expect(prospectiveDatasetDigest(first)).not.toBe(prospectiveDatasetDigest(second))
  for (const sample of first.cases) {
    const input = JSON.parse(sample.stdin) as { template: string; values: Record<string, string> }
    const expected = input.template.replace(/\{\{([a-z][a-z0-9_]*)\}\}/gu, (placeholder, key: string) => Object.hasOwn(input.values, key) ? input.values[key]! : placeholder) + '\n'
    expect(sample.expectedStdout).toBe(expected)
    expect(input).not.toHaveProperty('currency')
  }
  const evaluation = first.cases.find(value => value.kind === 'evaluation')!
  expect(evaluation.expectedStdout).toContain('unknown={{missing}}')
  expect(evaluation.expectedStdout).toMatch(/literal=\{\{release\}\}-[a-f0-9]+/u)
})

test('profiled certificates bind the exact second-family version and legacy v1 certificates still verify', () => {
  const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const dataset = generateProspectiveDataset('template-render/v1'), pin = prospectiveGeneratorDigest('template-render/v1')
  const certificate = createProspectiveCertificate(binding, dataset, keys.privateKey, '123e4567-e89b-42d3-a456-426614174000')
  expect(certificate).toMatchObject({ profileVersion: 'template-render/v1', profileDigest: pin, generatorDigest: pin })
  expect(verifyProspectiveCertificate(certificate, binding, publicKey, pin)).toBe(true)
  expect(verifyProspectiveCertificate({ ...certificate, profileVersion: 'order-summary/v2' }, binding, publicKey, pin)).toBe(false)
  expect(() => HoldoutAuthority.create({ dataset, privateKey: keys.privateKey, limits: { maxToolCalls: 4, maxOutputBytes: 4096 }, prospective: { ...certificate, profileDigest: generatorDigest }, now: () => 1 })).toThrow(/profile does not match/)

  const legacyDataset = generateProspectiveDataset('order-summary/v1')
  const legacyUnsigned = { protocol: 'assistant-skills/prospective-holdout/v1', freezeId: '123e4567-e89b-42d3-a456-426614174001', binding, generatorDigest, datasetDigest: prospectiveDatasetDigest(legacyDataset), publicKey, frozenSequence: 1, generatedSequence: 2 }
  const legacy = { ...legacyUnsigned, signature: sign(null, Buffer.from(canonical(legacyUnsigned)), keys.privateKey).toString('base64url') }
  expect(verifyProspectiveCertificate(legacy, binding, publicKey, generatorDigest)).toBe(true)
  expect(HoldoutAuthority.create({ dataset: legacyDataset, privateKey: keys.privateKey, limits: { maxToolCalls: 4, maxOutputBytes: 4096 }, prospective: legacy as any, now: () => 1 }).begin(binding).prospective).toEqual(legacy)
})

test('admission digest is signed into the prospective certificate, begin plan, and receipt', () => {
  const keys = generateKeyPairSync('ed25519'), dataset = generateProspectiveDataset('template-render/v1'), admitted = { ...binding, admissionDigest: hex('f') }
  const certificate = createProspectiveCertificate(admitted, dataset, keys.privateKey, '123e4567-e89b-42d3-a456-426614174003')
  const pin = prospectiveGeneratorDigest('template-render/v1'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  expect(certificate.binding.admissionDigest).toBe(admitted.admissionDigest)
  expect(verifyProspectiveCertificate(certificate, admitted, publicKey, pin)).toBe(true)
  expect(verifyProspectiveCertificate(certificate, { ...admitted, admissionDigest: hex('e') }, publicKey, pin)).toBe(false)
  expect(verifyProspectiveCertificate({ ...certificate, binding: { ...admitted, admissionDigest: hex('e') } }, admitted, publicKey, pin)).toBe(false)
  const authority = HoldoutAuthority.create({ dataset, privateKey: keys.privateKey, limits: { maxToolCalls: 4, maxOutputBytes: 4096 }, prospective: certificate, now: () => 1 })
  const begin = authority.begin(admitted)
  expect(begin.admissionDigest).toBe(admitted.admissionDigest)
  while (true) {
    const cell = authority.next(); if (!cell) break
    const expected = dataset.cases.find(sample => sample.stdin === cell.stdin)!.expectedStdout
    authority.record({ cellId: cell.cellId, armDigest: cell.armDigest, stdout: expected, exitCode: 0, quiescent: true, status: 'completed', artifactDigest: hex('e'), toolCalls: [] })
  }
  const receipt = authority.finish()
  expect(receipt.admissionDigest).toBe(admitted.admissionDigest)
  expect(verifyHoldoutSignature(receipt as unknown as Record<string, unknown>, publicKey)).toBe(true)
  expect(verifyHoldoutSignature({ ...receipt, admissionDigest: hex('e') } as unknown as Record<string, unknown>, publicKey)).toBe(false)
  expect(() => HoldoutAuthority.restore(authority.serialize(), { dataset, privateKey: keys.privateKey, limits: { maxToolCalls: 4, maxOutputBytes: 4096 }, prospective: certificate, now: () => 1 })).not.toThrow()
})

test('binding validation rejects malformed or extra admission data while legacy fixed bindings remain valid', () => {
  const keys = generateKeyPairSync('ed25519'), dataset = generateProspectiveDataset('template-render/v1')
  expect(() => HoldoutAuthority.create({ dataset, privateKey: keys.privateKey, limits: { maxToolCalls: 4, maxOutputBytes: 4096 }, now: () => 1 }).begin(binding)).not.toThrow()
  expect(() => HoldoutAuthority.create({ dataset, privateKey: keys.privateKey, limits: { maxToolCalls: 4, maxOutputBytes: 4096 }, now: () => 1 }).begin({ ...binding, admissionDigest: 'invalid' })).toThrow(/admissionDigest/)
  expect(() => createProspectiveCertificate({ ...binding, admissionDigest: hex('e'), unexpected: hex('f') } as any, dataset, keys.privateKey, '123e4567-e89b-42d3-a456-426614174004')).toThrow(/invalid frozen binding/)
})

test.each(['zero', 'negative'] as const)('%s second-family evaluation gain never creates promotion authority', outcome => {
  const keys = generateKeyPairSync('ed25519'), dataset = generateProspectiveDataset('template-render/v1')
  const certificate = createProspectiveCertificate(binding, dataset, keys.privateKey, '123e4567-e89b-42d3-a456-426614174002')
  const authority = HoldoutAuthority.create({ dataset, privateKey: keys.privateKey, limits: { maxToolCalls: 4, maxOutputBytes: 4096 }, prospective: certificate, now: () => 1 })
  authority.begin(binding)
  while (true) {
    const cell = authority.next(); if (!cell) break
    const expected = dataset.cases.find(sample => sample.stdin === cell.stdin)!.expectedStdout
    const stdout = outcome === 'negative' && cell.armDigest === binding.candidateDigest ? 'wrong' : expected
    authority.record({ cellId: cell.cellId, armDigest: cell.armDigest, stdout, exitCode: 0, quiescent: true, status: 'completed', artifactDigest: hex('e'), toolCalls: [] })
  }
  const receipt = authority.finish(), evaluation = (arm: string) => receipt.cellVerdicts.filter(cell => cell.kind === 'evaluation' && cell.armDigest === arm && cell.verdict === 'achieved').length
  expect(evaluation(binding.candidateDigest) - evaluation(binding.baselineDigest)).toBe(outcome === 'zero' ? 0 : -binding.repeats)
  expect(receipt).not.toHaveProperty('promotionAuthorized')
})
