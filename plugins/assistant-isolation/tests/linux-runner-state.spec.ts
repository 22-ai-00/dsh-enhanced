import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { defaultLimits } from '../src/config.js'
import { IsolationLedger } from '../src/ledger.js'
import { LinuxRepositoryRunner } from '../src/linux-repository-runner.js'
import type { LinuxRuntime } from '../src/linux-runtime.js'
import { inspectLinuxRunnerState, prepareLinuxRunnerState, validateLinuxRunnerStateSeal } from '../src/linux-runner-state.js'
import { LinuxVerifierRunner } from '../src/linux-verifier-runner.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(kind: 'repository' | 'verification' = 'verification') {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-linux-runner-state-')); roots.push(parent)
  chmodSync(parent, 0o700)
  const stateRoot = join(parent, 'runner'), seals = join(parent, 'seals'), sealPath = join(seals, 'runner.json')
  for (const path of [stateRoot, seals]) mkdirSync(path, { mode: 0o700 })
  const input = { stateRoot, sealPath, kind }
  return { parent, ledgerPath: join(stateRoot, 'ledger.sqlite'), ...input, input }
}
const digest = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
function snapshot(path: string): unknown[] {
  const rows: unknown[] = []
  const visit = (path: string): void => {
    const info = lstatSync(path, { bigint: true })
    rows.push([path, String(info.dev), String(info.ino), String(info.mode), String(info.size),
      String(info.mtimeNs), String(info.ctimeNs), info.isFile() ? digest(readFileSync(path)) : undefined])
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name))
  }
  visit(path); return rows
}
function inspect(f: ReturnType<typeof fixture>, stateSeal: ReturnType<typeof prepareLinuxRunnerState>): void {
  inspectLinuxRunnerState({ stateRoot: f.stateRoot, kind: f.kind, stateSeal })
}
function readonly(path: string): DatabaseSync { return new DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true }) }
const identity = { principalDigest: 'owner', principalRecordId: 'owner-record', principalVersion: 1,
  workspace: '/workspace', agentPreset: 'primary' }
function usedLedger(path: string): { jobId: string } {
  const ledger = new IsolationLedger(path, { now: () => 10_000 })
  try {
    ledger.syncGrants([{ ...identity, id: 'finite', revision: 1, expiresAt: 100_000, maxRuns: 1, maxTotalDurationMs: 500 }])
    const job = ledger.prepare({ identity, sessionId: 'session', grantId: 'finite', idempotencyKey: 'unknown-key',
      requestDigest: 'original-request', durationMs: 500 }).job
    ledger.settle(job.id, job.version, { jobId: job.id, status: 'unknown', quiescent: false,
      stdout: '', stderr: '', artifacts: [] })
    return { jobId: job.id }
  } finally { ledger.close() }
}
function runtime(parent: string): LinuxRuntime {
  const root = join(parent, 'runtime')
  return { schemaVersion: 1, backend: 'linux-native', platform: `linux-${process.arch}` as LinuxRuntime['platform'],
    sourceCommit: 'a'.repeat(40), lockSha256: 'b'.repeat(64), root: { path: root, dev: 1, ino: 2, sha256: 'c'.repeat(64) },
    nodePath: join(root, 'bin/node'), nodeSha256: 'd'.repeat(64), pnpmPath: join(root, 'pnpm/bin/pnpm.mjs'),
    nativePnpmPath: join(root, 'pnpm-native/pnpm'), nativePnpmRoot: join(root, 'pnpm-native'),
    modulesPath: join(root, 'node_modules'), storePath: join(root, 'store'), cachePath: join(root, 'cache'),
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '1', cordis: '1', tools: '1', systemPrompt: '1' } }
}
function cgroups() {
  const leaf = (controller: string): string => `/sys/fs/cgroup/${controller}/dsh-native/uid-${process.getuid!()}`
  return { mode: 'v1' as const, cpu: leaf('cpu,cpuacct'), memory: leaf('memory'), pids: leaf('pids'), freezer: leaf('freezer') }
}

