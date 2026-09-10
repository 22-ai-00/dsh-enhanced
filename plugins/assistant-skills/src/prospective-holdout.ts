import { createHash, createPrivateKey, createPublicKey, KeyObject, randomBytes, randomInt, sign, verify } from 'node:crypto'
import type { HoldoutCase, HoldoutDataset, QualificationBinding } from './holdout-authority.js'

const digestPattern = /^[a-f0-9]{64}$/u
const protocol = 'assistant-skills/prospective-holdout/v1' as const
export type ProspectiveGeneratorName = 'order-summary/v1' | 'order-summary/v2' | 'template-render/v1'
const generatorName = 'order-summary/v1' as const

export const generatorDigest = createHash('sha256').update('assistant-skills/prospective-holdout/order-summary/v1: stdin JSON array of orders; cancelled orders excluded; integer cents summed by currency; sorted JSON object plus newline; CSPRNG cases; replay/evaluation/regression').digest('hex')
const generatorV2Digest = createHash('sha256').update('assistant-skills/prospective-holdout/order-summary/v2: stdin JSON array of orders; cancelled orders excluded; integer amountCents summed by currency including negative values; sorted JSON object plus newline; explicit empty case and randomized negative evaluation with cancellation and accumulation; CSPRNG cases; replay/evaluation/regression').digest('hex')
const templateRenderV1Digest = createHash('sha256').update('assistant-skills/prospective-holdout/template-render/v1: stdin JSON object with template string and string values object; replace known {{ascii_key}} placeholders literally in one non-recursive pass; preserve unknown placeholders; append newline; CSPRNG cases; replay/evaluation/regression').digest('hex')
export function prospectiveGeneratorDigest(name: ProspectiveGeneratorName): string {
  if (name === 'order-summary/v1') return generatorDigest
  if (name === 'order-summary/v2') return generatorV2Digest
  if (name === 'template-render/v1') return templateRenderV1Digest
  throw new Error('prospective-holdout: unsupported generator')
}
export function prospectiveGeneratorProfile(name: ProspectiveGeneratorName): Readonly<{ version: ProspectiveGeneratorName; digest: string }> {
  return Object.freeze({ version: name, digest: prospectiveGeneratorDigest(name) })
}

export interface ProspectiveHoldoutCertificate {
  readonly protocol: typeof protocol
  readonly freezeId: string
  readonly binding: QualificationBinding
  readonly generatorDigest: string
  /** Added after v1/v2 shipped; omitted only by certificates restored from those legacy versions. */
  readonly profileVersion?: ProspectiveGeneratorName
  /** Equal to the digest of the exact profileVersion semantics. */
  readonly profileDigest?: string
  readonly datasetDigest: string
  readonly publicKey: string
  readonly frozenSequence: 1
  readonly generatedSequence: 2
  readonly signature: string
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}
export function prospectiveDatasetDigest(dataset: HoldoutDataset): string { return createHash('sha256').update(canonical(dataset)).digest('hex') }
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0 && Object.values(Object.getOwnPropertyDescriptors(value)).every(item => item.enumerable && 'value' in item) }
function exact(value: unknown, required: readonly string[]): value is Record<string, unknown> { return plain(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).length === required.length && Object.keys(value).every(key => required.includes(key)) }
function validBinding(value: unknown): value is QualificationBinding {
  const required = ['scopeDigest', 'baselineDigest', 'candidateDigest', 'budgetDigest', 'expiresAt', 'repeats']
  return (exact(value, required) || exact(value, [...required, 'admissionDigest']))
    && [value.scopeDigest, value.baselineDigest, value.candidateDigest, value.budgetDigest].every(item => typeof item === 'string' && digestPattern.test(item))
    && (value.admissionDigest === undefined || typeof value.admissionDigest === 'string' && digestPattern.test(value.admissionDigest))
    && typeof value.expiresAt === 'number' && Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0
    && typeof value.repeats === 'number' && Number.isInteger(value.repeats) && value.repeats >= 2 && value.repeats <= 4
}
function same(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right) }
function currency(): string { return ['AUD', 'CAD', 'EUR', 'GBP', 'JPY', 'USD'][randomInt(6)]! }
function order(index: number): Record<string, unknown> {
  const states = ['paid', 'paid', 'pending', 'cancelled']
  return { id: `o-${index}-${randomBytes(4).toString('hex')}`, currency: currency(), cents: randomInt(0, 250_001), status: states[randomInt(states.length)] }
}
function expected(orders: readonly Record<string, unknown>[]): string {
  const totals: Record<string, number> = {}
  for (const item of orders) if (item.status !== 'cancelled') totals[item.currency as string] = (totals[item.currency as string] ?? 0) + (item.cents as number)
  return JSON.stringify(Object.fromEntries(Object.entries(totals).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))) + '\n'
}
function v2order(index: number): Record<string, unknown> {
  const states = ['paid', 'paid', 'pending', 'cancelled']
  return { id: `v2-${index}-${randomBytes(4).toString('hex')}`, currency: currency(), amountCents: randomInt(-250_000, 250_001), status: states[randomInt(states.length)] }
}
function v2expected(orders: readonly Record<string, unknown>[]): string {
  const totals: Record<string, number> = {}
  for (const item of orders) if (item.status !== 'cancelled') totals[item.currency as string] = (totals[item.currency as string] ?? 0) + (item.amountCents as number)
  return JSON.stringify(Object.fromEntries(Object.entries(totals).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))) + '\n'
}
function templateInput(kind: HoldoutCase['kind']): { template: string; values: Record<string, string> } {
  const token = randomBytes(8).toString('hex'), secondary = randomBytes(6).toString('hex')
  if (kind === 'replay') return { template: `plain-${token}: no substitutions`, values: { unused: secondary } }
  if (kind === 'evaluation') return {
    template: `release={{release}};again={{release}};unknown={{missing}};literal={{literal}}`,
    values: { release: `r-${token}`, literal: `{{release}}-${secondary}` },
  }
  return {
    template: `owner={{owner}}\npath=/private/{{path}}/{{owner}}\nunresolved={{later_key}}`,
    values: { owner: `team-${token}`, path: `build_${secondary}` },
  }
}
function templateExpected(input: { template: string; values: Readonly<Record<string, string>> }): string {
  return input.template.replace(/\{\{([a-z][a-z0-9_]*)\}\}/gu, (placeholder, key: string) => Object.hasOwn(input.values, key) ? input.values[key]! : placeholder) + '\n'
}

