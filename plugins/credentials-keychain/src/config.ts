import Schema from '@deepseek-ai/schemastery'
import { isAbsolute, normalize, win32 } from 'node:path'
import type { CredentialHandle } from './types.js'

export interface Config {
  databasePath: string
  handles: CredentialHandle[]
  defaultLeaseMs?: number
  maxSecretBytes?: number
  providerTimeoutMs?: number
}

const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,127}$/u
const envPattern = /^[A-Z_][A-Z0-9_]*$/u

function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('credentials-keychain: handle must be an object')
  }
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).find(field => !fields.includes(field))
  if (unknown !== undefined) throw new Error(`credentials-keychain: unknown handle field: ${unknown}`)
  return record
}

function key(value: unknown, field: string): string {
  if (typeof value !== 'string' || !keyPattern.test(value)) {
    throw new Error(`credentials-keychain: invalid ${field}`)
  }
  return value
}

function strings(value: unknown, field: 'consumer' | 'purpose'): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new Error(`credentials-keychain: ${field} allowlist must contain 1..32 values`)
  }
  const normalized = value.map(entry => key(entry, field))
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`credentials-keychain: duplicate ${field}`)
  }
  return normalized
}

function lease(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1_000 || (value as number) > 86_400_000) {
    throw new Error('credentials-keychain: maxLeaseMs must be an integer from 1000 to 86400000')
  }
  return value as number
}

function credentialPath(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1_024 || value.includes('\0')
    || (!isAbsolute(value) && !win32.isAbsolute(value))) {
    throw new Error('credentials-keychain: invalid path')
  }
  return value
}

function linuxCredentialPath(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1_024 || value.includes('\0')
    || !isAbsolute(value) || normalize(value) !== value) {
    throw new Error('credentials-keychain: invalid Linux protected file path')
  }
  return value
}

export function normalizeHandles(input: readonly CredentialHandle[]): CredentialHandle[] {
  if (!Array.isArray(input) || input.length > 256) throw new Error('credentials-keychain: handles must contain at most 256 values')
  const identifiers = new Set<string>()
  return input.map(raw => {
    const discriminator = exact(raw, [
      'account', 'consumers', 'environmentName', 'id', 'maxLeaseMs', 'path', 'provider', 'purposes', 'service',
    ])
    const id = key(discriminator.id, 'id')
    if (identifiers.has(id)) throw new Error(`credentials-keychain: duplicate handle id: ${id}`)
    identifiers.add(id)
    const common = {
      id,
      consumers: strings(discriminator.consumers, 'consumer'),
      purposes: strings(discriminator.purposes, 'purpose'),
      maxLeaseMs: lease(discriminator.maxLeaseMs),
    }
    if (discriminator.provider === 'environment') {
      const value = exact(raw, ['consumers', 'environmentName', 'id', 'maxLeaseMs', 'provider', 'purposes'])
      if (typeof value.environmentName !== 'string' || !envPattern.test(value.environmentName)) {
        throw new Error('credentials-keychain: invalid environmentName')
      }
      return { ...common, provider: 'environment', environmentName: value.environmentName }
    }
    if (discriminator.provider === 'macos-keychain' || discriminator.provider === 'linux-secret-service') {
      const value = exact(raw, ['account', 'consumers', 'id', 'maxLeaseMs', 'provider', 'purposes', 'service'])
      return { ...common, provider: discriminator.provider,
        service: key(value.service, 'service'), account: key(value.account, 'account') }
    }
    if (discriminator.provider === 'windows-dpapi') {
      const value = exact(raw, ['consumers', 'id', 'maxLeaseMs', 'path', 'provider', 'purposes'])
      return { ...common, provider: discriminator.provider, path: credentialPath(value.path) }
    }
    if (discriminator.provider === 'linux-protected-file') {
      const value = exact(raw, ['consumers', 'id', 'maxLeaseMs', 'path', 'provider', 'purposes'])
      return { ...common, provider: discriminator.provider, path: linuxCredentialPath(value.path) }
    }
    throw new Error('credentials-keychain: unsupported provider')
  })
}

const handleSchema = Schema.object({
  id: Schema.string().required(),
  provider: Schema.union([
    'environment', 'linux-protected-file', 'linux-secret-service', 'macos-keychain', 'windows-dpapi',
  ] as const).required(),
  environmentName: Schema.string(),
  service: Schema.string(),
  account: Schema.string(),
  path: Schema.string(),
  consumers: Schema.array(Schema.string()).required(),
  purposes: Schema.array(Schema.string()).required(),
  maxLeaseMs: Schema.number().required(),
})

const schema = Schema.object({
  databasePath: Schema.string().required(),
  handles: Schema.array(handleSchema).default([]),
  defaultLeaseMs: Schema.number().step(1).min(1_000).max(86_400_000).default(300_000),
  maxSecretBytes: Schema.number().step(1).min(1).max(1024 * 1024).default(65_536),
  providerTimeoutMs: Schema.number().step(1).min(100).max(60_000).default(5_000),
}) as Schema<Config>

const configFields = new Set(['databasePath', 'defaultLeaseMs', 'handles', 'maxSecretBytes', 'providerTimeoutMs'])

export const Config = new Proxy(schema, {
  apply(target, thisArg, argumentsList: [unknown]) {
    const input = argumentsList[0]
    if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
      const record = input as Record<string, unknown>
      const unknown = Object.keys(record).find(field => !configFields.has(field))
      if (unknown !== undefined) throw new Error(`credentials-keychain: unknown config field: ${unknown}`)
      if (record.handles !== undefined) normalizeHandles(record.handles as CredentialHandle[])
    }
    const parsed = Reflect.apply(target, thisArg, argumentsList) as Config
    return { ...parsed, handles: normalizeHandles(parsed.handles) }
  },
}) as Schema<Config>
