import { chmodSync, linkSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test as nativeTest } from 'vitest'
import { ReplayJournal } from '../src/replay-journal.js'
import type { EffectBlockedReplayResult } from '../src/effect-blocked-replay.js'
import { replayRuntimeDigest } from '../src/effect-blocked-replay.js'
import { runtimeConfigDigest } from '../src/runtime-observer-protocol.js'

const test = nativeTest.skipIf(process.platform !== 'linux')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'replay-journal-')); roots.push(root)
  chmodSync(root, 0o700)
  return { root, path: join(root, 'replay.sqlite') }
}
const binding = 'b'.repeat(64), request = 'a'.repeat(64), cases = 'c'.repeat(64)
const scope = 'd'.repeat(64), grant = 'e'.repeat(64)
const signed = { scopeDigest: scope, grantDigest: grant }
function result(): EffectBlockedReplayResult {
  const runtime: EffectBlockedReplayResult['runtime'] = { schemaVersion: 1, kind: 'dsh-runtime-observation',
    observerId: '0d0e7740-8f99-451a-8fa8-614c26eb5626', observerConfigDigest: 'd'.repeat(64), challenge: 'e'.repeat(64),
    processId: process.pid, invocationId: null, profilePath: '/fixture', observedAt: Date.now() - 10,
    entries: [{ entryId: 'candidate', module: 'candidate', configDigest: 'f'.repeat(64), active: true,
      instance: { uid: 2, epoch: 1 }, dependencies: [], services: [] }] }
  return { schemaVersion: 1, kind: 'dsh-effect-blocked-replay-observation', operationId: 'op', requestDigest: request,
    caseDigest: cases, sessionId: 'fixture', runtime, runtimeDigest: replayRuntimeDigest(runtime), completedAt: Date.now(), quiescent: true,
    attempts: [{ caseId: 'tool', kind: 'tool', callId: 'op:tool', inputDigest: request, resultDigest: request,
      observedAt: Date.now() - 5, blockedAt: 'native-tool-guard' },
    { caseId: 'reply', kind: 'delivery', callId: 'op:reply', inputDigest: request, resultDigest: request,
      observedAt: Date.now() - 5, blockedAt: 'delivery-reply-admission' }] }
}

test('reservation survives reopen and another SQLite connection cannot acquire the same dispatch', () => {
  const f = fixture(), first = new ReplayJournal(f.path), second = new ReplayJournal(f.path)
  try {
    expect(first.reserve('op', binding, request, cases)).toBe(true)
    expect(second.reserve('op', binding, request, cases)).toBe(false)
    expect(second.get('op', binding)).toEqual({ status: 'admitted', result: null })
    expect(() => second.reserve('op', 'e'.repeat(64), request, cases)).toThrow()
    expect(() => second.reserve('op', binding, 'e'.repeat(64), cases)).toThrow()
  } finally { first.close(); second.close() }
  const reopened = new ReplayJournal(f.path)
  try { expect(reopened.reserve('op', binding, request, cases)).toBe(false) } finally { reopened.close() }
})

test('completion is immutable, validates pinned request/cases, and survives reopen', () => {
  const f = fixture(), journal = new ReplayJournal(f.path), observed = result()
  try {
    journal.reserve('op', binding, request, cases)
    expect(() => journal.complete('op', binding, { ...observed, requestDigest: 'f'.repeat(64) })).toThrow()
    expect(() => journal.complete('op', binding, { ...observed, caseDigest: 'f'.repeat(64) })).toThrow()
    journal.complete('op', binding, observed); journal.complete('op', binding, observed)
    expect(() => journal.complete('op', binding, { ...observed, sessionId: 'other' })).toThrow()
    observed.sessionId = 'mutated'
    expect(journal.get('op', binding)?.result?.sessionId).toBe('fixture')
  } finally { journal.close() }
  const reopened = new ReplayJournal(f.path)
  try { expect(reopened.get('op', binding)?.result?.sessionId).toBe('fixture') } finally { reopened.close() }
})