/** Creates private random cases after an immutable qualification binding has been frozen. */
export function generateProspectiveDataset(name: ProspectiveGeneratorName = generatorName): HoldoutDataset {
  if (name === 'template-render/v1') {
    const kinds: HoldoutCase['kind'][] = ['replay', 'evaluation', 'regression']
    const cases = kinds.map(kind => {
      const input = templateInput(kind)
      return Object.freeze({ id: `${kind}-${randomBytes(8).toString('hex')}`, kind, stdin: JSON.stringify(input) + '\n', expectedStdout: templateExpected(input), expectedExitCode: 0 })
    })
    return Object.freeze({ id: `prospective-template-render-${randomBytes(12).toString('hex')}`, version: name, cases: Object.freeze(cases) })
  }
  if (name === 'order-summary/v2') {
    const negativeCurrency = currency(), magnitude = randomInt(2, 250_001)
    const evaluationOrders = [
      { id: randomBytes(8).toString('hex'), currency: negativeCurrency, amountCents: -magnitude, status: 'paid' },
      { id: randomBytes(8).toString('hex'), currency: negativeCurrency, amountCents: randomInt(1, magnitude), status: 'pending' },
      { id: randomBytes(8).toString('hex'), currency: negativeCurrency, amountCents: randomInt(1, 250_001), status: 'cancelled' },
      { id: randomBytes(8).toString('hex'), currency: currency(), amountCents: -randomInt(1, 250_001), status: 'paid' },
    ]
    const cases: HoldoutCase[] = [
      { id: `replay-empty-${randomBytes(8).toString('hex')}`, kind: 'replay', stdin: '[]\n', expectedStdout: '{}\n', expectedExitCode: 0 },
      { id: `evaluation-negative-${randomBytes(8).toString('hex')}`, kind: 'evaluation', stdin: JSON.stringify(evaluationOrders) + '\n', expectedStdout: v2expected(evaluationOrders), expectedExitCode: 0 },
      (() => { const orders = Array.from({ length: 3 + randomInt(5) }, (_, index) => v2order(index)); return { id: `regression-${randomBytes(8).toString('hex')}`, kind: 'regression' as const, stdin: JSON.stringify(orders) + '\n', expectedStdout: v2expected(orders), expectedExitCode: 0 } })(),
    ]
    return Object.freeze({ id: `prospective-order-summary-v2-${randomBytes(12).toString('hex')}`, version: name, cases: Object.freeze(cases) })
  }
  if (name !== 'order-summary/v1') throw new Error('prospective-holdout: unsupported generator')
  const kinds: HoldoutCase['kind'][] = ['replay', 'evaluation', 'regression']
  const cases = kinds.map((kind, index) => {
    const orders = Array.from({ length: 3 + randomInt(6) }, (_, item) => order(index * 16 + item))
    // Every dataset exercises exclusion, zero values, and same-currency accumulation without selecting against an arm.
    orders.push({ id: `edge-cancelled-${index}`, currency: 'USD', cents: 99999, status: 'cancelled' }, { id: `edge-zero-${index}`, currency: 'USD', cents: 0, status: 'paid' }, { id: `edge-sum-${index}`, currency: 'USD', cents: randomInt(1, 1000), status: 'paid' })
    return Object.freeze({ id: `${kind}-${randomBytes(8).toString('hex')}`, kind, stdin: JSON.stringify(orders) + '\n', expectedStdout: expected(orders), expectedExitCode: 0 })
  })
  return Object.freeze({ id: `prospective-order-summary-${randomBytes(12).toString('hex')}`, version: generatorName, cases: Object.freeze(cases) })
}

