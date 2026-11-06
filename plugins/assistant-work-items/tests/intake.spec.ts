import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import {
  AssistantWorkItemsService,
  classifyIntake,
  type Config,
  ConfigSchema,
  gradeIntakeStrength,
  normalizeConfig,
  type WorkItemIntakeInput,
} from '../src/index.ts'
import { WorkItemStore } from '../src/store.ts'

const roots: string[] = []
const services: AssistantWorkItemsService[] = []

afterEach(async () => {
  for (const service of services.splice(0)) service.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function location() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-work-items-intake-'))
  roots.push(root)
  return { root, databasePath: join(root, 'state', 'state.sqlite'), workRoot: join(root, 'work') }
}

function input(overrides: Partial<WorkItemIntakeInput> = {}): WorkItemIntakeInput {
  return {
    source: 'lark-channel',
    sourceEventId: 'om_event_1',
    kind: 'message',
    senderAllowlisted: true,
    addressed: true,
    threadFollowUp: false,
    senderIsBot: false,
    occurredAt: 1_700_000_000_000,
    ...overrides,
  }
}

function open(config: Config): AssistantWorkItemsService {
  const service = new AssistantWorkItemsService(new Context(), config)
  services.push(service)
  return service
}

async function observeConfig(intakeLedger: Config['intakeLedger'] = { enabled: true }): Promise<Config & { databasePath: string }> {
  const paths = await location()
  return { enabled: true, mode: 'observe', databasePath: paths.databasePath, workRoot: paths.workRoot, intakeLedger }
}

function rows(path: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path)
  try {
    return db.prepare('SELECT * FROM work_item_intake ORDER BY source, source_event_id').all() as Record<string, unknown>[]
  } finally {
    db.close()
  }
}

describe('intake strength grading', () => {
  // [allowlisted, addressed, threadFollowUp, bot] -> [strength, reason]
  const matrix: ReadonlyArray<readonly [boolean, boolean, boolean, boolean, string, string]> = [
    [true, true, false, false, 'explicit', 'allowlisted-addressed'],
    [true, true, true, false, 'explicit', 'allowlisted-addressed'],
    [true, false, true, false, 'explicit', 'thread-follow-up'],
    // The allowlist scopes follow-ups too: a non-allowlisted follow-up is ignored.
    [false, false, true, false, 'ignore', 'follow-up-not-allowlisted'],
    [false, true, true, false, 'ignore', 'follow-up-not-allowlisted'],
    [true, false, false, false, 'inferred', 'allowlisted-unaddressed'],
    [false, true, false, false, 'ignore', 'not-allowlisted'],
    [false, false, false, false, 'ignore', 'not-allowlisted'],
    // A bot is capped at inferred, never raised from ignore.
    [true, true, false, true, 'inferred', 'bot-capped'],
    [true, false, true, true, 'inferred', 'bot-capped'],
    [false, false, true, true, 'ignore', 'follow-up-not-allowlisted'],
    [true, false, false, true, 'inferred', 'allowlisted-unaddressed'],
    [false, true, false, true, 'ignore', 'not-allowlisted'],
    [false, false, false, true, 'ignore', 'not-allowlisted'],
  ]
  test.each(matrix)('allowlisted=%s addressed=%s followUp=%s bot=%s -> %s (%s)', (senderAllowlisted, addressed, threadFollowUp, senderIsBot, strength, reason) => {
    expect(gradeIntakeStrength({ senderAllowlisted, addressed, threadFollowUp, senderIsBot })).toEqual({ strength, reason })
  })

  test('every boolean combination never grades a bot above inferred', () => {
    for (let bits = 0; bits < 16; bits++) {
      const grade = gradeIntakeStrength({ senderAllowlisted: (bits & 1) !== 0, addressed: (bits & 2) !== 0, threadFollowUp: (bits & 4) !== 0, senderIsBot: true })
      expect(grade.strength).not.toBe('explicit')
    }
  })

  test('decisions follow the grade; ignore is filtered with a reason code', () => {
    expect(classifyIntake(input())).toMatchObject({ decision: 'stored', reason: 'strength-explicit', strength: 'explicit' })
    expect(classifyIntake(input({ addressed: false }))).toMatchObject({ decision: 'stored', reason: 'strength-inferred', strength: 'inferred' })
    expect(classifyIntake(input({ senderAllowlisted: false }))).toMatchObject({ decision: 'filtered', reason: 'strength-ignore', strength: 'ignore', strengthReason: 'not-allowlisted' })
  })

  test('only an allowlisted follow-up is explicit; any other follow-up is filtered with a reason code', () => {
    const followUp = { addressed: false, threadFollowUp: true }
    expect(classifyIntake(input(followUp))).toMatchObject({ decision: 'stored', reason: 'strength-explicit', strength: 'explicit', strengthReason: 'thread-follow-up' })
    expect(classifyIntake(input({ ...followUp, senderAllowlisted: false })))
      .toMatchObject({ decision: 'filtered', reason: 'strength-ignore', strength: 'ignore', strengthReason: 'follow-up-not-allowlisted' })
    expect(classifyIntake(input({ ...followUp, senderAllowlisted: false, senderIsBot: true })))
      .toMatchObject({ decision: 'filtered', strength: 'ignore', strengthReason: 'follow-up-not-allowlisted' })
    // In a group, a non-allowlisted follow-up is just an unaddressed message.
    const off = { unaddressedGroupMessages: false, unsubscribedEvents: false }
    const on = { unaddressedGroupMessages: true, unsubscribedEvents: false }
    expect(classifyIntake(input({ ...followUp, senderAllowlisted: false, groupMessage: true }), off))
      .toMatchObject({ decision: 'filtered', reason: 'unaddressed-group-disabled', strengthReason: 'follow-up-not-allowlisted' })
    expect(classifyIntake(input({ ...followUp, senderAllowlisted: false, groupMessage: true }), on))
      .toMatchObject({ decision: 'filtered', reason: 'strength-ignore', strengthReason: 'follow-up-not-allowlisted' })
  })
})