function createV1(path: string, completed = false): void {
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE replay_operations (
    operation_id TEXT PRIMARY KEY, binding_digest TEXT NOT NULL, request_digest TEXT NOT NULL, case_digest TEXT NOT NULL,
    result_json TEXT, result_digest TEXT,
    CHECK((result_json IS NULL AND result_digest IS NULL) OR (json_valid(result_json) AND length(result_digest) = 64))
  ) STRICT, WITHOUT ROWID;
  PRAGMA application_id = 1146311248; PRAGMA user_version = 1;`)
  const observed = result()
  db.prepare('INSERT INTO replay_operations(operation_id, binding_digest, request_digest, case_digest, result_json, result_digest) VALUES (?, ?, ?, ?, ?, ?)')
    .run('op', binding, request, cases, completed ? JSON.stringify(observed) : null, completed ? runtimeConfigDigest(observed) : null)
  db.close()
}

test('migrates v1 unknown and completed fixed rows without granting signed admission', () => {
  for (const completed of [false, true]) {
    const f = fixture(); createV1(f.path, completed); chmodSync(f.path, 0o600)
    const journal = new ReplayJournal(f.path)
    try {
      expect(journal.get('op', binding)?.status).toBe(completed ? 'completed' : 'admitted')
      expect(() => journal.get('op', binding, signed)).toThrow()
      expect(() => journal.reserve('op', binding, request, cases, signed)).toThrow()
      expect(() => journal.reserve('op', binding, request, cases)).not.toThrow()
    } finally { journal.close() }
    const raw = new DatabaseSync(f.path)
    try { expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2) } finally { raw.close() }
  }
})

test('signed scope binds exactly one grant and operation across SQLite connections', () => {
  const f = fixture(), first = new ReplayJournal(f.path), second = new ReplayJournal(f.path)
  const other = { scopeDigest: 'f'.repeat(64), grantDigest: grant }
  try {
    expect(first.get('missing', binding, signed)).toBeUndefined()
    expect(first.reserve('op', binding, request, cases, signed)).toBe(true)
    expect(second.reserve('op', binding, request, cases, signed)).toBe(false)
    expect(second.get('op', binding, signed)).toEqual({ status: 'admitted', result: null })
    expect(() => second.get('op', binding)).toThrow()
    expect(() => second.get('missing', binding, signed)).toThrow()
    expect(() => second.get('op', binding, { scopeDigest: scope, grantDigest: 'f'.repeat(64) })).toThrow()
    expect(() => second.reserve('other', binding, request, cases, signed)).toThrow()
    expect(() => second.reserve('op', binding, request, cases, other)).toThrow()
    expect(() => second.reserve('other', binding, request, cases, signed)).toThrow()
  } finally { first.close(); second.close() }
})

test('signed unknown and completed operations survive reopen', () => {
  const f = fixture(), first = new ReplayJournal(f.path)
  try {
    expect(first.reserve('op', binding, request, cases, signed)).toBe(true)
  } finally { first.close() }
  const admitted = new ReplayJournal(f.path)
  try {
    expect(admitted.get('op', binding, signed)).toEqual({ status: 'admitted', result: null })
    admitted.complete('op', binding, result())
  } finally { admitted.close() }
  const completed = new ReplayJournal(f.path)
  try {
    expect(completed.get('op', binding, signed)?.status).toBe('completed')
    expect(() => completed.get('op', binding)).toThrow()
  } finally { completed.close() }
})

test('rejects foreign databases and untrusted filesystem identities', () => {
  const f = fixture()
  const foreign = new DatabaseSync(f.path); foreign.exec('CREATE TABLE other(x)'); foreign.close(); chmodSync(f.path, 0o600)
  expect(() => new ReplayJournal(f.path)).toThrow()
  rmSync(f.path)
  writeFileSync(join(f.root, 'target'), '', { mode: 0o600 }); symlinkSync(join(f.root, 'target'), f.path)
  expect(() => new ReplayJournal(f.path)).toThrow(); rmSync(f.path)
  linkSync(join(f.root, 'target'), f.path)
  expect(() => new ReplayJournal(f.path)).toThrow(); rmSync(f.path)
  writeFileSync(f.path, '', { mode: 0o644 })
  expect(() => new ReplayJournal(f.path)).toThrow()
})

test('rejects journal replacement, unsafe sidecars and corrupt completed payload', () => {
  const f = fixture(), journal = new ReplayJournal(f.path)
  journal.reserve('op', binding, request, cases)
  journal.complete('op', binding, result())
  const raw = new DatabaseSync(f.path)
  raw.prepare('UPDATE replay_operations SET result_json = ? WHERE operation_id = ?').run('{"x":1}', 'op')
  expect(() => journal.get('op', binding)).toThrow()
  raw.close()
  chmodSync(f.path + '-wal', 0o644)
  expect(() => journal.reserve('second', binding, request, cases)).toThrow()
  chmodSync(f.path + '-wal', 0o600)
  renameSync(f.path, f.path + '.old'); writeFileSync(f.path, '', { mode: 0o600 })
  expect(() => journal.get('op', binding)).toThrow()
  journal.close()
})

test('rejects accessor payload before evaluation or completion', () => {
  const f = fixture(), journal = new ReplayJournal(f.path)
  let invoked = false
  try {
    journal.reserve('op', binding, request, cases)
    const observed = result()
    Object.defineProperty(observed, 'sessionId', { enumerable: true, get() { invoked = true; return 'bad' } })
    expect(() => journal.complete('op', binding, observed)).toThrow()
    expect(invoked).toBe(false)
    expect(journal.get('op', binding)?.status).toBe('admitted')
  } finally { journal.close() }
})

test('rejects accessor authorization before evaluating a digest getter', () => {
  const f = fixture(), journal = new ReplayJournal(f.path)
  let invoked = false
  const malicious = Object.defineProperties({}, {
    scopeDigest: { enumerable: true, get() { invoked = true; return scope } },
    grantDigest: { enumerable: true, value: grant },
  })
  try {
    expect(() => journal.get('op', binding, malicious as never)).toThrow()
    expect(() => journal.reserve('op', binding, request, cases, malicious as never)).toThrow()
    expect(invoked).toBe(false)
  } finally { journal.close() }
})
