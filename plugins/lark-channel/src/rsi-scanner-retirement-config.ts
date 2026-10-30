import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { growthObjectDigest, validateMemoryLearningOwner } from '@dsh-enhanced/assistant-growth-contract'
import type { MemoryLearningOwner } from '@dsh-enhanced/assistant-growth-contract'
import type { Config as AutomationsConfig } from '@dsh-enhanced/assistant-automations'
import type { Config as PolicyConfig } from '@dsh-enhanced/assistant-policy'
import type { OwnerRouteAuthority, RevokedOwnerRouteQuery } from '@dsh-enhanced/assistant-delivery'
import { externalPrincipalId, ownerRouteAuthorityHash } from '@dsh-enhanced/assistant-delivery'
import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml'
import type { Node, YAMLMap } from 'yaml'
import { getRsiMemoryLearningValidators } from './rsi-memory-learning.js'
import type { ScannerRetirementTarget } from './rsi-scanner-retirement-transition.js'

export interface ScannerRetirementConfigurationInput {
  readonly effectiveConfig: string
  readonly dshHome: string
  readonly profile: string
  readonly owner: MemoryLearningOwner
}
export interface ScannerRetirementConfiguration {
  readonly effectiveConfigDigest: string
  readonly ownerQuery: Readonly<RevokedOwnerRouteQuery>
  readonly automationsDatabasePath: string
  readonly policyConfig: Readonly<PolicyConfig>
  readonly automationsConfig: Readonly<AutomationsConfig>
  readonly targets: readonly ScannerRetirementTarget[]
}
export class ScannerRetirementConfigurationError extends Error {
  constructor() { super('scanner retirement configuration is unavailable'); this.name = 'ScannerRetirementConfigurationError' }
}
const requirePeer = createRequire(import.meta.url)
const modules = {
  personal: 'personal-assistant', delivery: 'assistant-delivery', lark: 'lark-channel',
  growth: 'assistant-growth-driver', control: 'plugin-control-plane', memory: 'assistant-memory-learning', verifier: 'assistant-verifier',
} as const
function fail(): never { throw new ScannerRetirementConfigurationError() }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value as Record<string, unknown>
}
function absolute(value: unknown): string {
  if (typeof value !== 'string' || value === '/' || !isAbsolute(value) || resolve(value) !== value
    || value.normalize('NFC') !== value || value.trim() !== value || /[\p{Cc}]/u.test(value)) fail()
  return value
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value)
  }
  return value
}
function homeExpression(value: unknown, home: string): string {
  if (typeof value !== 'string') return fail()
  const match = /^dshHomePath\((['"])([^'"\\]+)\1\)$/u.exec(value)
  if (!match || isAbsolute(match[2]!) || match[2]!.split('/').some(part => !part || part === '.' || part === '..')) fail()
  return absolute(join(home, match[2]!))
}
function plain(node: Node | null | undefined, home: string): unknown {
  if (node === null || node === undefined) return null
  if (isAlias(node)) return fail()
  if (isScalar(node)) {
    if (node.tag === 'tag:yaml.org,2002:js') return homeExpression(node.value, home)
    if (node.tag || !['string', 'number', 'boolean', 'object'].includes(typeof node.value)
      || typeof node.value === 'number' && !Number.isFinite(node.value)) return fail()
    return node.value
  }
  if (node.tag) return fail()
  if (isSeq(node)) return node.items.map(item => plain(item as Node | null, home))
  if (!isMap(node)) return fail()
  const result: Record<string, unknown> = {}
  for (const pair of node.items) {
    if (!isScalar(pair.key) || pair.key.tag || typeof pair.key.value !== 'string'
      || ['__proto__', 'constructor', 'prototype', '__jsExpr'].includes(pair.key.value)
      || Object.hasOwn(result, pair.key.value)) fail()
    result[pair.key.value] = plain(pair.value as Node | null, home)
  }
  return result
}
function rows(effective: string): Map<string, YAMLMap> {
  if (typeof effective !== 'string' || Buffer.byteLength(effective) > 8 * 1024 * 1024) return fail()
  const document = parseDocument(effective, { uniqueKeys: true })
  if (document.errors.length || !isSeq(document.contents)) return fail()
  const result = new Map<string, YAMLMap>()
  for (const row of document.contents.items) {
    if (!isMap(row)) return fail()
    const id: unknown = row.get('id')
    if (typeof id !== 'string' || id.normalize('NFC').trim() !== id || !id || result.has(id)) fail()
    result.set(id, row)
  }
  return result
}
function configured(entries: Map<string, YAMLMap>, name: string, home: string, required = false): Record<string, unknown> | undefined {
  const id = `dsh-enhanced-${name}`, packageName = `@dsh-enhanced/${name}`
  const candidates = [...entries.values()].filter(row => row.get('name') === packageName || row.get('id') === id)
  if (candidates.length === 0) { if (required) fail(); return undefined }
  if (candidates.length !== 1) return fail()
  const row = candidates[0]!
  const unconfiguredMemory = name === modules.memory && row.get('disabled') === true && !row.has('config')
  if (row.get('id') !== id || row.get('name') !== packageName
    || !unconfiguredMemory && row.get('disabled') !== undefined && row.get('disabled') !== false
    || row.items.some(pair => !isScalar(pair.key) || !['id', 'name', 'config', 'disabled', 'inject'].includes(String(pair.key.value)))) fail()
  // Array injection is the stock bundle dependency gate. Object injection,
  // isolate/intercept/filter/group or future metadata may change service realms.
  if (row.has('inject')) {
    const inject = plain(row.get('inject', true) as Node, home)
    if (!Array.isArray(inject) || inject.some(value => typeof value !== 'string' || !value)
      || new Set(inject).size !== inject.length) fail()
  }
  // The installed stock memory bundle has no frozen grant or scanner identity.
  // A disabled row WITH configuration cannot silently disappear from this proof.
  if (unconfiguredMemory) return undefined
  return object(plain(row.get('config', true) as Node, home))
}
function scope(value: unknown, owner: MemoryLearningOwner): void {
  if (!isDeepStrictEqual(object(value), { ownerRouteId: owner.authorityId, principalId: owner.principalId,
    workspace: owner.workspace, preset: owner.agentPreset })) fail()
}
function canonicalAuthority(value: unknown): OwnerRouteAuthority {
  const authority = object(value) as unknown as OwnerRouteAuthority
  const hash = ownerRouteAuthorityHash(authority)
  const ordered = { id: authority.id,
    conversation: { channel: authority.conversation.channel, account: authority.conversation.account, tenant: authority.conversation.tenant,
      kind: authority.conversation.kind, chat: authority.conversation.chat,
      ...(authority.conversation.thread === undefined ? {} : { thread: authority.conversation.thread }) },
    principal: { channel: authority.principal.channel, account: authority.principal.account, tenant: authority.principal.tenant, user: authority.principal.user },
    workspace: authority.workspace, agentPreset: authority.agentPreset, policyRef: authority.policyRef, minimumGeneration: authority.minimumGeneration }
  if (createHash('sha256').update(JSON.stringify(ordered)).digest('hex') !== hash) fail()
  return ordered
}
function checkDatabases(configs: readonly Record<string, unknown>[]): void {
  const seen = new Set<string>()
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (key === 'databasePath') {
        const path = absolute(child)
        if (seen.has(path)) fail()
        seen.add(path)
      } else visit(child)
    }
  }
  configs.forEach(visit)
}

/**
 * Pure derivation from the target profile's frozen, DSH-validated effective config.
 * Revalidates provider identity, realms, bound paths and every scanner owner scope.
 * It does not revalidate the entire Control Plane grant chain: its full normalizer
 * performs I/O and rejects some expired grants. Expiry cannot forbid permanent
 * retirement, and this function creates no grant or write/execution authority.
 * Optional peer validators/digests are resolved only for lanes actually present.
 * Service configs preserve all effective values; the parent must separately bind
 * this digest to its transaction and disable timers only in its temporary Context.
 */
export function deriveScannerRetirementConfiguration(input: ScannerRetirementConfigurationInput): ScannerRetirementConfiguration {
  try {
    if (Object.keys(input).sort().join(',') !== 'dshHome,effectiveConfig,owner,profile') fail()
    const home = absolute(input.dshHome)
    if (typeof input.profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.profile)) fail()
    const owner = validateMemoryLearningOwner(input.owner)
    if (!/^principal_[0-9a-f-]{8,}$/u.test(owner.principalRecordId)) fail()
    const entries = rows(input.effectiveConfig)
    // Only the existing embedded target-profile composition is supported.
    if ([...entries.values()].some(row => ['@dsh-enhanced/assistant-policy', '@dsh-enhanced/assistant-automations'].includes(String(row.get('name')))
      || ['dsh-enhanced-assistant-policy', 'dsh-enhanced-assistant-automations'].includes(String(row.get('id'))))) fail()
    const personal = configured(entries, modules.personal, home, true)!
    const delivery = configured(entries, modules.delivery, home, true)!
    const lark = configured(entries, modules.lark, home, true)!
    const growth = configured(entries, modules.growth, home)
    const control = configured(entries, modules.control, home)
    const memory = configured(entries, modules.memory, home)
    const verifier = configured(entries, modules.verifier, home)
    for (const candidate of [personal.personalMemory && object(personal.personalMemory).automaticLearning,
      verifier?.sourceReviews, verifier?.memoryReviews]) {
      if (candidate !== undefined && !isDeepStrictEqual(object(candidate).owner, owner)) fail()
    }
    const policyConfig = object(personal.assistantPolicy) as unknown as PolicyConfig
    const automationsConfig = object(personal.assistantAutomations) as unknown as AutomationsConfig
    absolute(policyConfig.databasePath); absolute(automationsConfig.databasePath); absolute(automationsConfig.runsPath)
    const databasePath = absolute(delivery.databasePath)
    if (!Array.isArray(delivery.ownerRoutes)) fail()
    const authorities = delivery.ownerRoutes.map(canonicalAuthority)
    if (new Set(authorities.map(route => route.id)).size !== authorities.length) fail()
    const matching = authorities.filter(route => route.id === owner.authorityId)
    if (matching.length !== 1) fail()
    const authority = matching[0]!
    if (authority.id !== owner.authorityId || ownerRouteAuthorityHash(authority) !== owner.authorityHash
      || externalPrincipalId(authority.principal) !== owner.principalId || authority.workspace !== owner.workspace
      || authority.agentPreset !== owner.agentPreset || authority.principal.channel !== 'lark'
      || authority.conversation.kind !== 'dm' || authority.conversation.thread !== undefined
      || absolute(delivery.defaultWorkspace) !== owner.workspace || delivery.defaultAgentPreset !== owner.agentPreset
      || delivery.policyRef !== undefined && delivery.policyRef !== authority.policyRef
      || lark.enabled !== true || lark.account !== authority.principal.account || lark.tenant !== authority.principal.tenant) fail()
    const targets: ScannerRetirementTarget[] = []
    if (growth) {
      // Growth's normalizer is structural only; no filesystem/time validation.
      const peer = requirePeer('@dsh-enhanced/assistant-growth-driver') as typeof import('@dsh-enhanced/assistant-growth-driver')
      const normalized = peer.normalizeConfig(growth)
      if (!normalized.enabled) fail()
      if (normalized.scope !== null) scope(normalized.scope, owner)
      if (normalized.usageLearning.enabled) {
        scope(normalized.scope, owner)
        // These scope objects contain only canonical strings, so the shared
        // canonical JSON equals acceptanceDigest; real runtime tests fence this.
        targets.push({ owner: 'assistant-growth-usage', automationId: `usage-scan-${growthObjectDigest(normalized.scope)}` })
      }
    }
    if (control) {
      if (control.adoptionCoordinator !== undefined) fail()
      const peer = requirePeer('@dsh-enhanced/plugin-control-plane') as typeof import('@dsh-enhanced/plugin-control-plane')
      if (control.sourceJobs !== undefined) {
        const jobs = object(control.sourceJobs)
        scope({ ownerRouteId: jobs.ownerRouteId, principalId: jobs.principalId, workspace: jobs.workspace, preset: jobs.preset }, owner)
      }
      if (control.runtimeObserver !== undefined && absolute(object(control.runtimeObserver).profilePath) !== join(home, 'profiles', input.profile)) fail()
      if (control.sourceAdoptions !== undefined && object(control.sourceAdoptions).profile !== input.profile) fail()
      for (const [key, scannerOwner, prefix] of [
        ['taskObservations', 'plugin-control-plane-task-observations', 'task-observation-scan-'],
        ['liveQualification', 'plugin-control-plane-live-qualification', 'live-qualification-scan-'],
      ] as const) if (control[key] !== undefined) {
        const scanner = object(control[key]); scope(scanner.scope, owner)
        const profilePath = absolute(scanner.profilePath)
        if (profilePath !== join(home, 'profiles', input.profile)) fail()
        targets.push({ owner: scannerOwner, automationId: `${prefix}${peer.controlPlaneDigest({ scope: scanner.scope, profilePath })}` })
      }
    }
    if (memory) {
      const validated = getRsiMemoryLearningValidators().validateLearningConfig(memory)
      if (!isDeepStrictEqual(validated.owner, owner)) fail()
      targets.push({ owner: 'assistant-memory-learning', automationId: `memory-scan-${growthObjectDigest([validated.authorityId, validated.owner])}` })
    }
    checkDatabases([personal, delivery, ...[growth, control, memory].filter((value): value is Record<string, unknown> => value !== undefined)])
    return freeze({ effectiveConfigDigest: createHash('sha256').update(input.effectiveConfig).digest('hex'),
      ownerQuery: { databasePath, authority, principalRecordId: owner.principalRecordId, frozenPrincipalVersion: owner.principalVersion },
      automationsDatabasePath: automationsConfig.databasePath, policyConfig, automationsConfig, targets })
  } catch { return fail() }
}
