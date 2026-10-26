import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { AutomationStore } from '../src/store.ts'

const roots: string[] = []
const dueAt = Date.parse('2026-08-21T10:01:00.000Z')
const oldHash = 'a'.repeat(64)
const newHash = 'b'.repeat(64)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-automation-incident-relevance-'))
  roots.push(root)
  const path = join(root, 'state.sqlite')
  return { path, store: new AutomationStore({ path, now: () => dueAt }) }
}

function hostDefinition(activationNonce: string) {
  return {
    name: 'Host automation',
    schedule: { kind: 'at', at: '2026-08-21T10:01:00.000Z' },
    workspace: '/work/alpha', agentPreset: 'primary', timeoutMs: 60_000,
    misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
    principal: 'owner:lark:123',
    execution: {
      kind: 'host', executorId: 'assistant-recovery', executorContractVersion: 2,
      runbookId: 'supervised-growth/v2', runbookVersion: 2,
      catalogDigest: oldHash,
      targetScope: { workspace: '/work/alpha', preset: 'primary' },
      scopeDigest: oldHash, ownerRouteId: 'lark/main/tenant/owner', activationNonce,
    },
  }
}

function materialize(store: AutomationStore, available: boolean) {
  return store.materializeDue({
    now: dueAt, misfireGraceMs: 60_000, maxCatchUp: 1,
    hostAvailability: [{
      automationId: 'host', definitionHash: store.getDefinitionHash('host')!,
      stage: 'materialize', available,
      reasonCode: available ? 'host-executor-available' : 'host-executor-unavailable',
    }],
  })
}

function insertIncident(database: DatabaseSync, input: {
  id: string
  automationId: string
  definitionHash: string
  stage?: 'materialize' | 'terminal'
  state?: 'open' | 'recovering' | 'resolved'
  failureClass?: 'configuration' | 'unknown'
  failurePhase?: string
  sideEffectState?: 'none' | 'unknown'
  runId?: string
  updatedAt?: number
}) {
  const state = input.state ?? 'open'
  database.prepare(`
    INSERT INTO automation_incidents (
      id, automation_id, definition_hash, stage, state, failure_class,
      failure_phase, failure_code, side_effect_state, retryability,
      notification_route_id, lifecycle_generation, presentation_revision,
      alert_status, alert_ref, run_id, opened_at, updated_at, resolved_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'host-executor-unavailable', ?,
      'after-intervention', 'lark/main/tenant/owner', 1, 1,
      'pending', NULL, ?, 1, ?, ?, 1)
  `).run(
    input.id, input.automationId, input.definitionHash, input.stage ?? 'materialize',
    state, input.failureClass ?? 'configuration', input.failurePhase ?? 'executor-availability',
    input.sideEffectState ?? 'none', input.runId ?? null, input.updatedAt ?? 1,
    state === 'resolved' ? input.updatedAt ?? 1 : null,
  )
}

