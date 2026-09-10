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
  expect(prospectiveGeneratorProfile('dependency-topological-order/v1')).toEqual({ version: 'dependency-topological-order/v1', digest: 'a17c8b3166e5e7c42f33cf54608504f7814bee67ba586839b09585cc8f83a752' })
  expect(() => prospectiveGeneratorDigest('dependency-topological-order/v2' as never)).toThrow(/unsupported generator/)
})

test('dependency topology privately generates bounded DAG, dynamic lexical-tie, and cycle cases', () => {
  const first = generateProspectiveDataset('dependency-topological-order/v1'), second = generateProspectiveDataset('dependency-topological-order/v1')
  expect(first.version).toBe('dependency-topological-order/v1')
  expect(first.cases.map(value => value.kind)).toEqual(['replay', 'evaluation', 'regression'])
  expect(prospectiveDatasetDigest(first)).not.toBe(prospectiveDatasetDigest(second))
  const solve = (stdin: string): { output: string; dynamicTie: boolean } => {
    const edgeKeys = new Set<string>(), nodes = new Set<string>()
    for (const line of stdin.split(/\r?\n/u)) {
      const fields = line.trim().split(/\s+/u)
      if (fields.length !== 2 || !fields.every(field => /^[a-z][a-z0-9]{1,31}$/u.test(field))) continue
      nodes.add(fields[0]!); nodes.add(fields[1]!); edgeKeys.add(`${fields[0]}\u0000${fields[1]}`)
    }
    const indegree = new Map([...nodes].map(node => [node, 0])), outgoing = new Map([...nodes].map(node => [node, [] as string[]]))
    for (const key of edgeKeys) { const [before, after] = key.split('\u0000') as [string, string]; outgoing.get(before)!.push(after); indegree.set(after, indegree.get(after)! + 1) }
    const ready = [...nodes].filter(node => indegree.get(node) === 0).sort(), result: string[] = []; let dynamicTie = false
    while (ready.length) {
      const node = ready.shift()!, priorMinimum = ready[0]; result.push(node)
      for (const after of outgoing.get(node)!) { const remaining = indegree.get(after)! - 1; indegree.set(after, remaining); if (remaining === 0) { if (priorMinimum !== undefined && after < priorMinimum) dynamicTie = true; ready.push(after) } }
      ready.sort()
    }
    return { output: result.length === nodes.size ? `${result.join('\n')}\n` : 'CYCLE\n', dynamicTie }
  }
  for (const sample of first.cases) {
    expect(Buffer.byteLength(sample.stdin)).toBeLessThan(2048)
    expect(sample.stdin.split('\n').length).toBeLessThanOrEqual(16)
    expect(sample.expectedStdout).toBe(solve(sample.stdin).output)
    const lines = sample.stdin.split(/\r?\n/u), output = sample.expectedStdout.trim().split('\n')
    expect(lines).toContain('x y')
    const digitLeading = lines.find(line => /^1[a-f0-9]+ n[a-f0-9]+$/u.test(line))!, rejectedBoundary = lines.find(line => /^n[a-f0-9]{32} n[a-f0-9]+$/u.test(line))!
    const acceptedBoundary = lines.flatMap(line => line.trim().split(/\s+/u)).find(label => /^n[a-f0-9]{31}$/u.test(label))!
    expect(digitLeading).toBeDefined(); expect(rejectedBoundary).toBeDefined(); expect(acceptedBoundary).toBeDefined()
    if (sample.kind !== 'regression') {
      expect(output).toContain(acceptedBoundary)
      expect(output).not.toContain('x'); expect(output).not.toContain('y')
      expect(output).not.toContain(digitLeading.split(' ')[0]); expect(output).not.toContain(rejectedBoundary.split(' ')[0])
    }
  }
  expect(solve(first.cases.find(value => value.kind === 'evaluation')!.stdin).dynamicTie).toBe(true)
  expect(first.cases.find(value => value.kind === 'regression')!.expectedStdout).toBe('CYCLE\n')
  for (const sample of first.cases.filter(value => value.kind !== 'regression')) {
    const output = sample.expectedStdout.trim().split('\n')
    expect(output).toHaveLength(new Set(output).size)
    expect(output).not.toEqual(['CYCLE'])
  }
})

test('dependency topology certificate and authority bind exact profile, dataset, and signed receipt', () => {
  const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const dataset = generateProspectiveDataset('dependency-topological-order/v1'), pin = prospectiveGeneratorDigest('dependency-topological-order/v1')
  const certificate = createProspectiveCertificate(binding, dataset, keys.privateKey, '123e4567-e89b-42d3-a456-426614174010')
  expect(certificate).toMatchObject({ profileVersion: dataset.version, profileDigest: pin, generatorDigest: pin, datasetDigest: prospectiveDatasetDigest(dataset) })
  expect(verifyProspectiveCertificate(certificate, binding, publicKey, pin)).toBe(true)
  const changed = { ...structuredClone(dataset), cases: dataset.cases.map((sample, index) => index === 0 ? { ...sample, stdin: `${sample.stdin}na nb\n` } : { ...sample }) }
  expect(() => HoldoutAuthority.create({ dataset: changed, privateKey: keys.privateKey, limits: { maxToolCalls: 4, maxOutputBytes: 4096 }, prospective: certificate, now: () => 1 })).toThrow(/dataset does not match/)
  const authority = HoldoutAuthority.create({ dataset, privateKey: keys.privateKey, limits: { maxToolCalls: 4, maxOutputBytes: 4096 }, prospective: certificate, now: () => 1 })
  authority.begin(binding)
  while (true) {
    const cell = authority.next(); if (!cell) break
    const expected = dataset.cases.find(sample => sample.stdin === cell.stdin)!.expectedStdout
    authority.record({ cellId: cell.cellId, armDigest: cell.armDigest, stdout: expected, exitCode: 0, quiescent: true, status: 'completed', artifactDigest: hex('e'), toolCalls: [] })
  }
  const receipt = authority.finish()
  expect(receipt.prospective).toEqual(certificate)
  expect(verifyHoldoutSignature(receipt as unknown as Record<string, unknown>, publicKey)).toBe(true)
  expect(verifyHoldoutSignature({ ...receipt, prospective: { ...certificate, datasetDigest: hex('f') } } as unknown as Record<string, unknown>, publicKey)).toBe(false)
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
