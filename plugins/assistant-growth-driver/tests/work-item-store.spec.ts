import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { WorkItemGrowthAuthorityPins } from '@dsh-enhanced/assistant-growth-contract'
import { afterEach, expect, test } from 'vitest'
import { normalizeConfig } from '../src/config.ts'
import { UsageStore } from '../src/usage-store.ts'
import { isWorkItemCreationReady, type WorkItemUsageLocator } from '../src/work-item-source.ts'

const roots: string[] = []
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
const database = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), 'growth-wi-store-'))); roots.push(root); return join(root, 'usage.sqlite') }
const pins: WorkItemGrowthAuthorityPins = { protocol: 'assistant-growth/work-item-authorities/v1',
  sourceJobs: { authorityId: 'source', authorityDigest: 'a'.repeat(64), expiresAt: 100_000 },
  creationGrant: { id: 'create', digest: 'b'.repeat(64), expiresAt: 100_000 },
  creationAcceptance: { protocol: 'assistant-growth/creation-acceptance-authority/v1', authorityId: 'review', authorityDigest: 'c'.repeat(64), keyId: 'key', namePrefix: 'created-', expiresAt: 100_000 },
  adoption: { authorityId: 'adopt', authorityDigest: 'd'.repeat(64), expiresAt: 100_000 } }
const base = () => ({ enabled: true, scope: { ownerRouteId: 'route', principalId: 'owner', workspace: '/work', preset: 'primary' },
  budgetId: 'existing-budget', budgetAmount: 1, usageLearning: { enabled: true, databasePath: '/private/tmp/usage.sqlite', scanBudgetId: 'scan', scanBudgetAmount: 1 },
  pluginSourceProposals: { enabled: true, preparationMode: 'durable' as const, allowCreation: true, repository: '/work/repository' } })
const locator = (itemId = 'item', version = 1): WorkItemUsageLocator => ({ protocol: 'assistant-growth/work-item-usage-locator/v1', configDigest: 'a'.repeat(64),
  owner: { authorityId: 'route', authorityHash: 'a'.repeat(64), principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: '/work', agentPreset: 'primary' },
  itemId, canonical: { outcomeId: `objective-${version}`, version, digest: String(version).repeat(64), objectiveStatus: 'not-achieved' }, createdAt: 10, expiresAt: 10_000 })

test('strict work item opt-in retains the absent/false normalized config bytes and freezes explicit pins', () => {
  const original = normalizeConfig(base()), disabled = normalizeConfig({ ...base(), usageLearning: { ...base().usageLearning, workItemFailures: false } })
  expect(disabled).toEqual(original); expect(acceptanceDigest(disabled)).toBe(acceptanceDigest(original))
  expect(disabled.usageLearning).not.toHaveProperty('workItemFailures')
  const enabled = normalizeConfig({ ...base(), usageLearning: { ...base().usageLearning, workItemFailures: true, workItemAuthorities: pins } })
  expect(acceptanceDigest(enabled)).not.toBe(acceptanceDigest(original)); expect(enabled.budgetId).toBe(original.budgetId)
  expect(Object.isFrozen(enabled.usageLearning.workItemAuthorities?.creationGrant)).toBe(true)
  for (const flag of ['true', 1, null, undefined]) expect(() => normalizeConfig({ ...base(), usageLearning: { ...base().usageLearning, workItemFailures: flag } } as never)).toThrow()
  expect(() => normalizeConfig({ ...base(), usageLearning: { ...base().usageLearning, workItemFailures: true } })).toThrow(/explicit authorities/)
  expect(() => normalizeConfig({ ...base(), usageLearning: { ...base().usageLearning, workItemAuthorities: pins } })).toThrow(/require workItemFailures/)
})