describe('incident relevance projections', () => {
  test('retains exact history while a replacement hides only obsolete open availability, including after reopen and ABA', async () => {
    const value = await fixture()
    const store = value.store
    store.reconcileSystemOwned({
      owner: 'assistant-recovery', automationId: 'host', idempotencyKey: 'host:v1',
      definition: hostDefinition('v1'),
    })
    const originalHash = store.getDefinitionHash('host')!
    materialize(store, false)
    const original = store.listIncidents({ automationId: 'host', limit: 10 })[0]!
    expect(original).toMatchObject({ state: 'open', stage: 'materialize', alertStatus: 'pending' })
    const selectedBeforeReplacement = store.listPendingIncidentAlerts(10)
    expect(selectedBeforeReplacement.map(row => row.id)).toEqual([original.id])
    expect(store.getIncidentNotificationTarget(original.id))
      .toEqual({ kind: 'owner-route', authorityId: 'lark/main/tenant/owner' })

    store.reconcileSystemOwned({
      owner: 'assistant-recovery', automationId: 'host', idempotencyKey: 'host:v2',
      definition: hostDefinition('v2'),
    })
    const replacementHash = store.getDefinitionHash('host')!
    expect(replacementHash).not.toBe(originalHash)
    expect(store.health()).toMatchObject({ openIncidents: 0, pendingIncidentAlerts: 0 })
    expect(store.listPendingIncidentAlerts(10)).toEqual([])
    expect(store.getIncidentNotificationTarget(selectedBeforeReplacement[0]!.id)).toBeUndefined()
    expect(store.getCurrentIncident('host', originalHash)).toEqual(original)
    expect(store.listIncidents({ automationId: 'host', limit: 10 })).toEqual([original])

    store.close()
    const reopened = new AutomationStore({ path: value.path, now: () => dueAt })
    expect(reopened.health()).toMatchObject({ openIncidents: 0, pendingIncidentAlerts: 0 })
    materialize(reopened, false)
    const current = reopened.getCurrentIncident('host', replacementHash)!
    expect(current).toMatchObject({ state: 'open', failureCode: 'host-executor-unavailable' })
    expect(reopened.health()).toMatchObject({ openIncidents: 1, pendingIncidentAlerts: 1 })
    expect(reopened.listPendingIncidentAlerts(10).map(row => row.id)).toEqual([current.id])
    expect(reopened.listIncidents({ automationId: 'host', limit: 10 })).toContainEqual(original)

    reopened.reconcileSystemOwned({
      owner: 'assistant-recovery', automationId: 'host', idempotencyKey: 'host:v1-again',
      definition: hostDefinition('v1'),
    })
    expect(reopened.getDefinitionHash('host')).toBe(originalHash)
    expect(reopened.health()).toMatchObject({ openIncidents: 1, pendingIncidentAlerts: 1 })
    expect(reopened.listPendingIncidentAlerts(10).map(row => row.id)).toEqual([original.id])
    expect(reopened.getIncidentNotificationTarget(original.id))
      .toEqual({ kind: 'owner-route', authorityId: 'lark/main/tenant/owner' })
    materialize(reopened, true)
    expect(reopened.getCurrentIncident('host', originalHash)).toBeUndefined()
    expect(reopened.listIncidents({ automationId: 'host', limit: 10 }))
      .toContainEqual(expect.objectContaining({ id: original.id, state: 'resolved', alertStatus: 'pending' }))
    expect(reopened.health()).toMatchObject({ openIncidents: 0, pendingIncidentAlerts: 1 })
    expect(reopened.listPendingIncidentAlerts(10).map(row => row.id)).toEqual([original.id])
    reopened.close()
  })

  test('keeps unresolved and resolved pending alerts when replacement cannot prove the row obsolete', async () => {
    const value = await fixture()
    const database = new DatabaseSync(value.path)
    const definition = database.prepare(`
      INSERT INTO automation_definitions (
        id, create_idempotency_key, system_owner, definition_hash, definition_json,
        status, next_run_at, created_at, updated_at, version
      ) VALUES (?, ?, 'assistant-recovery', ?, '{}', 'active', NULL, 1, 1, 1)
    `)
    for (const id of ['terminal-failed', 'terminal-unknown', 'resolved-card', 'recovering-old']) {
      definition.run(id, `${id}:key`, newHash)
    }
    insertIncident(database, { id: 'orphan', automationId: 'missing', definitionHash: oldHash })
    insertIncident(database, { id: 'terminal-failed', automationId: 'terminal-failed', definitionHash: oldHash,
      stage: 'terminal', runId: 'run-failed' })
    insertIncident(database, { id: 'terminal-unknown', automationId: 'terminal-unknown', definitionHash: oldHash,
      stage: 'terminal', failureClass: 'unknown', failurePhase: 'host-execution',
      sideEffectState: 'unknown', runId: 'run-unknown' })
    insertIncident(database, { id: 'resolved-card', automationId: 'resolved-card', definitionHash: oldHash,
      state: 'resolved' })
    insertIncident(database, { id: 'recovering-old', automationId: 'recovering-old', definitionHash: oldHash,
      state: 'recovering' })
    database.close()

    expect(value.store.health()).toMatchObject({ openIncidents: 3, pendingIncidentAlerts: 4 })
    expect(value.store.listPendingIncidentAlerts(10).map(row => row.id).sort()).toEqual([
      'orphan', 'resolved-card', 'terminal-failed', 'terminal-unknown',
    ])
    expect(value.store.getIncidentNotificationTarget('orphan'))
      .toEqual({ kind: 'owner-route', authorityId: 'lark/main/tenant/owner' })
    expect(value.store.getIncidentNotificationTarget('recovering-old')).toBeUndefined()
    expect(value.store.getIncidentNotificationTarget('resolved-card'))
      .toEqual({ kind: 'owner-route', authorityId: 'lark/main/tenant/owner' })
    expect(value.store.listIncidents({ limit: 10 })).toHaveLength(5)
    value.store.close()
  })

  test('filters obsolete rows before the pending LIMIT so more than 1000 old alerts cannot starve a current one', async () => {
    const value = await fixture()
    const database = new DatabaseSync(value.path)
    const definition = database.prepare(`
      INSERT INTO automation_definitions (
        id, create_idempotency_key, system_owner, definition_hash, definition_json,
        status, next_run_at, created_at, updated_at, version
      ) VALUES (?, ?, 'assistant-recovery', ?, '{}', 'active', NULL, 1, 1, 1)
    `)
    database.exec('BEGIN IMMEDIATE')
    for (let index = 0; index < 1_001; index++) {
      const id = `obsolete-${index}`
      definition.run(id, `${id}:key`, newHash)
      insertIncident(database, { id, automationId: id, definitionHash: oldHash })
    }
    definition.run('current', 'current:key', newHash)
    insertIncident(database, { id: 'current', automationId: 'current', definitionHash: newHash,
      updatedAt: 2 })
    database.exec('COMMIT')
    database.close()

    expect(value.store.health()).toMatchObject({ openIncidents: 1, pendingIncidentAlerts: 1 })
    expect(value.store.listPendingIncidentAlerts(1).map(row => row.id)).toEqual(['current'])
    expect(value.store.getIncidentNotificationTarget('obsolete-0')).toBeUndefined()
    expect(value.store.getIncidentNotificationTarget('current'))
      .toEqual({ kind: 'owner-route', authorityId: 'lark/main/tenant/owner' })
    value.store.close()
  })
})
