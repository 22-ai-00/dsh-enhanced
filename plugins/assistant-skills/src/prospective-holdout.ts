import { createHash, createPrivateKey, createPublicKey, KeyObject, randomBytes, randomInt, sign, verify } from 'node:crypto'
import type { HoldoutCase, HoldoutDataset, QualificationBinding } from './holdout-authority.js'

const digestPattern = /^[a-f0-9]{64}$/u
const protocol = 'assistant-skills/prospective-holdout/v1' as const
const generatorName = 'order-summary/v1' as const

export const generatorDigest = createHash('sha256').update('assistant-skills/prospective-holdout/order-summary/v1: stdin JSON array of orders; cancelled orders excluded; integer cents summed by currency; sorted JSON object plus newline; CSPRNG cases; replay/evaluation/regression').digest('hex')

export interface ProspectiveHoldoutCertificate {
  readonly protocol: typeof protocol
  readonly freezeId: string
  readonly binding: QualificationBinding
  readonly generatorDigest: string
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
  return exact(value, ['scopeDigest', 'baselineDigest', 'candidateDigest', 'budgetDigest', 'expiresAt', 'repeats'])
    && [value.scopeDigest, value.baselineDigest, value.candidateDigest, value.budgetDigest].every(item => typeof item === 'string' && digestPattern.test(item))
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

/** Creates private random cases after an immutable qualification binding has been frozen. */
export function generateProspectiveDataset(): HoldoutDataset {
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
  const unsigned = { protocol, freezeId, binding, generatorDigest, datasetDigest: prospectiveDatasetDigest(dataset), publicKey: createPublicKey(key).export({ format: 'pem', type: 'spki' }).toString(), frozenSequence: 1 as const, generatedSequence: 2 as const }
  return Object.freeze({ ...unsigned, signature: sign(null, Buffer.from(canonical(unsigned)), key).toString('base64url') })
}

/** Strictly checks a prospective certificate and its binding to the pinned authority key. */
export function verifyProspectiveCertificate(value: unknown, expectedBinding: QualificationBinding, pinnedKey: string, expectedGeneratorDigest: string): value is ProspectiveHoldoutCertificate {
  if (!exact(value, ['protocol', 'freezeId', 'binding', 'generatorDigest', 'datasetDigest', 'publicKey', 'frozenSequence', 'generatedSequence', 'signature']) || !validBinding(expectedBinding)
    || value.protocol !== protocol || typeof value.freezeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.freezeId)
    || !validBinding(value.binding) || !same(value.binding, expectedBinding) || value.generatorDigest !== expectedGeneratorDigest || value.generatorDigest !== generatorDigest
    || typeof value.datasetDigest !== 'string' || !digestPattern.test(value.datasetDigest) || value.publicKey !== pinnedKey || value.frozenSequence !== 1 || value.generatedSequence !== 2 || typeof value.signature !== 'string' || value.signature.length < 32 || value.signature.length > 512) return false
  try {
    if (createPublicKey(pinnedKey).asymmetricKeyType !== 'ed25519') return false
    const { signature: signatureValue, ...unsigned } = value
    return verify(null, Buffer.from(canonical(unsigned)), pinnedKey, Buffer.from(signatureValue, 'base64url'))
  } catch { return false }
}