describe('intake input contract', () => {
  test.each(['text', 'body', 'content', 'title', 'senderId'])('rejects a %s field so no body can be stored', key => {
    expect(() => classifyIntake({ ...input(), [key]: 'secret body' } as unknown as WorkItemIntakeInput)).toThrow(/unknown field/)
  })

  test('rejects malformed metadata', () => {
    expect(() => classifyIntake(input({ source: 'Lark/Channel' }))).toThrow(/source/)
    expect(() => classifyIntake(input({ sourceEventId: '' }))).toThrow(/sourceEventId/)
    expect(() => classifyIntake(input({ sourceEventId: 'a\nb' }))).toThrow(/sourceEventId/)
    expect(() => classifyIntake(input({ sourceEventId: 'x'.repeat(257) }))).toThrow(/sourceEventId/)
    expect(() => classifyIntake(input({ addressed: 'yes' as unknown as boolean }))).toThrow(/addressed/)
    expect(() => classifyIntake(input({ contentDigest: 'ABC' }))).toThrow(/contentDigest/)
    expect(() => classifyIntake(input({ occurredAt: -1 }))).toThrow(/occurredAt/)
    expect(() => classifyIntake(input({ subscribed: false }))).toThrow(/events only/)
    expect(() => classifyIntake(input({ kind: 'event', groupMessage: true }))).toThrow(/messages only/)
  })
})

