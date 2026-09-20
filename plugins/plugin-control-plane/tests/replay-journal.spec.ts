import { chmodSync, linkSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test as nativeTest } from 'vitest'
import { ReplayJournal } from '../src/replay-journal.js'
import type { EffectBlockedReplayResult } from '../src/effect-blocked-replay.js'
import { replayRuntimeDigest } from '../src/effect-blocked-replay.js'

const test = nativeTest.skipIf(process.platform !== 'linux')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'replay-journal-')); roots.push(root)
  chmodSync(root, 0o700)
  return { root, path: join(root, 'replay.sqlite') }
}
const binding = 'b'.repeat(64), request = 'a'.repeat(64), cases = 'c'.repeat(64)
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
