import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { inspectAutomationRetirementSnapshot } from '@dsh-enhanced/assistant-automations'
import { growthObjectDigest } from '@dsh-enhanced/assistant-growth-contract'
import type { LearningConfig } from '@dsh-enhanced/assistant-memory-learning'
import type { AutomationDefinition, AutomationRecord } from '@dsh-enhanced/assistant-automations'
import { externalPrincipalId, inspectRevokedOwnerRouteLocally } from '@dsh-enhanced/assistant-delivery'
import type { DeliveryPrincipal, OwnerRouteAuthority, RevokedOwnerRouteSnapshot } from '@dsh-enhanced/assistant-delivery'
import {
  ScannerRetirementTransitionError,
  prepareScannerRetirementOperations,
  scannerRetirementTransitionProtocol,
  verifyScannerRetirementTransition,
  type ScannerRetirementTarget,
  type ScannerRetirementTransitionInput,
} from '../src/rsi-scanner-retirement-transition.ts'

const roots: string[] = []
const now = Date.parse('2026-10-30T00:00:00.000Z')
const scannerTargets: readonly ScannerRetirementTarget[] = [
  { owner: 'assistant-memory-learning', automationId: `memory-scan-${'a'.repeat(64)}` },
  { owner: 'assistant-growth-usage', automationId: `usage-scan-${'b'.repeat(64)}` },
  { owner: 'plugin-control-plane-task-observations', automationId: `task-observation-scan-${'c'.repeat(64)}` },
  { owner: 'plugin-control-plane-live-qualification', automationId: `live-qualification-scan-${'d'.repeat(64)}` },
]
const authority: OwnerRouteAuthority = {
  id: 'rsi-owner', conversation: { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'oc_owner' },
  principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_owner' },
  workspace: '/work/owner', agentPreset: 'primary', policyRef: 'owner-dm', minimumGeneration: 1,
}
const require = createRequire(import.meta.url)
type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] : T extends object ? { -readonly [P in keyof T]: Mutable<T[P]> } : T

interface AutomationStoreFixture {
  reconcileSystemOwned(input: Record<string, unknown>): unknown
  createApproved(input: Record<string, unknown>): AutomationRecord
  retireSystemOwned(input: Record<string, unknown>): unknown
  inspectSystemOwnedRetirement(input: Record<string, unknown>): unknown
  inspectSystemOwned(input: Record<string, unknown>): unknown
  changeApproved(input: Record<string, unknown>): AutomationRecord
  get(id: string): AutomationRecord | undefined
  close(): void
}
interface DeliveryStoreFixture {
  issuePairing(principal: unknown, input: unknown): { challenge: { id: string }; code: string }
  confirmPairing(input: unknown): DeliveryPrincipal
  revokePrincipal(id: string, version: number): DeliveryPrincipal
  close(): void
}

async function stores() {
  // Use the package's built formal writers without adding a production subpath export.
  const automations = await import(pathToFileURL(join(dirname(require.resolve('@dsh-enhanced/assistant-automations/package.json')), 'lib/store.js')).href) as {
    AutomationStore: new (options: { path: string; now: () => number }) => AutomationStoreFixture
  }
  const delivery = await import(pathToFileURL(join(dirname(require.resolve('@dsh-enhanced/assistant-delivery/package.json')), 'lib/store.js')).href) as {
    DeliveryStore: new (options: { path: string; codeGenerator: () => string }) => DeliveryStoreFixture
  }
  return { ...automations, ...delivery }
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
}
function runtimeScope(proof: RevokedOwnerRouteSnapshot, owner: ScannerRetirementTarget['owner']) {
  return { authorityId: proof.authority.id, principalId: externalPrincipalId(proof.authority.principal),
    workspace: proof.authority.workspace, agentPreset: proof.authority.agentPreset,
    ...(owner === 'assistant-memory-learning' ? { expectedOwner: { authorityHash: proof.state.authorityHash,
      principalRecordId: proof.state.principalRecordId, principalVersion: proof.frozenPrincipalVersion } } : {}) }
}
function evidence(proof: RevokedOwnerRouteSnapshot, owner: ScannerRetirementTarget['owner'] = 'assistant-growth-usage') {
  return hash({ protocol: 'scanner-owner-revoked/v1', scope: runtimeScope(proof, owner),
    state: { status: 'revoked', authorityId: proof.state.authorityId, authorityHash: proof.state.authorityHash,
      principalId: proof.state.principalId, principalRecordId: proof.state.principalRecordId, principalVersion: proof.state.principalVersion } })
}
function definition(name: string): AutomationDefinition {
  return { name, prompt: `private task ${name}`, schedule: { kind: 'every', anchorAt: '2026-10-30T00:00:00.000Z', intervalMs: 60_000 },
    workspace: authority.workspace, agentPreset: authority.agentPreset, provider: 'mock', model: 'mock-model', principal: externalPrincipalId(authority.principal),
    allowedTools: ['wiki_search'], timeoutMs: 60_000, maxOutputTokens: 2_048, maxToolCalls: 4,
    misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0 }
}
function mutate(path: string, action: (database: DatabaseSync) => void) {
  const database = new DatabaseSync(path)
  try { action(database) } finally { database.close() }
}
function retire(store: AutomationStoreFixture, target: { owner: string; automationId: string }, evidenceDigest: string) {
  const record = store.get(target.automationId)!
  store.retireSystemOwned({ ...target,
    operationId: `owner-revoked:${hash([target.owner, target.automationId, hash(record.definition), record.version, evidenceDigest])}`,
    definitionHash: hash(record.definition), expectedVersion: record.version, reason: 'owner-revoked', evidenceDigest })
}