test('schema2 migration preserves exact legacy rows/cursor/source-run/unknown and introduces an independent zero cursor', () => {
  const path = database(), db = new DatabaseSync(path)
  db.exec(`CREATE TABLE usage_jobs(id TEXT PRIMARY KEY,lane TEXT NOT NULL,subject TEXT NOT NULL,intent_json TEXT NOT NULL,digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','running','reviewed','failed','unknown','superseded')),definition_hash TEXT,occurrence_id TEXT,reason TEXT,source_run_json TEXT) STRICT;
    CREATE TABLE usage_cursors(lane TEXT PRIMARY KEY,scope_key TEXT NOT NULL,watermark INTEGER NOT NULL) STRICT; PRAGMA user_version=2;`)
  db.prepare('INSERT INTO usage_cursors VALUES(?,?,?)').run('lane', 'scope', 99)
  for (const state of ['queued', 'running', 'unknown', 'reviewed']) {
    const intent = { configDigest: 'legacy', source: { protocol: 'legacy' }, model: { provider: 'original', model: 'model' }, createdAt: 1, expiresAt: 2 }
    db.prepare('INSERT INTO usage_jobs VALUES(?,?,?,?,?,?,?,?,?,?)').run(state, 'lane', state, JSON.stringify(intent), acceptanceDigest(intent), state, 'definition', 'occurrence', 'original', '{"protocol":"assistant-growth/source-run/v1","legacy":true}')
  }
  const before = db.prepare('SELECT * FROM usage_jobs ORDER BY id').all(); db.close(); chmodSync(path, 0o600)
  const store = new UsageStore(path)
  expect(store.cursor('lane')).toEqual({ scopeKey: 'scope', watermark: 99 }); expect(store.workItemCursor('lane')).toBeUndefined()
  expect(store.counts('lane')).toEqual({ queued: 1, running: 1, unknown: 1, reviewed: 1 }); store.close()
  const after = new DatabaseSync(path)
  expect(after.prepare('SELECT * FROM usage_jobs ORDER BY id').all()).toEqual(before)
  expect(after.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 }); after.close()
})

test('canonical locator precedes independent cursor; missing readers, duplicate feed entries, correction and backpressure retain identity', () => {
  const path = database(), store = new UsageStore(path)
  const stage = (watermark: number, input = locator()) => store.consumeWorkItem({ lane: 'lane', scopeKey: 'scope', watermark, itemId: input.itemId, locator: input, maxPending: 1 })
  expect(stage(1)).toBe(true); expect(stage(1)).toBe(true)
  const initial = store.pendingWorkItems('lane')[0]!
  expect(initial.locator).not.toHaveProperty('inboxId'); expect(store.workItemCursor('lane')).toEqual({ scopeKey: 'scope', watermark: 1 })
  expect(stage(2, locator('other'))).toBe(false); expect(store.workItemCursor('lane')?.watermark).toBe(1)
  expect(stage(3, locator('item', 2))).toBe(true); expect(store.pendingWorkItems('lane')).toHaveLength(1)
  expect(store.pendingWorkItems('lane')[0]!.locator.canonical.version).toBe(2)
  const final = store.pendingWorkItems('lane')[0]!; store.close()
  const restarted = new UsageStore(path); expect(restarted.pendingWorkItems('lane')[0]).toEqual(final); restarted.close()
})

test('readiness requires exact live protocol, new authority pins and positive admission balances; current run can retain a spent last allowance', () => {
  const ready = { protocol: 'assistant-growth/work-item-creation-readiness/v1', sourceProtocol: 'assistant-delivery/work-item-engineering-context/v1',
    runProtocol: 'assistant-growth/source-run/v2', workItemFailures: true, pins, remaining: { sourceSubmissions: 1, creates: 1, verifications: 1, adoptions: 1 }, available: true }
  expect(isWorkItemCreationReady(ready, pins, 1)).toBe(true)
  for (const wrong of [undefined, { available: true }, { ...ready, workItemFailures: undefined }, { ...ready, runProtocol: 'assistant-growth/source-run/v1' },
    { ...ready, pins: { ...pins, adoption: { ...pins.adoption, authorityDigest: 'f'.repeat(64) } } }]) expect(isWorkItemCreationReady(wrong, pins, 1)).toBe(false)
  const exhausted = { ...ready, remaining: { ...ready.remaining, creates: 0 }, available: false }
  expect(isWorkItemCreationReady(exhausted, pins, 1)).toBe(false); expect(isWorkItemCreationReady(exhausted, pins, 1, false)).toBe(true)
  expect(isWorkItemCreationReady(ready, pins, 100_000, false)).toBe(false)
})