describe('per-source opt-in', () => {
  const off = { unaddressedGroupMessages: false, unsubscribedEvents: false }
  const on = { unaddressedGroupMessages: true, unsubscribedEvents: true }

  test('an unaddressed group message is filtered unless the source opted in', () => {
    const group = input({ groupMessage: true, addressed: false })
    expect(classifyIntake(group, off)).toMatchObject({ decision: 'filtered', reason: 'unaddressed-group-disabled', strength: 'inferred' })
    expect(classifyIntake(group, on)).toMatchObject({ decision: 'stored', reason: 'strength-inferred', strength: 'inferred' })
    // Addressed or follow-up group messages never need the opt-in.
    expect(classifyIntake(input({ groupMessage: true }), off)).toMatchObject({ decision: 'stored', strength: 'explicit' })
    expect(classifyIntake(input({ groupMessage: true, addressed: false, threadFollowUp: true }), off)).toMatchObject({ decision: 'stored', strength: 'explicit' })
  })

  test('an unsubscribed event is filtered unless the source opted in', () => {
    const event = input({ kind: 'event', subscribed: false, addressed: false })
    expect(classifyIntake(event, off)).toMatchObject({ decision: 'filtered', reason: 'unsubscribed-event-disabled' })
    expect(classifyIntake(event, on)).toMatchObject({ decision: 'stored', reason: 'strength-inferred' })
    expect(classifyIntake(input({ kind: 'event', addressed: false }), off)).toMatchObject({ decision: 'stored' })
  })

  test('config opt-ins are per source, default off and validated', async () => {
    const paths = await location()
    const base = { databasePath: paths.databasePath, workRoot: paths.workRoot }
    expect(normalizeConfig(base).intakeLedger).toBeUndefined()
    expect(normalizeConfig({ ...base, intakeLedger: { enabled: false, sources: { 'lark-channel': { unaddressedGroupMessages: true } } } }).intakeLedger).toBeUndefined()
    expect(normalizeConfig({ ...base, intakeLedger: { enabled: true, sources: { 'lark-channel': { unaddressedGroupMessages: true } } } }).intakeLedger)
      .toEqual({ enabled: true, sources: { 'lark-channel': { unaddressedGroupMessages: true, unsubscribedEvents: false } } })
    expect(() => normalizeConfig({ ...base, intakeLedger: { enabled: true, sources: { 'Lark': {} } } })).toThrow(/source ids/)
    expect(() => normalizeConfig({ ...base, intakeLedger: { enabled: true, sources: { lark: { everything: true } } } } as unknown as Config)).toThrow(/unknown field/)
    expect(() => normalizeConfig({ ...base, intakeLedger: { enabled: 'yes' } } as unknown as Config)).toThrow(/intakeLedger.enabled/)
    expect(() => ConfigSchema({ ...base, intakeLedger: { enabled: true, sources: { lark: { unsubscribedEvents: true } } } })).not.toThrow()
  })

  test('the service applies only the matching source opt-in', async () => {
    const config = await observeConfig({ enabled: true, sources: { 'lark-channel': { unaddressedGroupMessages: true } } })
    const service = open(config)
    const group = { groupMessage: true, addressed: false }
    expect(service.recordIntake(input({ ...group, sourceEventId: 'g-1' })).record).toMatchObject({ decision: 'stored', strength: 'inferred' })
    expect(service.recordIntake(input({ ...group, source: 'other-chat', sourceEventId: 'g-1' })).record)
      .toMatchObject({ decision: 'filtered', reason: 'unaddressed-group-disabled' })
    expect(service.recordIntake(input({ kind: 'event', subscribed: false, sourceEventId: 'e-1' })).record)
      .toMatchObject({ decision: 'filtered', reason: 'unsubscribed-event-disabled' })
  })
})

