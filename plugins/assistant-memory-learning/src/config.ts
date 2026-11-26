import Schema from '@deepseek-ai/schemastery'
import { isAbsolute, resolve } from 'node:path'
import { validateMemoryLearningOwner } from '@dsh-ray/assistant-growth-contract'
import type { LearningConfig, LearningModel, LearningServiceConfig, ParsedLearningServiceConfig } from './types.js'

export const DEFAULT_LEARNING_OPERATIONAL_CONFIG = Object.freeze({
  maxExtractions: 1000,
  maxPending: 64,
  lookbackMs: 7 * 86_400_000,
  policy: 'Extract only explicit owner facts, preferences or grounded work-item experiences. Prefer noop when evidence is insufficient.',
  maxInputBytes: 65_536,
  maxOutputTokens: 2048,
  timeoutMs: 60_000,
  budgetAmount: 1,
  scanBudgetAmount: 1,
  workItemExperiences: true as const,
})

const REQUIRED_LEARNING_BINDING_KEYS = [
  'databasePath',
  'authorityId',
  'owner',
  'expiresAt',
  'budgetId',
  'scanBudgetId',
  'reviewAuthorityId',
  'reviewAuthorityDigest',
  'adoptionAuthorityId',
  'adoptionGrantDigest',
] as const

const OPERATIONAL_LEARNING_KEYS = [
  'maxExtractions',
  'maxPending',
  'lookbackMs',
  'policy',
  'maxInputBytes',
  'maxOutputTokens',
  'timeoutMs',
  'budgetAmount',
  'scanBudgetAmount',
] as const

const DORMANT_SERVICE_KEYS = new Set(['enabled', 'workItemExperiences', 'configured'])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && !Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !field.enumerable || !('value' in field))
}

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isPlainRecord(value)
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))
    || required.some(key => !Object.hasOwn(value, key))) throw new Error('Invalid memory learning configuration fields')
  return value
}
function id(value: unknown): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)) throw new Error('Invalid memory learning identity')
}
function bound(value: unknown, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error('Invalid memory learning bound')
}
function text(value: unknown, max: number): void {
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed() || value.includes('\0') || Buffer.byteLength(value) > max) throw new Error('Invalid memory learning text')
}
export function validateLearningModel(value: unknown): LearningModel {
  const model = exact(value, ['provider', 'model'], ['reasoningEffort'])
  id(model.provider); text(model.model, 256)
  if (Object.hasOwn(model, 'reasoningEffort')) id(model.reasoningEffort)
  return structuredClone(model) as unknown as LearningModel
}
export function validateLearningConfig(value: unknown): LearningConfig {
  const input = exact(value, REQUIRED_LEARNING_BINDING_KEYS, [...OPERATIONAL_LEARNING_KEYS, 'model', 'workItemExperiences', 'enabled'])
  if (Object.hasOwn(input, 'enabled') && input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new Error('Invalid memory learning enabled flag')
  }
  if (Object.hasOwn(input, 'workItemExperiences') && input.workItemExperiences !== undefined && typeof input.workItemExperiences !== 'boolean') {
    throw new Error('Invalid workItemExperiences flag')
  }
  const normalized = structuredClone(input)
  delete normalized.enabled
  if (Object.hasOwn(normalized, 'model') && normalized.model === undefined) delete normalized.model
  for (const key of OPERATIONAL_LEARNING_KEYS) {
    if (!Object.hasOwn(normalized, key) || normalized[key] === undefined) {
      normalized[key] = DEFAULT_LEARNING_OPERATIONAL_CONFIG[key]
    }
  }
  normalized.workItemExperiences = (normalized.workItemExperiences as boolean | undefined) ?? DEFAULT_LEARNING_OPERATIONAL_CONFIG.workItemExperiences
  id(normalized.authorityId); id(normalized.budgetId); id(normalized.scanBudgetId); id(normalized.reviewAuthorityId); id(normalized.adoptionAuthorityId)
  for (const key of ['reviewAuthorityDigest', 'adoptionGrantDigest']) if (typeof normalized[key] !== 'string' || !/^[a-f0-9]{64}$/u.test(normalized[key] as string)) throw new Error('Invalid memory learning grant digest')
  text(normalized.databasePath, 4096)
  if (!isAbsolute(normalized.databasePath as string) || resolve(normalized.databasePath as string) !== normalized.databasePath || normalized.databasePath === '/') throw new Error('Invalid memory learning database path')
  validateMemoryLearningOwner(normalized.owner)
  bound(normalized.expiresAt, 1, Number.MAX_SAFE_INTEGER); bound(normalized.maxExtractions, 1, 10_000); bound(normalized.maxPending, 1, 1000)
  bound(normalized.lookbackMs, 1000, 365 * 86_400_000); bound(normalized.maxInputBytes, 4096, 131_072)
  bound(normalized.maxOutputTokens, 1, 8192); bound(normalized.timeoutMs, 1000, 300_000)
  for (const key of ['budgetAmount', 'scanBudgetAmount']) bound(normalized[key], 1, 10_000_000)
  text(normalized.policy, 8192)
  if (Object.hasOwn(normalized, 'model')) validateLearningModel(normalized.model)
  return normalized as unknown as LearningConfig
}
export function parseLearningServiceConfig(value: unknown): ParsedLearningServiceConfig {
  if (value === undefined) {
    return { enabled: true, configured: false, workItemExperiences: true }
  }
  if (isPlainRecord(value)) {
    const keys = Reflect.ownKeys(value)
    if (keys.every(key => typeof key === 'string' && DORMANT_SERVICE_KEYS.has(key)) && value.configured !== true) {
      if (Object.hasOwn(value, 'configured') && value.configured !== false && value.configured !== undefined) {
        throw new Error('Invalid memory learning configuration fields')
      }
      if (Object.hasOwn(value, 'enabled') && value.enabled !== undefined && typeof value.enabled !== 'boolean') {
        throw new Error('Invalid memory learning enabled flag')
      }
      if (Object.hasOwn(value, 'workItemExperiences') && value.workItemExperiences !== undefined && typeof value.workItemExperiences !== 'boolean') {
        throw new Error('Invalid workItemExperiences flag')
      }
      return {
        enabled: (value.enabled as boolean | undefined) ?? true,
        configured: false,
        workItemExperiences: (value.workItemExperiences as boolean | undefined) ?? true,
      }
    }
  }
  const learning = validateLearningConfig(value)
  if (isPlainRecord(value) && value.enabled === false) {
    return { ...learning, enabled: false }
  }
  return learning
}
export const Config: Schema<LearningServiceConfig, ParsedLearningServiceConfig> = Schema.transform(Schema.any(), (value, options) => {
  try { return parseLearningServiceConfig(value) }
  catch (error) { throw new Schema.ValidationError(String(error), options ?? { path: [] }) }
}).default({ enabled: true, configured: false, workItemExperiences: true }) as Schema<LearningServiceConfig, ParsedLearningServiceConfig>
