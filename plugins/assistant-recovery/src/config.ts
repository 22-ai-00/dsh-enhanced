import { isAbsolute, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { RECOVERY_CATALOG_DIGEST } from './catalog.js'

export type RecoveryActivationState = 'active' | 'paused' | 'preview'

export interface RecoveryJobConfig {
  id: string
  activationState?: RecoveryActivationState
  activationNonce: string
  catalogDigest: string
  workspace: string
  preset: string
  principal: string
  ownerRouteId: string
  cron: string
  timezone: string
  budgetId?: string
  budgetAmount?: number
}

export interface Config {
  databasePath: string
  jobs?: RecoveryJobConfig[]
  maxStepDurationMs?: number
}

export interface NormalizedRecoveryJob extends Required<Omit<RecoveryJobConfig, 'budgetId' | 'budgetAmount'>> {
  budgetId?: string
  budgetAmount?: number
}

export interface NormalizedConfig {
  databasePath: string
  jobs: readonly NormalizedRecoveryJob[]
  maxStepDurationMs: number
}

const recoveryJobSchema = Schema.object({
  id: Schema.string().required(),
  activationState: Schema.union(['active', 'paused', 'preview'] as const).default('paused'),
  activationNonce: Schema.string().required(),
  catalogDigest: Schema.string().required(),
  workspace: Schema.string().required(),
  preset: Schema.string().required(),
  principal: Schema.string().required(),
  ownerRouteId: Schema.string().required(),
  cron: Schema.string().required(),
  timezone: Schema.string().required(),
  budgetId: Schema.string(),
  budgetAmount: Schema.number().step(1).min(1).max(10_000_000),
})

export const ConfigSchema = Schema.object({
  databasePath: Schema.string().required(),
  jobs: Schema.array(recoveryJobSchema).default([]),
  maxStepDurationMs: Schema.number().step(1).min(100).max(60_000).default(10_000),
}) as Schema<Config>

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0)!
    return point <= 0x1f || point === 0x7f
  })
}

function text(value: string, field: string, maximumBytes: number): string {
  const normalized = value.normalize('NFC').trim()
  if (normalized === '' || Buffer.byteLength(normalized, 'utf8') > maximumBytes || hasControlCharacter(normalized)) {
    throw new Error(`assistant-recovery: ${field} must contain bounded printable text`)
  }
  return normalized
}

function normalizeJob(value: RecoveryJobConfig, index: number): NormalizedRecoveryJob {
  const parsed = recoveryJobSchema(value) as Required<Omit<RecoveryJobConfig, 'budgetId' | 'budgetAmount'>> & {
    budgetId?: string
    budgetAmount?: number
  }
  const workspaceInput = text(parsed.workspace, `jobs[${index}].workspace`, 4_096)
  if (!isAbsolute(workspaceInput)) throw new Error(`assistant-recovery: jobs[${index}].workspace must be absolute`)
  const workspace = resolve(workspaceInput)
  const catalogDigest = text(parsed.catalogDigest, `jobs[${index}].catalogDigest`, 64).toLowerCase()
  if (catalogDigest !== RECOVERY_CATALOG_DIGEST) {
    throw new Error(`assistant-recovery: jobs[${index}].catalogDigest does not match the compiled runbook`)
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: parsed.timezone }).format(0)
  } catch {
    throw new Error(`assistant-recovery: jobs[${index}].timezone is not a valid IANA timezone`)
  }
  if ((parsed.budgetId === undefined) !== (parsed.budgetAmount === undefined)) {
    throw new Error(`assistant-recovery: jobs[${index}] budgetId and budgetAmount must be supplied together`)
  }
  return Object.freeze({
    ...parsed,
    id: text(parsed.id, `jobs[${index}].id`, 200),
    activationNonce: text(parsed.activationNonce, `jobs[${index}].activationNonce`, 200),
    catalogDigest,
    workspace,
    preset: text(parsed.preset, `jobs[${index}].preset`, 200),
    principal: text(parsed.principal, `jobs[${index}].principal`, 500),
    ownerRouteId: text(parsed.ownerRouteId, `jobs[${index}].ownerRouteId`, 200),
    cron: text(parsed.cron, `jobs[${index}].cron`, 200),
    timezone: text(parsed.timezone, `jobs[${index}].timezone`, 200),
    ...(parsed.budgetId === undefined ? {} : {
      budgetId: text(parsed.budgetId, `jobs[${index}].budgetId`, 200),
      budgetAmount: parsed.budgetAmount,
    }),
  })
}

export function normalizeRecoveryConfig(input: Config): NormalizedConfig {
  let parsed: Required<Config>
  try {
    parsed = ConfigSchema(input) as Required<Config>
  } catch (error) {
    throw new Error(`assistant-recovery: invalid configuration: ${String(error)}`, { cause: error })
  }
  const databasePathInput = text(parsed.databasePath, 'databasePath', 4_096)
  if (!isAbsolute(databasePathInput)) throw new Error('assistant-recovery: databasePath must be absolute')
  const databasePath = resolve(databasePathInput)
  if (parsed.jobs.length > 100) throw new Error('assistant-recovery: at most 100 jobs are allowed')
  const jobs = parsed.jobs.map(normalizeJob)
  if (new Set(jobs.map(job => job.id)).size !== jobs.length) {
    throw new Error('assistant-recovery: job ids must be unique')
  }
  if (new Set(jobs.map(job => job.activationNonce)).size !== jobs.length) {
    throw new Error('assistant-recovery: activation nonces must be unique')
  }
  for (const [index, job] of jobs.entries()) {
    if (job.activationState !== 'paused' && job.budgetId === undefined) {
      throw new Error(`assistant-recovery: jobs[${index}] preview/active recovery requires a budget tuple`)
    }
  }
  return Object.freeze({ databasePath, jobs: Object.freeze(jobs), maxStepDurationMs: parsed.maxStepDurationMs })
}

export const Config = ConfigSchema