async function fixture(options: { version?: 15 | 16; oldMarker?: 'paused' | 'deleted' | 'missing'; paused?: boolean;
  wrongEvidence?: boolean; beforeOnly?: boolean; memoryEvidence?: 'four-fields' | 'observed-version' } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rsi-retirement-transition-'))); roots.push(root)
  const { AutomationStore, DeliveryStore } = await stores()
  const deliveryPath = join(root, 'delivery', 'state.sqlite')
  const delivery = new DeliveryStore({ path: deliveryPath, codeGenerator: () => 'PAIR1234' })
  let owner: DeliveryPrincipal
  try {
    const issued = delivery.issuePairing(authority.principal, { ttlMs: 1_000, maxAttempts: 3 })
    owner = delivery.confirmPairing({ challengeId: issued.challenge.id, principal: authority.principal, code: issued.code })
    delivery.revokePrincipal(owner.id, owner.version)
  } finally { delivery.close() }
  const ownerProof = inspectRevokedOwnerRouteLocally({ databasePath: deliveryPath, authority,
    principalRecordId: owner.id, frozenPrincipalVersion: owner.version })
  const path = join(root, 'automations', 'state.sqlite')
  const store = new AutomationStore({ path, now: () => now })
  try {
    for (const target of scannerTargets) store.reconcileSystemOwned({ ...target,
      definition: definition(target.owner), idempotencyKey: `create-${target.owner}`, desiredStatus: options.paused ? 'paused' : 'active' })
    store.createApproved({ automationId: 'ordinary-owner-task', idempotencyKey: 'ordinary', definition: definition('ordinary') })
    if (options.oldMarker) {
      const prior = { owner: 'historical-owner', automationId: 'historical-scanner' }
      store.reconcileSystemOwned({ ...prior, definition: definition('historical'), idempotencyKey: 'historical' })
      retire(store, prior, 'e'.repeat(64))
      if (options.oldMarker === 'deleted') store.changeApproved({ automationId: prior.automationId, operation: 'delete',
        expectedVersion: 2, idempotencyKey: 'delete-historical' })
    }
  } finally { store.close() }
  mutate(path, database => {
    if (options.oldMarker === 'missing') {
      database.exec("DELETE FROM automation_system_reconciles WHERE automation_id='historical-scanner'; DELETE FROM automation_definitions WHERE id='historical-scanner'")
    }
    if (options.version === 15) database.exec(`DROP TRIGGER automation_retirements_no_update;
      DROP TRIGGER automation_retirements_no_delete; DROP TRIGGER automation_retired_no_activate_insert;
      DROP TRIGGER automation_retired_no_activate_update; DROP TABLE automation_system_retirements; PRAGMA user_version=15`)
    database.prepare(`INSERT INTO automation_occurrences(id,automation_id,trigger_kind,trigger_key,scheduled_at,status,dry_run,created_at,updated_at)
      VALUES ('occurrence','ordinary-owner-task','manual','manual',?,'unknown',0,?,?)`).run(now, now, now)
    database.prepare(`INSERT INTO automation_tasks(id,occurrence_id,automation_id,status,cancel_requested,attempt_count,created_at,updated_at)
      VALUES ('unknown-task','occurrence','ordinary-owner-task','unknown',0,0,?,?)`).run(now, now)
  })
  const before = inspectAutomationRetirementSnapshot(path)
  if (!options.beforeOnly) {
    // Constructor performs the real v15->v16 migration when needed, then the
    // official writer commits exactly the intended four retirement CAS changes.
    const writer = new AutomationStore({ path, now: () => now + 1_000 })
    try {
      for (const target of scannerTargets) {
        let evidenceDigest = options.wrongEvidence ? 'f'.repeat(64) : evidence(ownerProof, target.owner)
        if (target.owner === 'assistant-memory-learning' && options.memoryEvidence === 'four-fields') evidenceDigest = evidence(ownerProof)
        if (target.owner === 'assistant-memory-learning' && options.memoryEvidence === 'observed-version') {
          const scope = runtimeScope(ownerProof, target.owner)
          evidenceDigest = hash({ protocol: 'scanner-owner-revoked/v1', scope: { ...scope,
            expectedOwner: { ...scope.expectedOwner!, principalVersion: ownerProof.state.principalVersion } }, state: ownerProof.state })
        }
        retire(writer, target, evidenceDigest)
      }
    }
    finally { writer.close() }
  }
  const after = inspectAutomationRetirementSnapshot(path)
  return { path, deliveryPath, before, after, ownerProof, targets: scannerTargets }
}