describe('durable intake ledger', () => {
  test('is off by default and opens no file when the plugin is disabled', async () => {
    const paths = await location()
    const disabled = open({ databasePath: paths.databasePath, workRoot: paths.workRoot, intakeLedger: { enabled: true } })
    expect(() => disabled.recordIntake(input())).toThrow(/disabled/)
    expect(await readdir(paths.root)).toEqual([])
    const ledgerOff = open({ enabled: true, mode: 'observe', databasePath: paths.databasePath, workRoot: paths.workRoot })
    expect(() => ledgerOff.recordIntake(input())).toThrow(/intake ledger is disabled/)
    // "Cannot tell" is never read as "not admitted from intake".
    expect(() => disabled.inspectIntakeProvenance('any-item')).toThrow(/intake ledger is disabled/)
    expect(() => ledgerOff.inspectIntakeProvenance('any-item')).toThrow(/intake ledger is disabled/)
  })

  test('records in observe mode without admitting or dispatching work', async () => {
    const config = await observeConfig()
    const service = open(config)
    const result = service.recordIntake(input())
    expect(result).toMatchObject({ replayed: false, record: { source: 'lark-channel', sourceEventId: 'om_event_1', decision: 'stored', strength: 'explicit', strengthReason: 'allowlisted-addressed' } })
    expect(result.record.signals).toEqual({ senderAllowlisted: true, addressed: true, threadFollowUp: false, senderIsBot: false, groupMessage: false, subscribed: true })
    expect(service.health().openItems).toBe(0)
    const store = new WorkItemStore(config.databasePath)
    try {
      expect(store.stats()).toMatchObject({ schemaVersion: 12, items: 0, dispatches: 0 })
      expect(store.countIntake()).toEqual({ stored: 1, duplicate: 0, filtered: 0 })
    } finally {
      store.close()
    }
  })

  test('a replay returns the original decision with no second row, including across a restart', async () => {
    const config = await observeConfig()
    const first = open(config)
    const original = first.recordIntake(input({ addressed: false }))
    expect(original.record.decision).toBe('stored')
    // Same key, different metadata: the original decision wins and nothing is rewritten.
    const replay = first.recordIntake(input({ senderAllowlisted: false }))
    expect(replay).toEqual({ record: original.record, replayed: true, metadataChanged: true })
    expect(first.recordIntake(input({ addressed: false }))).toEqual({ record: original.record, replayed: true })
    first.close()

    const reopened = open(config)
    expect(reopened.recordIntake(input({ addressed: false }))).toEqual({ record: original.record, replayed: true })
    expect(reopened.recordIntake(input({ senderAllowlisted: false, senderIsBot: true }))).toEqual({ record: original.record, replayed: true, metadataChanged: true })
    reopened.close()
    expect(rows(config.databasePath)).toHaveLength(1)
  })

  test('a new event with an already stored content digest is a duplicate', async () => {
    const config = await observeConfig()
    const service = open(config)
    const digest = createHash('sha256').update('same text').digest('hex')
    expect(service.recordIntake(input({ sourceEventId: 'a', contentDigest: digest })).record.decision).toBe('stored')
    expect(service.recordIntake(input({ sourceEventId: 'b', contentDigest: digest })).record).toMatchObject({ decision: 'duplicate', reason: 'duplicate-content', strength: 'explicit' })
    expect(service.recordIntake(input({ sourceEventId: 'b', contentDigest: digest }))).toMatchObject({ replayed: true, record: { decision: 'duplicate' } })
    // Other sources and filtered rows never count as the original.
    expect(service.recordIntake(input({ source: 'mail', sourceEventId: 'a', contentDigest: digest })).record.decision).toBe('stored')
    const other = createHash('sha256').update('other').digest('hex')
    expect(service.recordIntake(input({ sourceEventId: 'c', senderAllowlisted: false, contentDigest: other })).record.decision).toBe('filtered')
    expect(service.recordIntake(input({ sourceEventId: 'd', contentDigest: other })).record.decision).toBe('stored')
  })

  test('a stronger repeat is never suppressed by a weaker stored original', async () => {
    const config = await observeConfig()
    const service = open(config)
    const digest = createHash('sha256').update('reposted with a mention').digest('hex')
    expect(service.recordIntake(input({ sourceEventId: 'weak', addressed: false, contentDigest: digest })).record).toMatchObject({ decision: 'stored', strength: 'inferred' })
    expect(service.recordIntake(input({ sourceEventId: 'strong', contentDigest: digest })).record).toMatchObject({ decision: 'stored', strength: 'explicit' })
    // Equal or weaker repeats of a stored original are duplicates.
    expect(service.recordIntake(input({ sourceEventId: 'again', contentDigest: digest })).record).toMatchObject({ decision: 'duplicate', reason: 'duplicate-content' })
    expect(service.recordIntake(input({ sourceEventId: 'weaker', addressed: false, contentDigest: digest })).record).toMatchObject({ decision: 'duplicate', strength: 'inferred' })
  })

  test('stores only metadata and digests, never a body', async () => {
    const config = await observeConfig({ enabled: true, sources: { 'lark-channel': { unaddressedGroupMessages: true } } })
    const service = open(config)
    const body = 'PRIVATE-BODY-请勿存储-4f1c'
    const contentDigest = createHash('sha256').update(body).digest('hex')
    service.recordIntake(input({ contentDigest }))
    service.recordIntake(input({ sourceEventId: 'om_event_2', groupMessage: true, addressed: false }))
    expect(() => service.recordIntake({ ...input({ sourceEventId: 'om_event_3' }), text: body } as unknown as WorkItemIntakeInput)).toThrow(/unknown field/)
    service.close()
    const stored = rows(config.databasePath)
    expect(stored).toHaveLength(2)
    expect(Object.keys(stored[0]!).sort()).toEqual(['content_digest', 'decision', 'kind', 'metadata_digest', 'occurred_at', 'reason', 'recorded_at',
      'signals', 'source', 'source_event_id', 'strength', 'strength_reason'])
    for (const suffix of ['', '-wal']) {
      let bytes: Buffer
      try { bytes = readFileSync(`${config.databasePath}${suffix}`) } catch { continue }
      expect(bytes.includes(Buffer.from(body, 'utf8'))).toBe(false)
      expect(bytes.includes(Buffer.from('PRIVATE-BODY', 'utf8'))).toBe(false)
    }
  })

  test('rows are append-only at the SQL layer', async () => {
    const config = await observeConfig()
    open(config).recordIntake(input())
    services.splice(0).forEach(service => service.close())
    const db = new DatabaseSync(config.databasePath)
    try {
      expect(() => db.exec("UPDATE work_item_intake SET decision = 'filtered'")).toThrow(/append-only/)
      expect(() => db.exec('DELETE FROM work_item_intake')).toThrow(/append-only/)
    } finally {
      db.close()
    }
  })
})