export function createProspectiveCertificate(binding: QualificationBinding, dataset: HoldoutDataset, privateKey: KeyObject | string | Buffer, freezeId: string): ProspectiveHoldoutCertificate {
  if (!validBinding(binding) || typeof freezeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(freezeId)) throw new Error('prospective-holdout: invalid frozen binding')
  const key = privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey)
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new Error('prospective-holdout: private key must be Ed25519')
  if (dataset.version !== 'order-summary/v1' && dataset.version !== 'order-summary/v2' && dataset.version !== 'template-render/v1') throw new Error('prospective-holdout: unsupported dataset generator')
  const name = dataset.version as ProspectiveGeneratorName
  const profile = prospectiveGeneratorProfile(name)
  const unsigned = { protocol, freezeId, binding, generatorDigest: profile.digest, profileVersion: profile.version, profileDigest: profile.digest, datasetDigest: prospectiveDatasetDigest(dataset), publicKey: createPublicKey(key).export({ format: 'pem', type: 'spki' }).toString(), frozenSequence: 1 as const, generatedSequence: 2 as const }
  return Object.freeze({ ...unsigned, signature: sign(null, Buffer.from(canonical(unsigned)), key).toString('base64url') })
}

/** Strictly checks a prospective certificate and its binding to the pinned authority key. */
export function verifyProspectiveCertificate(value: unknown, expectedBinding: QualificationBinding, pinnedKey: string, expectedGeneratorDigest: string): value is ProspectiveHoldoutCertificate {
  const legacy = exact(value, ['protocol', 'freezeId', 'binding', 'generatorDigest', 'datasetDigest', 'publicKey', 'frozenSequence', 'generatedSequence', 'signature'])
  const profiled = exact(value, ['protocol', 'freezeId', 'binding', 'generatorDigest', 'profileVersion', 'profileDigest', 'datasetDigest', 'publicKey', 'frozenSequence', 'generatedSequence', 'signature'])
  if ((!legacy && !profiled) || !validBinding(expectedBinding)
    || value.protocol !== protocol || typeof value.freezeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.freezeId)
    || !validBinding(value.binding) || !same(value.binding, expectedBinding) || typeof value.generatorDigest !== 'string' || value.generatorDigest !== expectedGeneratorDigest
    || typeof value.datasetDigest !== 'string' || !digestPattern.test(value.datasetDigest) || value.publicKey !== pinnedKey || value.frozenSequence !== 1 || value.generatedSequence !== 2 || typeof value.signature !== 'string' || value.signature.length < 32 || value.signature.length > 512) return false
  const certificate = value as Record<string, unknown>
  if (profiled) {
    if (!['order-summary/v1', 'order-summary/v2', 'template-render/v1'].includes(String(value.profileVersion))
      || value.profileDigest !== value.generatorDigest || prospectiveGeneratorDigest(value.profileVersion as ProspectiveGeneratorName) !== value.profileDigest) return false
  } else if (![generatorDigest, generatorV2Digest].includes(String(certificate.generatorDigest))) return false
  try {
    if (createPublicKey(pinnedKey).asymmetricKeyType !== 'ed25519') return false
    const { signature: signatureValue, ...unsigned } = value
    return verify(null, Buffer.from(canonical(unsigned)), pinnedKey, Buffer.from(signatureValue, 'base64url'))
  } catch { return false }
}