function expectRejected(input: ScannerRetirementTransitionInput, code?: ScannerRetirementTransitionError['code']) {
  expect(() => verifyScannerRetirementTransition(input)).toThrowError(expect.objectContaining({
    name: 'ScannerRetirementTransitionError', ...(code === undefined ? {} : { code }),
  }))
}

function clone(input: ScannerRetirementTransitionInput): Mutable<ScannerRetirementTransitionInput> { return structuredClone(input) as Mutable<ScannerRetirementTransitionInput> }

describe('pure exact scanner retirement transition verification', () => {
  test('freezes all four operations before writes and matches independently produced production receipts', async () => {
    const input = await fixture()
    const original = JSON.stringify(input)
    const operations = prepareScannerRetirementOperations(input)
    expect(operations).toHaveLength(4)
    expect(Object.isFrozen(operations)).toBe(true)
    for (const operation of operations) {
      expect(Object.isFrozen(operation)).toBe(true)
      const persisted = input.after.retirements.find(marker => marker.automationId === operation.automationId)!
      const { definitionVersion: _version, automationStatus: _status, retiredAt: _time, ...frozen } = persisted
      expect(operation).toEqual(frozen)
    }
    expect(JSON.stringify(input)).toBe(original)
    expect(inspectAutomationRetirementSnapshot(input.path)).toEqual(input.after)
  })

  test('does not generate fresh operations from an already retired or changed definition', async () => {
    const input = await fixture()
    expect(() => prepareScannerRetirementOperations({ ...input, before: input.after })).toThrow()
    const changed = clone(input)
    changed.before.records.find(row => row.id === input.targets[0]!.automationId)!.status = 'deleted'
    expect(() => prepareScannerRetirementOperations(changed)).toThrow()
  })

  test.each([15, 16] as const)('accepts formal SQLite schema %i -> 16 retirement and returns a frozen bounded receipt', async version => {
    const input = await fixture({ version })
    const serialized = JSON.stringify(input)
    const receipt = verifyScannerRetirementTransition(input)
    expect(receipt).toMatchObject({ protocol: scannerRetirementTransitionProtocol,
      beforeSnapshotDigest: input.before.snapshotDigest, afterSnapshotDigest: input.after.snapshotDigest,
      ownerProofSnapshotDigest: input.ownerProof.snapshotDigest })
    expect(receipt).not.toHaveProperty('evidenceDigest')
    receipt.targets.forEach(target => expect(target.evidenceDigest).toBe(evidence(input.ownerProof, target.owner)))
    expect(receipt.targets).toHaveLength(4)
    expect(new Set(receipt.targets.map(target => target.evidenceDigest)).size).toBe(2)
    expect(receipt.targets.every(target => /^[a-f0-9]{64}$/u.test(target.markerDigest))).toBe(true)
    const { receiptDigest, ...unsigned } = receipt
    expect(receiptDigest).toBe(createHash('sha256').update(canonicalJson(unsigned)).digest('hex'))
    expect(Object.isFrozen(receipt)).toBe(true); expect(Object.isFrozen(receipt.targets)).toBe(true)
    receipt.targets.forEach(target => expect(Object.isFrozen(target)).toBe(true))
    expect(JSON.stringify(receipt)).not.toMatch(/private task|prompt|PAIR1234|unknown-task/u)
    expect(JSON.stringify(input)).toBe(serialized)
    expect(inspectAutomationRetirementSnapshot(input.path)).toEqual(input.after)
    expect(input.after.historyTables).toEqual(input.before.historyTables)
  })

  test('accepts production MemoryLearningRuntime.start retirement with its frozen expectedOwner scope', async () => {
    const input = await fixture({ beforeOnly: true })
    const { AutomationStore } = await stores()
    const config: LearningConfig = {
      databasePath: join(dirname(input.path), 'memory-learning.sqlite'), authorityId: 'memory-extraction-transition',
      owner: { authorityId: authority.id, authorityHash: input.ownerProof.state.authorityHash,
        principalId: input.ownerProof.state.principalId, principalRecordId: input.ownerProof.state.principalRecordId,
        principalVersion: input.ownerProof.frozenPrincipalVersion, workspace: authority.workspace, agentPreset: authority.agentPreset },
      expiresAt: Date.now() + 100_000, maxExtractions: 3, maxPending: 3, lookbackMs: 180_000,
      policy: 'Extract only owner-supported durable knowledge.', maxInputBytes: 8192, maxOutputTokens: 256, timeoutMs: 10_000,
      budgetId: 'memory-learn-budget', budgetAmount: 1, scanBudgetId: 'memory-scan-budget', scanBudgetAmount: 1,
      reviewAuthorityId: 'memory-review', reviewAuthorityDigest: 'a'.repeat(64),
      adoptionAuthorityId: 'memory-adoption', adoptionGrantDigest: 'b'.repeat(64),
    }
    const target: ScannerRetirementTarget = { owner: 'assistant-memory-learning',
      automationId: `memory-scan-${growthObjectDigest([config.authorityId, config.owner])}` }
    const seed = new AutomationStore({ path: input.path, now: () => now })
    try { seed.reconcileSystemOwned({ ...target, definition: definition('actual-memory-runtime'), idempotencyKey: 'actual-memory-runtime' }) }
    finally { seed.close() }
    const before = inspectAutomationRetirementSnapshot(input.path)
    const writer = new AutomationStore({ path: input.path, now: () => now + 1000 })
    const calls: Array<Record<string, unknown>> = []
    const productionScope = { authorityId: config.owner.authorityId, principalId: config.owner.principalId,
      workspace: config.owner.workspace, agentPreset: config.owner.agentPreset,
      expectedOwner: { authorityHash: config.owner.authorityHash, principalRecordId: config.owner.principalRecordId,
        principalVersion: config.owner.principalVersion } }
    const forbidden = () => { throw new Error('revoked runtime must stop before this port is used') }
    const methods = (names: readonly string[]) => Object.fromEntries(names.map(name => [name, forbidden]))
    const { MemoryLearningRuntime } = await import(pathToFileURL(join(dirname(require.resolve('@dsh-enhanced/assistant-memory-learning/package.json')),
      'lib/runtime.js')).href) as { MemoryLearningRuntime: new (config: LearningConfig, ports: unknown) => {
        start(): void; close(): Promise<void>; health(): { connected: boolean }
      } }
    const runtime = new MemoryLearningRuntime(config, {
      delivery: { ...methods(['validateOwnerRoute', 'listOwnerForegroundTaskSources', 'inspectOwnerForegroundTaskSource',
        'withOwnerForegroundTaskSourcesFence', 'inspectOwnerForegroundLearningTask']),
      inspectOwnerRouteState: (scope: unknown) => { expect(scope).toEqual(productionScope); return input.ownerProof.state } },
      automations: { ...methods(['onSchedulerWake', 'registerHostExecutor', 'reconcileSystem', 'inspectSystemOwnedActivation']),
        inspectSystemOwnedRetirement: (request: Record<string, unknown>) => writer.inspectSystemOwnedRetirement(request),
        inspectSystemOwned: (request: Record<string, unknown>) => writer.inspectSystemOwned(request),
        retireSystemOwned: (request: Record<string, unknown>) => { calls.push(request); return writer.retireSystemOwned(request) } },
      evaluation: methods(['canonicalHostScope', 'listTrustedTaskLearningProjections', 'withTrustedCanonicalScopeWriterFence',
        'getTrustedForegroundLearningProjection', 'inspectTrustedTaskOwnerRevision']),
      memory: methods(['listLearningTargets', 'inspectLearningAdoptionAvailability', 'lookupLearningAdoption', 'adoptReviewedLearning']),
      verifier: methods(['inspectMemoryLearningReviewAvailability', 'reviewMemoryLearning', 'lookupMemoryLearningReview']),
      policy: methods(['evaluate', 'authorize']), extract: forbidden,
    })
    try { runtime.start(); expect(runtime.health().connected).toBe(false) }
    finally { await runtime.close(); writer.close() }
    expect(calls).toHaveLength(1)
    const after = inspectAutomationRetirementSnapshot(input.path)
    const marker = after.retirements.find(item => item.automationId === target.automationId)!
    expect(marker.evidenceDigest).toBe(hash({ protocol: 'scanner-owner-revoked/v1', scope: productionScope, state: input.ownerProof.state }))
    expect(config.owner.principalVersion).toBe(1)
    expect(input.ownerProof.state.principalVersion).toBe(2)
    expect(marker.evidenceDigest).not.toBe(evidence(input.ownerProof))
    const receipt = verifyScannerRetirementTransition({ before, after, ownerProof: input.ownerProof, targets: [target] })
    expect(receipt.targets).toHaveLength(1)
    expect(receipt.targets[0]!.evidenceDigest).toBe(marker.evidenceDigest)
    // A formally valid proof frozen at observed version 2 is a different grant
    // scope from this runtime's frozen version 1 and must not match its marker.
    const otherFrozenGrant = inspectRevokedOwnerRouteLocally({ databasePath: input.deliveryPath, authority,
      principalRecordId: config.owner.principalRecordId, frozenPrincipalVersion: input.ownerProof.state.principalVersion })
    expectRejected({ before, after, ownerProof: otherFrozenGrant, targets: [target] }, 'retirements-changed')
  })

  test('accepts an already-paused target and preserves every other definition field', async () => {
    expect(verifyScannerRetirementTransition(await fixture({ paused: true })).targets).toHaveLength(4)
  })

  test.each(['paused', 'deleted', 'missing'] as const)('preserves a historical %s marker and unchanged non-target record', async oldMarker => {
    const input = await fixture({ oldMarker })
    const original = input.before.retirements[0]!
    expect(verifyScannerRetirementTransition(input).targets).toHaveLength(4)
    expect(input.after.retirements).toContainEqual(original)
    expect(input.after.retirements).toHaveLength(5)
  })

  test('rebuilds evidence field order independent of incoming JSON object key order', async () => {
    const input = await fixture()
    const reordered = (value: unknown): unknown => value !== null && typeof value === 'object'
      ? Array.isArray(value) ? value.map(reordered) : Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reordered(child)])) : value
    const changed = { ...input, ownerProof: reordered(input.ownerProof) as RevokedOwnerRouteSnapshot }
    expect(verifyScannerRetirementTransition(changed)).toEqual(verifyScannerRetirementTransition(input))
  })

  test('matches each actual ScannerOwnerGuard using its production runtime scope, including Memory expectedOwner', async () => {
    const input = await fixture()
    const receipt = verifyScannerRetirementTransition(input)
    for (const [packageName, target] of [
      ['@dsh-enhanced/assistant-memory-learning', input.targets[0]!],
      ['@dsh-enhanced/assistant-growth-driver', input.targets[1]!],
      ['@dsh-enhanced/plugin-control-plane', input.targets[2]!],
    ] as const) {
      const { ScannerOwnerGuard } = await import(pathToFileURL(join(dirname(require.resolve(`${packageName}/package.json`)),
        'lib/scanner-owner-runtime.js')).href) as { ScannerOwnerGuard: new (...args: unknown[]) => { check(): unknown } }
      const calls: Array<Record<string, unknown>> = []
      const record = input.before.records.find(item => item.id === target.automationId)!
      const guard = new ScannerOwnerGuard(target.owner, target.automationId,
        runtimeScope(input.ownerProof, target.owner),
        { inspectOwnerRouteState: () => input.ownerProof.state }, {
          inspectSystemOwnedRetirement: () => undefined,
          inspectSystemOwned: () => ({ definitionHash: record.definitionHash, definitionVersion: record.version }),
          retireSystemOwned: (request: Record<string, unknown>) => { calls.push(request) },
        })
      expect(() => guard.check()).toThrow('scanner owner explicitly revoked')
      const marker = input.after.retirements.find(item => item.automationId === target.automationId)!
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ owner: target.owner, automationId: target.automationId,
        evidenceDigest: receipt.targets.find(item => item.owner === target.owner)!.evidenceDigest, operationId: marker.operationId })
    }
  })

  test('does not infer a target from any other scanner-like or job definition', async () => {
    const input = await fixture()
    expectRejected({ ...input, targets: input.targets.slice(0, 3) }, 'definitions-changed')
    expectRejected({ ...input, targets: [] }, 'definitions-changed')
  })

  test('accepts no target only when there are no retirement changes', async () => {
    const input = await fixture({ beforeOnly: true })
    expect(verifyScannerRetirementTransition({ ...input, targets: [] }).targets).toEqual([])
  })

  const invalidTargets: Array<[string, (input: Mutable<ScannerRetirementTransitionInput>) => void]> = [
    ['more than four', input => { input.targets.push(input.targets[0]!) }],
    ['duplicate owner', input => { input.targets[1] = { owner: input.targets[0]!.owner, automationId: `memory-scan-${'e'.repeat(64)}` } }],
    ['duplicate target', input => { input.targets[1] = input.targets[0]! }],
    ['wrong prefix', input => { input.targets[0]!.automationId = `usage-scan-${'a'.repeat(64)}` }],
    ['suffix or job', input => { input.targets[0]!.automationId += '-job' }],
    ['short digest', input => { input.targets[0]!.automationId = 'memory-scan-abc' }],
    ['uppercase digest', input => { input.targets[0]!.automationId = `memory-scan-${'A'.repeat(64)}` }],
    ['unknown owner', input => { Object.assign(input.targets[0]!, { owner: 'untrusted-owner' }) }],
    ['extra target field', input => { Object.assign(input.targets[0]!, { grantsWrite: true }) }],
  ]
  test.each(invalidTargets)('rejects target boundary: %s', async (_name, tamper) => {
    const input = clone(await fixture()); tamper(input)
    expectRejected(input, 'invalid-targets')
  })

  const definitionChanges: Array<[string, (input: Mutable<ScannerRetirementTransitionInput>) => void]> = [
    ['missing target', input => { input.before.records = input.before.records.filter(record => record.id !== input.targets[0]!.automationId) }],
    ['removed definition', input => { input.after.records.pop() }],
    ['added definition', input => { input.after.records.push({ ...input.after.records[0]!, id: 'new-definition' }) }],
    ['duplicate definition', input => { input.after.records.push(input.after.records[0]!) }],
    ['changed immutable digest', input => { input.after.records[0]!.immutableDigest = '1'.repeat(64) }],
    ['changed prompt', input => { input.after.records[0]!.definition.prompt += 'changed' }],
    ['changed creation key', input => { input.after.records[0]!.createIdempotencyKeyDigest = '2'.repeat(64) }],
    ['changed creation time', input => { input.after.records[0]!.createdAt++ }],
    ['changed owner', input => { input.before.records.find(record => record.id === input.targets[0]!.automationId)!.owner = 'wrong-owner' }],
    ['already-deleted target', input => { input.before.records.find(record => record.id === input.targets[0]!.automationId)!.status = 'deleted' }],
    ['target inflight', input => { input.before.records.find(record => record.id === input.targets[0]!.automationId)!.runningTaskCount = 1 }],
    ['new target inflight', input => { input.after.records.find(record => record.id === input.targets[0]!.automationId)!.runningTaskCount = 1 }],
    ['activation', input => { input.after.records.find(record => record.id === input.targets[0]!.automationId)!.status = 'active' }],
    ['next wake', input => { input.after.records.find(record => record.id === input.targets[0]!.automationId)!.nextRunAt = now + 60_000 }],
    ['wrong CAS', input => { input.after.records.find(record => record.id === input.targets[0]!.automationId)!.version++ }],
    ['changed ordinary record', input => { input.after.records.find(record => record.id === 'ordinary-owner-task')!.updatedAt++ }],
  ]
  test.each(definitionChanges)('rejects definition boundary: %s', async (_name, tamper) => {
    const input = clone(await fixture()); tamper(input)
    expectRejected(input, 'definitions-changed')
  })

  const markerChanges: Array<[string, (input: Mutable<ScannerRetirementTransitionInput>) => void]> = [
    ['no marker', input => { input.after.retirements.pop() }],
    ['extra marker', input => { input.after.retirements.push({ ...input.after.retirements[0]!, automationId: 'unplanned-id', operationId: 'unplanned-op' }) }],
    ['wrong owner', input => { input.after.retirements[0]!.owner = 'wrong-owner' }],
    ['wrong id', input => { input.after.retirements[0]!.automationId = 'wrong-id' }],
    ['wrong hash', input => { input.after.retirements[0]!.definitionHash = '3'.repeat(64) }],
    ['wrong expected version', input => { input.after.retirements[0]!.expectedVersion++ }],
    ['wrong new version', input => { input.after.retirements[0]!.definitionVersion++ }],
    ['wrong operation', input => { input.after.retirements[0]!.operationId = 'wrong-operation' }],
    ['wrong evidence', input => { input.after.retirements[0]!.evidenceDigest = '4'.repeat(64) }],
    ['wrong reason', input => { Object.assign(input.after.retirements[0]!, { reason: 'missing-owner' }) }],
    ['wrong status', input => { Object.assign(input.after.retirements[0]!, { automationStatus: 'active' }) }],
    ['wrong retired time', input => { input.after.retirements[0]!.retiredAt++ }],
    ['duplicate marker', input => { input.after.retirements.push(input.after.retirements[0]!) }],
    ['duplicate operation', input => { input.after.retirements[1]!.operationId = input.after.retirements[0]!.operationId }],
    ['already retired target', input => { input.before.retirements.push(input.after.retirements[0]!) }],
  ]
  test.each(markerChanges)('rejects marker boundary: %s', async (_name, tamper) => {
    const input = clone(await fixture()); tamper(input)
    expectRejected(input, 'retirements-changed')
  })

  test.each(['delete', 'change'] as const)('rejects %s of an old physically orphaned marker', async mode => {
    const input = clone(await fixture({ oldMarker: 'missing' }))
    const index = input.after.retirements.findIndex(marker => marker.owner === 'historical-owner')
    if (mode === 'delete') input.after.retirements.splice(index, 1)
    else input.after.retirements[index]!.evidenceDigest = '9'.repeat(64)
    expectRejected(input, 'retirements-changed')
  })

  test('rejects real writer retirement evidence from a different route observation', async () => {
    expectRejected(await fixture({ wrongEvidence: true }), 'retirements-changed')
  })

  test.each(['four-fields', 'observed-version'] as const)('rejects Memory retirement with incorrect production scope: %s', async memoryEvidence => {
    expectRejected(await fixture({ memoryEvidence }), 'retirements-changed')
  })

  test('rejects a valid formal owner proof for another route instead of reinterpreting existing markers', async () => {
    const input = await fixture()
    const ownerProof = inspectRevokedOwnerRouteLocally({ databasePath: input.deliveryPath,
      authority: { ...authority, id: 'another-owner-route', workspace: '/work/other' },
      principalRecordId: input.ownerProof.state.principalRecordId, frozenPrincipalVersion: input.ownerProof.frozenPrincipalVersion })
    expect(ownerProof.state.status).toBe('revoked')
    expectRejected({ ...input, ownerProof }, 'retirements-changed')
  })

  const proofChanges: Array<[string, (input: Mutable<ScannerRetirementTransitionInput>) => void]> = [
    ['wrong proof protocol', input => { Object.assign(input.ownerProof, { protocol: 'wrong' }) }],
    ['future Delivery schema', input => { Object.assign(input.ownerProof, { schemaVersion: 28 }) }],
    ['wrong authority', input => { input.ownerProof.authority.id = 'different-route' }],
    ['wrong route workspace', input => { input.ownerProof.authority.workspace = '/work/other' }],
    ['noncanonical authority', input => { input.ownerProof.authority.policyRef = ' owner-dm ' }],
    ['unknown authority field', input => { Object.assign(input.ownerProof.authority, { hidden: 'secret' }) }],
    ['wrong principal', input => { input.ownerProof.state.principalId = 'lark/primary/personal/ou_other' }],
    ['wrong authority hash', input => { input.ownerProof.state.authorityHash = '0'.repeat(64) }],
    ['active proof', input => { Object.assign(input.ownerProof.state, { status: 'active' }) }],
    ['missing proof', input => { Object.assign(input.ownerProof.state, { status: 'unavailable' }) }],
    ['wrong principal record', input => { input.ownerProof.state.principalRecordId = 'invalid-id' }],
    ['older lineage', input => { input.ownerProof.frozenPrincipalVersion = 3 }],
    ['zero frozen version', input => { input.ownerProof.frozenPrincipalVersion = 0 }],
    ['fractional version', input => { input.ownerProof.state.principalVersion = 1.5 }],
    ['bad proof digest', input => { input.ownerProof.snapshotDigest = 'f'.repeat(64) }],
    ['before inflight', input => { input.before.inFlightCount = 1 }],
    ['after inflight', input => { input.after.inFlightCount = 1 }],
    ['future Automations before schema', input => { Object.assign(input.before, { schemaVersion: 17 }) }],
    ['old Automations after schema', input => { Object.assign(input.after, { schemaVersion: 15 }) }],
  ]
  test.each(proofChanges)('rejects owner/snapshot boundary: %s', async (_name, tamper) => {
    const input = clone(await fixture()); tamper(input)
    expectRejected(input, 'invalid-proof')
  })

  test('rejects same-count real unknown task history edits using formal snapshots', async () => {
    const input = await fixture()
    mutate(input.path, database => database.exec("UPDATE automation_tasks SET updated_at=updated_at+1 WHERE id='unknown-task'"))
    const after = inspectAutomationRetirementSnapshot(input.path)
    expect(after.historyTables.find(table => table.name === 'automation_tasks')!.rowCount)
      .toBe(input.before.historyTables.find(table => table.name === 'automation_tasks')!.rowCount)
    expectRejected({ ...input, after }, 'history-changed')
  })

  test.each(['name', 'rowCount', 'digest', 'delete', 'add'] as const)('rejects history %s change', async mode => {
    const input = clone(await fixture())
    if (mode === 'name') input.after.historyTables[0]!.name = 'unknown-table'
    if (mode === 'rowCount') input.after.historyTables[0]!.rowCount++
    if (mode === 'digest') input.after.historyTables[0]!.digest = '5'.repeat(64)
    if (mode === 'delete') input.after.historyTables.pop()
    if (mode === 'add') input.after.historyTables.push({ ...input.after.historyTables[0]!, name: 'extra-table' })
    expectRejected(input, 'history-changed')
  })

  test.each([15, 16] as const)('rejects schema deletions, changed old SQL, extra entries and changed table binding from v%i', async version => {
    const original = await fixture({ version })
    const removed = clone(original); removed.after.schemaEntries.shift(); expectRejected(removed, 'schema-changed')
    const changed = clone(original)
    const old = changed.before.schemaEntries.find(entry => entry.sql !== null)!
    changed.after.schemaEntries.find(entry => entry.name === old.name && entry.type === old.type)!.sql += ' changed'
    expectRejected(changed, 'schema-changed')
    const extra = clone(original)
    extra.after.schemaEntries.push({ type: 'trigger', name: 'extra_trigger', table: 'automation_definitions', sql: 'SELECT 1' })
    expectRejected(extra, 'schema-changed')
    const rebound = clone(original)
    rebound.after.schemaEntries.find(entry => entry.name === 'automation_retirements_no_update')!.table = 'automation_definitions'
    expectRejected(rebound, 'schema-changed')
  })

  test('rejects wrong schema digest for v16 and unreviewed/missing migration additions for v15', async () => {
    const sameSchema = clone(await fixture()); sameSchema.after.schemaDigest = '6'.repeat(64)
    expectRejected(sameSchema, 'schema-changed')
    const migration = await fixture({ version: 15 })
    const beforeNames = new Set(migration.before.schemaEntries.map(entry => entry.name))
    for (const addition of migration.after.schemaEntries.filter(entry => !beforeNames.has(entry.name))) {
      const removed = clone(migration)
      removed.after.schemaEntries = removed.after.schemaEntries.filter(entry => entry.name !== addition.name)
      expectRejected(removed, 'schema-changed')
    }
    const wrongIndex = clone(migration)
    wrongIndex.after.schemaEntries.find(entry => entry.name === 'sqlite_autoindex_automation_system_retirements_1')!.sql = 'CREATE INDEX unrelated'
    expectRejected(wrongIndex, 'schema-changed')
  })
})