describe('schema 10 migration', () => {
  test('schema 9 upgrades additively to 10 with an empty intake ledger', async () => {
    const config = await observeConfig()
    open(config).recordIntake(input())
    services.splice(0).forEach(service => service.close())
    const db = new DatabaseSync(config.databasePath)
    db.exec("DROP TABLE work_item_intake_admission; DROP TABLE work_item_intake_evaluation; DROP TABLE work_item_intake; UPDATE work_item_schema_meta SET value = '9' WHERE key = 'schema_version'; PRAGMA user_version = 9;")
    db.close()
    const store = new WorkItemStore(config.databasePath)
    try {
      expect(store.stats().schemaVersion).toBe(12)
      expect(store.countIntake()).toEqual({ stored: 0, duplicate: 0, filtered: 0 })
    } finally {
      store.close()
    }
    const raw = new DatabaseSync(config.databasePath)
    try {
      expect(raw.prepare("SELECT value FROM work_item_schema_meta WHERE key = 'schema_version'").get()).toEqual({ value: '12' })
    } finally {
      raw.close()
    }
  })

  test('a drifted intake table or a foreign trigger fails closed', async () => {
    const config = await observeConfig()
    open(config).recordIntake(input())
    services.splice(0).forEach(service => service.close())
    const db = new DatabaseSync(config.databasePath)
    db.exec('DROP TABLE work_item_intake; CREATE TABLE work_item_intake (source TEXT) STRICT;')
    db.close()
    expect(() => new WorkItemStore(config.databasePath)).toThrow(/intake schema differs/)
    const again = new DatabaseSync(config.databasePath)
    again.exec("DROP TABLE work_item_intake_admission; DROP TABLE work_item_intake_evaluation; DROP TABLE work_item_intake; UPDATE work_item_schema_meta SET value = '9' WHERE key = 'schema_version'; PRAGMA user_version = 9;")
    again.exec("CREATE TRIGGER work_item_intake_no_update AFTER UPDATE ON work_item_schema_meta BEGIN SELECT 1; END")
    again.close()
    expect(() => new WorkItemStore(config.databasePath)).toThrow(/unexpected schema object/)
  })

  test('a pre-created intake table or index below schema 10 fails closed without migrating', async () => {
    const config = await observeConfig()
    open(config).recordIntake(input())
    services.splice(0).forEach(service => service.close())
    const db = new DatabaseSync(config.databasePath)
    // The exact current shape, planted under schema 9, is still drift.
    db.exec("DROP TABLE work_item_intake_admission; DROP TABLE work_item_intake_evaluation; DROP TRIGGER work_item_intake_no_update; DROP TRIGGER work_item_intake_no_delete; UPDATE work_item_schema_meta SET value = '9' WHERE key = 'schema_version'; PRAGMA user_version = 9;")
    db.close()
    expect(() => new WorkItemStore(config.databasePath)).toThrow(/intake object before schema 10/)
    const again = new DatabaseSync(config.databasePath)
    again.exec('DROP TABLE work_item_intake; CREATE INDEX work_item_intake_content_idx ON work_item(source_id)')
    again.close()
    expect(() => new WorkItemStore(config.databasePath)).toThrow(/intake object before schema 10/)
    const check = new DatabaseSync(config.databasePath)
    try {
      expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 9 })
    } finally {
      check.close()
    }
  })
})