describe.runIf(process.platform === 'linux' && (process.getuid?.() ?? 0) > 0)('fixed native runner ledger references', () => {
  test('prepares a real empty schema once and repeated inspection writes no files or metadata', () => {
    const f = fixture(), ref = prepareLinuxRunnerState(f.input), before = snapshot(f.parent)
    inspect(f, ref)
    expect(prepareLinuxRunnerState(f.input)).toEqual(ref)
    expect(snapshot(f.parent)).toEqual(before)
    expect(readdirSync(f.stateRoot)).toEqual(['ledger.sqlite'])
    const db = readonly(f.ledgerPath)
    try {
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(8)
      for (const table of ['isolation_grants', 'isolation_jobs', 'isolation_controller', 'isolation_audit'])
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0)
    } finally { db.close() }
    expect(snapshot(f.parent)).toEqual(before)
  })

  test('initial-only preparation reuses a complete empty seal without changing its reference or inode', () => {
    const f = fixture(), input = { ...f.input, requireEmpty: true }, ref = prepareLinuxRunnerState(input)
    const before = snapshot(f.parent)
    expect(prepareLinuxRunnerState(input)).toEqual(ref)
    inspect(f, ref)
    expect(snapshot(f.parent)).toEqual(before)
  })

  test.each(['grant', 'controller', 'unknown', 'audit', 'deleted-history'] as const)(
    'initial-only preparation rejects sealed %s history without modifying it', kind => {
      const f = fixture(), ref = prepareLinuxRunnerState(f.input)
      if (kind === 'unknown' || kind === 'deleted-history') usedLedger(f.ledgerPath)
      else if (kind === 'audit') {
        const db = new DatabaseSync(f.ledgerPath)
        db.prepare('INSERT INTO isolation_audit(occurred_at,action,detail) VALUES (?,?,?)').run(10_000, 'retained-history', 'original')
        db.close()
      } else {
        const ledger = new IsolationLedger(f.ledgerPath, { now: () => 10_000 })
        if (kind === 'grant') ledger.syncGrants([{ ...identity, id: 'finite', revision: 1, expiresAt: 100_000, maxRuns: 1, maxTotalDurationMs: 500 }])
        else ledger.claimController('old-controller', 1_000)
        ledger.close()
      }
      if (kind === 'deleted-history') {
        const db = new DatabaseSync(f.ledgerPath)
        db.exec('DELETE FROM isolation_jobs;DELETE FROM isolation_grants;DELETE FROM isolation_audit;DELETE FROM isolation_controller'); db.close()
      }
      const before = snapshot(f.parent)
      expect(() => prepareLinuxRunnerState({ ...f.input, requireEmpty: true })).toThrow(/authority|history/u)
      expect(snapshot(f.parent)).toEqual(before)
      // Ordinary recovery still verifies and reuses this exact existing state.
      expect(prepareLinuxRunnerState(f.input)).toEqual(ref)
      expect(snapshot(f.parent)).toEqual(before)
    })

  test.each(['wal-residue', 'shm-residue', 'live-wal'] as const)(
    'initial-only preparation rejects sealed %s without trusting an immutable empty view', kind => {
      const f = fixture(), ref = prepareLinuxRunnerState(f.input)
      let writer: DatabaseSync | undefined
      try {
        if (kind === 'live-wal') {
          writer = new DatabaseSync(f.ledgerPath)
          writer.exec('PRAGMA wal_autocheckpoint=0')
          writer.prepare('INSERT INTO isolation_audit(occurred_at,action,detail) VALUES (?,?,?)').run(10_000, 'live-history', 'uncheckpointed')
          const checkpoint = readonly(f.ledgerPath)
          try { expect(checkpoint.prepare('SELECT COUNT(*) AS n FROM isolation_audit').get()?.n).toBe(0) }
          finally { checkpoint.close() }
        } else writeFileSync(f.ledgerPath + (kind === 'wal-residue' ? '-wal' : '-shm'), 'retained', { mode: 0o600 })
        const before = snapshot(f.parent)
        expect(() => prepareLinuxRunnerState({ ...f.input, requireEmpty: true })).toThrow('WAL state requires reconciliation')
        expect(snapshot(f.parent)).toEqual(before)
        inspect(f, ref)
        expect(snapshot(f.parent)).toEqual(before)
      } finally { writer?.close() }
    })

  test('keeps unknown identity, reserved duration and exhausted run allowance on reopen', () => {
    const f = fixture(), ref = prepareLinuxRunnerState(f.input), { jobId } = usedLedger(f.ledgerPath)
    const before = snapshot(f.parent)
    inspect(f, ref); expect(prepareLinuxRunnerState(f.input)).toEqual(ref)
    expect(snapshot(f.parent)).toEqual(before)
    const ledger = new IsolationLedger(f.ledgerPath, { now: () => 10_000 })
    try {
      expect(ledger.get(jobId)).toMatchObject({ id: jobId, status: 'unknown', reservedDurationMs: 500,
        result: { status: 'unknown', quiescent: false } })
      expect(ledger.prepare({ identity, sessionId: 'session', grantId: 'finite', idempotencyKey: 'unknown-key',
        requestDigest: 'original-request', durationMs: 500 })).toMatchObject({ created: false, job: { id: jobId } })
      expect(() => ledger.prepare({ identity, sessionId: 'session', grantId: 'finite', idempotencyKey: 'new-key',
        requestDigest: 'new-request', durationMs: 500 })).toThrow()
      expect(ledger.recoverable()).toHaveLength(1)
    } finally { ledger.close() }
  })

  test.each(['ledger', 'root', 'seal'] as const)('missing %s is rejected without reconstructing anything', kind => {
    const f = fixture(), ref = prepareLinuxRunnerState(f.input)
    const path = kind === 'ledger' ? f.ledgerPath : kind === 'root' ? f.stateRoot : f.sealPath
    rmSync(path, { recursive: true })
    const before = snapshot(f.parent)
    expect(() => inspect(f, ref)).toThrow()
    if (kind !== 'seal') expect(() => prepareLinuxRunnerState(f.input)).toThrow()
    expect(snapshot(f.parent)).toEqual(before); expect(existsSync(path)).toBe(false)
  })

  test.each(['ledger', 'root', 'seal'] as const)('replacement of %s cannot reuse the original reference', kind => {
    const f = fixture(), ref = prepareLinuxRunnerState(f.input)
    if (kind === 'ledger') { copyFileSync(f.ledgerPath, f.ledgerPath + '.new'); renameSync(f.ledgerPath + '.new', f.ledgerPath) }
    else if (kind === 'root') { renameSync(f.stateRoot, f.stateRoot + '-old'); mkdirSync(f.stateRoot, { mode: 0o700 }); copyFileSync(join(f.stateRoot + '-old', 'ledger.sqlite'), f.ledgerPath) }
    else {
      const body = JSON.parse(readFileSync(f.sealPath, 'utf8')); body.id = '00000000-0000-4000-8000-000000000000'
      writeFileSync(f.sealPath, JSON.stringify(body), { mode: 0o600 })
    }
    const before = snapshot(f.parent)
    expect(() => inspect(f, ref)).toThrow()
    expect(snapshot(f.parent)).toEqual(before)
  })

  test('an interrupted initialization may bind only a complete empty database without changing its inode', () => {
    const f = fixture(), db = new IsolationLedger(f.ledgerPath); db.close()
    const before = lstatSync(f.ledgerPath), ref = prepareLinuxRunnerState(f.input)
    expect(lstatSync(f.ledgerPath).ino).toBe(before.ino); inspect(f, ref)
  })

  test('rejects changed purpose, reference digest and fixed schema before writing', () => {
    const f = fixture(), ref = prepareLinuxRunnerState(f.input)
    expect(() => inspectLinuxRunnerState({ stateRoot: f.stateRoot, stateSeal: ref, kind: 'repository' })).toThrow('purpose')
    expect(() => inspect(f, { ...ref, sha256: '0'.repeat(64) })).toThrow('reference')
    const db = new DatabaseSync(f.ledgerPath)
    db.exec('ALTER TABLE isolation_jobs ADD COLUMN foreign_data TEXT'); db.close()
    const before = snapshot(f.parent)
    expect(() => inspect(f, ref)).toThrow(/schema|columns/u)
    expect(snapshot(f.parent)).toEqual(before)
  })

  test.each(['empty-file', 'partial-schema', 'wal', 'partial-seal'] as const)('retains %s initialization residue for reconciliation', kind => {
    const f = fixture()
    if (kind === 'empty-file') writeFileSync(f.ledgerPath, '', { mode: 0o600 })
    if (kind === 'partial-schema') {
      const db = new DatabaseSync(f.ledgerPath); db.exec('PRAGMA user_version=8;CREATE TABLE schema_meta(key,value)'); db.close(); chmodSync(f.ledgerPath, 0o600)
    }
    if (kind === 'wal') { const db = new IsolationLedger(f.ledgerPath); db.close(); writeFileSync(f.ledgerPath + '-wal', 'unreconciled', { mode: 0o600 }) }
    if (kind === 'partial-seal') writeFileSync(f.sealPath, '{', { mode: 0o600 })
    const before = snapshot(f.parent)
    expect(() => prepareLinuxRunnerState(f.input)).toThrow()
    expect(snapshot(f.parent)).toEqual(before)
  })

  test.each(['grant', 'controller', 'unknown', 'deleted-history'] as const)('will not attach a new seal to unsealed %s state', kind => {
    const f = fixture()
    if (kind === 'unknown' || kind === 'deleted-history') usedLedger(f.ledgerPath)
    else {
      const ledger = new IsolationLedger(f.ledgerPath, { now: () => 10_000 })
      if (kind === 'grant') ledger.syncGrants([{ ...identity, id: 'finite', revision: 1, expiresAt: 100_000, maxRuns: 1, maxTotalDurationMs: 500 }])
      else ledger.claimController('old-controller', 1_000)
      ledger.close()
    }
    if (kind === 'deleted-history') {
      const db = new DatabaseSync(f.ledgerPath)
      db.exec('DELETE FROM isolation_jobs;DELETE FROM isolation_grants;DELETE FROM isolation_audit;DELETE FROM isolation_controller'); db.close()
    }
    const before = snapshot(f.parent)
    expect(() => prepareLinuxRunnerState(f.input)).toThrow(/authority|history/u)
    expect(existsSync(f.sealPath)).toBe(false); expect(snapshot(f.parent)).toEqual(before)
  })

  test.each(['ledger-symlink', 'ledger-hardlink', 'seal-symlink', 'seal-hardlink', 'wal-symlink', 'shm-hardlink', 'root-mode'] as const)(
    'rejects %s without changing evidence', kind => {
      const f = fixture(), ref = prepareLinuxRunnerState(f.input)
      if (kind === 'root-mode') chmodSync(f.stateRoot, 0o755)
      else if (kind === 'wal-symlink' || kind === 'shm-hardlink') {
        const target = join(f.parent, 'foreign-file'); writeFileSync(target, 'unchanged', { mode: 0o600 })
        if (kind === 'wal-symlink') symlinkSync(target, f.ledgerPath + '-wal')
        else linkSync(target, f.ledgerPath + '-shm')
      }
      else {
        const path = kind.startsWith('ledger') ? f.ledgerPath : f.sealPath, target = path + '-original'
        renameSync(path, target)
        if (kind.endsWith('symlink')) symlinkSync(target, path)
        else linkSync(target, path)
      }
      expect(() => inspect(f, ref)).toThrow()
    })

  test('validates only plain reference data without filesystem access', () => {
    const value = { path: '/does/not/exist.json', sha256: 'a'.repeat(64) }
    expect(validateLinuxRunnerStateSeal(Object.freeze(value))).toEqual(value)
    for (const invalid of [{ ...value, extra: true }, { ...value, path: '/a/../b' }, { ...value, sha256: 'short' },
      { get path() { throw new Error('getter executed') }, sha256: value.sha256 }])
      expect(() => validateLinuxRunnerStateSeal(invalid)).toThrow('invalid seal reference')
  })

  test.each(['repository', 'verification'] as const)('strict %s constructor rejects a missing ledger before creating execution state', kind => {
    const f = fixture(kind), ref = prepareLinuxRunnerState(f.input)
    rmSync(f.stateRoot, { recursive: true }); const before = snapshot(f.parent)
    const common = { backend: 'linux-native' as const, stateRoot: f.stateRoot, stateSeal: ref,
      authorityDigest: 'a'.repeat(64), expiresAt: Date.now() + 60_000, maxRuns: 1, maxTotalDurationMs: 60_000,
      runtime: runtime(f.parent), cgroupRoots: cgroups() }
    expect(() => kind === 'repository'
      ? new LinuxRepositoryRunner({ ...common, limits: { ...defaultLimits, maxDurationMs: 5000,
        tmpMiB: 32, tmpInodes: 256, inputMiB: 65, inputInodes: 16 } })
      : new LinuxVerifierRunner({ ...common, command: '/bin/true', maxDurationMs: 5000, maxOutputBytes: 4096 }))
      .toThrow()
    expect(snapshot(f.parent)).toEqual(before); expect(existsSync(f.stateRoot)).toBe(false)
  })

  test.each(['repository', 'verification'] as const)('a live %s runner stops admission when its frozen seal disappears', async kind => {
    const f = fixture(kind), ref = prepareLinuxRunnerState(f.input)
    const common = { backend: 'linux-native' as const, stateRoot: f.stateRoot, stateSeal: ref,
      authorityDigest: 'a'.repeat(64), expiresAt: Date.now() + 60_000, maxRuns: 1, maxTotalDurationMs: 60_000,
      runtime: runtime(f.parent), cgroupRoots: cgroups() }
    const value = kind === 'repository'
      ? new LinuxRepositoryRunner({ ...common, limits: { ...defaultLimits, maxDurationMs: 5000,
        tmpMiB: 32, tmpInodes: 256, inputMiB: 65, inputInodes: 16 } })
      : new LinuxVerifierRunner({ ...common, command: '/bin/true', maxDurationMs: 5000, maxOutputBytes: 4096 })
    let archiveReads = 0
    try {
      await Promise.resolve()
      rmSync(f.sealPath)
      await expect(value instanceof LinuxRepositoryRunner
        ? value.run('blocked', { argv: ['/bin/true'], archive: { bytes: 1, sha256: 'b'.repeat(64) }, artifacts: [] },
          async () => { archiveReads++; return new Uint8Array([1]) }, new AbortController().signal)
        : value.run('blocked', 'candidate', '', new AbortController().signal)).rejects.toThrow()
    } finally { await value.close() }
    expect(archiveReads).toBe(0); expect(existsSync(f.sealPath)).toBe(false)
    const db = readonly(f.ledgerPath)
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM isolation_jobs').get()?.n).toBe(0)
      expect(db.prepare('SELECT max_runs,max_total_duration_ms FROM isolation_grants').get())
        .toMatchObject({ max_runs: 1, max_total_duration_ms: 60_000 })
    } finally { db.close() }
  })
})
