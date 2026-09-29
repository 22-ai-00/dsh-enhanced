import Schema from '@deepseek-ai/schemastery'
import { isAbsolute, resolve } from 'node:path'
import { validateMemoryLearningOwner } from '@dsh-enhanced/assistant-growth-contract'
import type { LearningConfig, LearningModel } from './types.js'

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))
    || required.some(key => !Object.hasOwn(value, key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !field.enumerable || !('value' in field))) throw new Error('Invalid memory learning configuration fields')
  return value as Record<string, unknown>
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
  const input = exact(value, ['databasePath', 'authorityId', 'owner', 'expiresAt', 'maxExtractions', 'maxPending', 'lookbackMs',
    'policy', 'maxInputBytes', 'maxOutputTokens', 'timeoutMs', 'budgetId', 'budgetAmount', 'scanBudgetId', 'scanBudgetAmount',
    'reviewAuthorityId', 'reviewAuthorityDigest', 'adoptionAuthorityId', 'adoptionGrantDigest'], ['model'])
  id(input.authorityId); id(input.budgetId); id(input.scanBudgetId); id(input.reviewAuthorityId); id(input.adoptionAuthorityId)
  for (const key of ['reviewAuthorityDigest', 'adoptionGrantDigest']) if (typeof input[key] !== 'string' || !/^[a-f0-9]{64}$/u.test(input[key] as string)) throw new Error('Invalid memory learning grant digest')
  text(input.databasePath, 4096)
  if (!isAbsolute(input.databasePath as string) || resolve(input.databasePath as string) !== input.databasePath || input.databasePath === '/') throw new Error('Invalid memory learning database path')
  validateMemoryLearningOwner(input.owner)
  bound(input.expiresAt, 1, Number.MAX_SAFE_INTEGER); bound(input.maxExtractions, 1, 10_000); bound(input.maxPending, 1, 1000)
  bound(input.lookbackMs, 1000, 365 * 86_400_000); bound(input.maxInputBytes, 4096, 131_072)
  bound(input.maxOutputTokens, 1, 8192); bound(input.timeoutMs, 1000, 300_000)
  for (const key of ['budgetAmount', 'scanBudgetAmount']) bound(input[key], 1, 10_000_000)
  text(input.policy, 8192)
  if (Object.hasOwn(input, 'model')) validateLearningModel(input.model)
  return structuredClone(input) as unknown as LearningConfig
}
export const Config: Schema<LearningConfig> = Schema.transform(Schema.any(), (value, options) => {
  try { return validateLearningConfig(value) }
  catch (error) { throw new Schema.ValidationError(String(error), options ?? { path: [] }) }
}) as Schema<LearningConfig>
