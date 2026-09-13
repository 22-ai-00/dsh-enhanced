import { createHash } from 'node:crypto'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { archiveIsolationAudit, IsolationAuditArchiveError, verifyIsolationAuditArchive } from '../src/audit-archive.ts'
import { IsolationLedger } from '../src/ledger.ts'
import type { IsolationGrant, IsolationIdentity } from '../src/types.ts'

const roots: string[] = []
const cli = fileURLToPath(new URL('../lib/cli.js', import.meta.url))
const execFileAsync = promisify(execFile)
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const identity: IsolationIdentity = { principalDigest: 'a'.repeat(64), principalRecordId: 'record', principalVersion: 1, workspace: '/work', agentPreset: 'default' }
const grant: IsolationGrant = { ...identity, id: 'grant', revision: 1, expiresAt: 100_000, maxRuns: 20, maxTotalDurationMs: 20_000 }
function privateRoot(label: string): string { const root = realpathSync(mkdtempSync(join(tmpdir(), `${label}-`))); chmodSync(root, 0o700); roots.push(root); return root }
function prepare(stateRoot: string, count = 1): IsolationLedger {
  const ledger = new IsolationLedger(join(stateRoot, 'ledger.sqlite'), { now: () => 10_000 }); ledger.syncGrants([grant])
  for (let index = 0; index < count; index += 1) ledger.prepare({ identity, sessionId: 'session', grantId: 'grant', idempotencyKey: `key-${index}`, requestDigest: `digest-${index}`, durationMs: 500 })
  return ledger
}
function archiveFiles(directory: string): string[] { return readdirSync(directory).filter(name => /^isolation-audit-v1-[a-f0-9]{64}\.ndjson$/u.test(name)).sort() }
function error(run: () => unknown): IsolationAuditArchiveError { try { run() } catch (caught) { expect(caught).toBeInstanceOf(IsolationAuditArchiveError); return caught as IsolationAuditArchiveError }; throw new Error('expected archive error') }
function rewriteArchive(directory: string, name: string, transform: (lines: string[]) => string[]): string {
  const path = join(directory, name); const lines = readFileSync(path, 'utf8').trimEnd().split('\n'); const content = `${transform(lines).join('\n')}\n`; const digest = createHash('sha256').update(content).digest('hex'); const next = `isolation-audit-v1-${digest}.ndjson`; writeFileSync(join(directory, next), content, { mode: 0o600 }); rmSync(path); return next
}

describe('isolation audit archive', () => {
  it('archives a real nonempty file-backed ledger in canonical linked batches and is idempotent', () => {
    const stateRoot = privateRoot('audit-state'); const archiveDirectory = privateRoot('audit-archive'); const ledger = prepare(stateRoot, 4)
    const databasePath = join(stateRoot, 'ledger.sqlite'); const beforeDatabase = readFileSync(databasePath)
    const beforeRows = new DatabaseSync(databasePath, { readOnly: true }); const sourceBefore = beforeRows.prepare("SELECT (SELECT COUNT(*) FROM isolation_audit) AS audit, (SELECT COUNT(*) FROM isolation_jobs) AS jobs, (SELECT COUNT(*) FROM isolation_grants) AS grants, (SELECT COUNT(*) FROM isolation_controller) AS controller, (SELECT value FROM schema_meta WHERE key='schema-version') AS schema_version, (SELECT user_version FROM pragma_user_version) AS user_version").get(); beforeRows.close()
    const result = archiveIsolationAudit({ stateRoot, archiveDirectory, batchSize: 2 })
    expect(result.createdFiles).toHaveLength(3); expect(result.createdRecords).toBe(5)
    expect(result.verification).toMatchObject({ valid: true, fileCount: 3, recordCount: 5, highestSequence: 5, snapshotThroughSequence: 5 })
    expect(result.verification.archiveInstanceId).toMatch(/^[0-9a-f-]{36}$/u); expect(result.verification.headDigest).toMatch(/^[a-f0-9]{64}$/u)
    for (const name of archiveFiles(archiveDirectory)) {
      const content = readFileSync(join(archiveDirectory, name), 'utf8'); expect(content.endsWith('\n')).toBe(true)
      expect(createHash('sha256').update(content).digest('hex')).toBe(name.slice('isolation-audit-v1-'.length, -'.ndjson'.length))
      for (const line of content.trimEnd().split('\n')) expect(JSON.stringify(JSON.parse(line), Object.keys(JSON.parse(line)).sort())).toBe(line)
      expect(lstatSync(join(archiveDirectory, name)).mode & 0o777).toBe(0o600)
    }
    expect(archiveIsolationAudit({ stateRoot, archiveDirectory, batchSize: 2 })).toMatchObject({ createdFiles: [], createdRecords: 0, verification: result.verification })
    expect(verifyIsolationAuditArchive(archiveDirectory)).toEqual(result.verification)
    expect(readFileSync(databasePath)).toEqual(beforeDatabase)
    const afterRows = new DatabaseSync(databasePath, { readOnly: true }); expect(afterRows.prepare("SELECT (SELECT COUNT(*) FROM isolation_audit) AS audit, (SELECT COUNT(*) FROM isolation_jobs) AS jobs, (SELECT COUNT(*) FROM isolation_grants) AS grants, (SELECT COUNT(*) FROM isolation_controller) AS controller, (SELECT value FROM schema_meta WHERE key='schema-version') AS schema_version, (SELECT user_version FROM pragma_user_version) AS user_version").get()).toEqual(sourceBefore); afterRows.close()
    ledger.close()
  })

  it('creates a single empty genesis with a durable random instance identity', () => {
    const stateRoot = privateRoot('empty-state'); const archiveDirectory = privateRoot('empty-archive'); const ledger = new IsolationLedger(join(stateRoot, 'ledger.sqlite')); ledger.close()
    const result = archiveIsolationAudit({ stateRoot, archiveDirectory })
    expect(result).toMatchObject({ createdRecords: 0, verification: { fileCount: 1, recordCount: 0, highestSequence: 0, snapshotThroughSequence: 0 } })
    expect(result.verification.archiveInstanceId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(archiveIsolationAudit({ stateRoot, archiveDirectory })).toMatchObject({ createdFiles: [], verification: { archiveInstanceId: result.verification.archiveInstanceId } })
  })

  it('rejects an uninitialized or control-only directory as publicly unverifiable', () => {
    const empty = privateRoot('uninitialized-archive'); expect(error(() => verifyIsolationAuditArchive(empty)).code).toBe('invalid-archive')
    const stateRoot = privateRoot('control-only-state'); const archiveDirectory = privateRoot('control-only-archive'); const ledger = new IsolationLedger(join(stateRoot, 'ledger.sqlite')); ledger.close()
    archiveIsolationAudit({ stateRoot, archiveDirectory }); rmSync(join(archiveDirectory, archiveFiles(archiveDirectory)[0]!))
    expect(error(() => verifyIsolationAuditArchive(archiveDirectory)).code).toBe('invalid-archive')
  })

  it('captures one WAL snapshot high-water while a writer remains open', () => {
    const stateRoot = privateRoot('wal-state'); const archiveDirectory = privateRoot('wal-archive'); const writer = prepare(stateRoot, 2)
    const result = archiveIsolationAudit({ stateRoot, archiveDirectory, batchSize: 1 })
    expect(result.verification).toMatchObject({ highestSequence: 3, snapshotThroughSequence: 3 })
    writer.prepare({ identity, sessionId: 'session', grantId: 'grant', idempotencyKey: 'later', requestDigest: 'later', durationMs: 500 })
    expect(verifyIsolationAuditArchive(archiveDirectory)).toMatchObject({ highestSequence: 3 })
    expect(archiveIsolationAudit({ stateRoot, archiveDirectory, batchSize: 1 }).verification).toMatchObject({ highestSequence: 4 })
    writer.close()
  })

  it('round-trips a schema-valid structured detail larger than 16384 characters', () => {
    const stateRoot = privateRoot('long-detail-state'); const archiveDirectory = privateRoot('long-detail-archive'); const ledger = prepare(stateRoot, 0); ledger.close()
    const longDetail = JSON.stringify({ kind: 'reconciliation', observations: Array.from({ length: 600 }, (_, index) => ({ index, outcome: 'verified', evidence: 'x'.repeat(32) })) })
    expect(longDetail.length).toBeGreaterThan(16_384)
    const database = new DatabaseSync(join(stateRoot, 'ledger.sqlite')); database.prepare("INSERT INTO isolation_audit(occurred_at, action, job_id, grant_id, detail) VALUES (10001, 'reconciliation-observed', NULL, NULL, ?)").run(longDetail); database.close()
    const archived = archiveIsolationAudit({ stateRoot, archiveDirectory, batchSize: 1 })
    expect(archived.verification).toMatchObject({ highestSequence: 2, recordCount: 2 })
    const detail = archiveFiles(archiveDirectory).flatMap(name => readFileSync(join(archiveDirectory, name), 'utf8').trimEnd().split('\n').slice(1).map(line => (JSON.parse(line) as { detail: string }).detail)).find(value => value === longDetail)
    expect(detail).toBe(longDetail); expect(JSON.parse(detail!)).toMatchObject({ kind: 'reconciliation', observations: expect.any(Array) })
    expect(verifyIsolationAuditArchive(archiveDirectory)).toEqual(archived.verification)
  })

  it('holds the control lock across four processes and re-reads a source that advances while they wait', async () => {
    const stateRoot = privateRoot('stagger-state'); const archiveDirectory = privateRoot('stagger-archive'); const writer = prepare(stateRoot, 0)
    expect(archiveIsolationAudit({ stateRoot, archiveDirectory, batchSize: 1 }).verification.highestSequence).toBe(1)
    const control = new DatabaseSync(join(archiveDirectory, '.archive-control.sqlite'))
    control.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;')
    const arguments_ = [cli, 'archive-audit', stateRoot, archiveDirectory, '1']
    const options = { encoding: 'utf8' as const, timeout: 10_000, maxBuffer: 64 * 1024, env: { ...process.env, NODE_NO_WARNINGS: '1' } }
    const waiting = Array.from({ length: 4 }, async () => await execFileAsync(process.execPath, arguments_, options))
    await new Promise(resolve => setTimeout(resolve, 100))
    for (let index = 0; index < 3; index += 1) writer.prepare({ identity, sessionId: 'stagger', grantId: 'grant', idempotencyKey: `stagger-${index}`, requestDigest: `stagger-${index}`, durationMs: 500 })
    control.exec('COMMIT'); control.close(); writer.close()
    const completed = await Promise.all(waiting)
    expect(completed.map(result => (JSON.parse(result.stdout) as { createdRecords: number }).createdRecords).sort((left, right) => left - right)).toEqual([0, 0, 0, 3])
    expect(completed.every(result => result.stderr === '')).toBe(true)
    expect(verifyIsolationAuditArchive(archiveDirectory)).toMatchObject({ fileCount: 4, recordCount: 4, highestSequence: 4, snapshotThroughSequence: 4 })
  })

  it('rejects a source sequence gap and a conflicting source prefix', () => {
    const stateRoot = privateRoot('bad-source'); const archiveDirectory = privateRoot('bad-source-archive'); const ledger = prepare(stateRoot, 1); ledger.close()
    archiveIsolationAudit({ stateRoot, archiveDirectory })
    const database = new DatabaseSync(join(stateRoot, 'ledger.sqlite')); database.prepare("UPDATE isolation_audit SET detail='replaced' WHERE sequence=1").run(); database.close()
    expect(error(() => archiveIsolationAudit({ stateRoot, archiveDirectory })).code).toBe('conflict')
    const gapRoot = privateRoot('gap-source'); const gapArchive = privateRoot('gap-archive'); const gap = prepare(gapRoot, 1); gap.close()
    const gapDatabase = new DatabaseSync(join(gapRoot, 'ledger.sqlite')); gapDatabase.prepare('DELETE FROM isolation_audit WHERE sequence=1').run(); gapDatabase.close()
    expect(error(() => archiveIsolationAudit({ stateRoot: gapRoot, archiveDirectory: gapArchive })).code).toBe('invalid-source')
  })

  it('does not initialize or bind a fresh archive for a missing or unsupported source', () => {
    const archiveDirectory = privateRoot('preflight-archive'); const missingRoot = privateRoot('missing-source')
    expect(error(() => archiveIsolationAudit({ stateRoot: missingRoot, archiveDirectory })).code).toBe('invalid-source')
    expect(readdirSync(archiveDirectory)).toEqual([])
    const unsupportedRoot = privateRoot('unsupported-source'); const file = join(unsupportedRoot, 'ledger.sqlite'); const database = new DatabaseSync(file)
    database.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; INSERT INTO schema_meta VALUES ('schema-version','5'); PRAGMA user_version=5;"); database.close(); chmodSync(file, 0o600)
    expect(error(() => archiveIsolationAudit({ stateRoot: unsupportedRoot, archiveDirectory })).code).toBe('invalid-source')
    expect(readdirSync(archiveDirectory)).toEqual([])
  })

  it('binds the archive to one canonical source root even when another ledger has the same prefix', () => {
    const firstRoot = privateRoot('bound-state-a'); const secondRoot = privateRoot('bound-state-b'); const archiveDirectory = privateRoot('bound-archive')
    const first = prepare(firstRoot, 1); first.close(); const second = prepare(secondRoot, 1); second.close()
    const initial = archiveIsolationAudit({ stateRoot: firstRoot, archiveDirectory })
    expect(initial.verification.sourceStateRootDigest).toBe(createHash('sha256').update(firstRoot).digest('hex'))
    expect(error(() => archiveIsolationAudit({ stateRoot: secondRoot, archiveDirectory })).code).toBe('conflict')
  })

  it('rejects incomplete tails, tampering, truncation, noncanonical lines, and bad previous links', () => {
    for (const kind of ['tail', 'tamper', 'truncate', 'noncanonical', 'previous'] as const) {
      const stateRoot = privateRoot(`state-${kind}`); const archiveDirectory = privateRoot(`archive-${kind}`); const ledger = prepare(stateRoot, 3); ledger.close()
      archiveIsolationAudit({ stateRoot, archiveDirectory, batchSize: 1 }); const files = archiveFiles(archiveDirectory)
      if (kind === 'tail') rmSync(join(archiveDirectory, files.at(-1)!))
      if (kind === 'tamper') writeFileSync(join(archiveDirectory, files[0]!), `${readFileSync(join(archiveDirectory, files[0]!), 'utf8')} `)
      if (kind === 'truncate') writeFileSync(join(archiveDirectory, files[0]!), readFileSync(join(archiveDirectory, files[0]!), 'utf8').slice(0, -1))
      if (kind === 'noncanonical') rewriteArchive(archiveDirectory, files[0]!, lines => [` ${lines[0]}`, ...lines.slice(1)])
      if (kind === 'previous') rewriteArchive(archiveDirectory, files[1]!, lines => { const manifest = JSON.parse(lines[0]!) as Record<string, unknown>; manifest.previousDigest = 'b'.repeat(64); return [JSON.stringify(manifest, Object.keys(manifest).sort()), ...lines.slice(1)] })
      expect(() => verifyIsolationAuditArchive(archiveDirectory), kind).toThrow(IsolationAuditArchiveError)
    }
  })

  it('rejects reordered or duplicate manifests and mixed archive instance identities', () => {
    for (const kind of ['sequence', 'fork', 'instance'] as const) {
      const stateRoot = privateRoot(`state-${kind}`); const archiveDirectory = privateRoot(`archive-${kind}`); const ledger = prepare(stateRoot, 2); ledger.close()
      archiveIsolationAudit({ stateRoot, archiveDirectory, batchSize: 1 }); const files = archiveFiles(archiveDirectory)
      if (kind === 'sequence') rewriteArchive(archiveDirectory, files.at(-1)!, lines => { const record = JSON.parse(lines[1]!) as Record<string, unknown>; record.sequence = Number(record.sequence) + 1; return [lines[0]!, JSON.stringify(record, Object.keys(record).sort())] })
      if (kind === 'fork') rewriteArchive(archiveDirectory, files.at(-1)!, lines => { const manifest = JSON.parse(lines[0]!) as Record<string, unknown>; manifest.previousDigest = JSON.parse(readFileSync(join(archiveDirectory, files[0]!), 'utf8').split('\n')[0]!).previousDigest; return [JSON.stringify(manifest, Object.keys(manifest).sort()), ...lines.slice(1)] })
      if (kind === 'instance') rewriteArchive(archiveDirectory, files.at(-1)!, lines => { const manifest = JSON.parse(lines[0]!) as Record<string, unknown>; manifest.archiveInstanceId = '00000000-0000-4000-8000-000000000001'; return [JSON.stringify(manifest, Object.keys(manifest).sort()), ...lines.slice(1)] })
      expect(() => verifyIsolationAuditArchive(archiveDirectory), kind).toThrow(IsolationAuditArchiveError)
    }
  })

  it('rejects unsafe paths, unknown files, and unsafe archive file metadata', () => {
    const stateRoot = privateRoot('safe-state'); const archiveDirectory = privateRoot('safe-archive'); const ledger = prepare(stateRoot); ledger.close(); archiveIsolationAudit({ stateRoot, archiveDirectory })
    expect(error(() => archiveIsolationAudit({ stateRoot, archiveDirectory: stateRoot })).code).toBe('invalid-path')
    const child = join(stateRoot, 'child'); mkdirSync(child, { mode: 0o700 })
    expect(error(() => archiveIsolationAudit({ stateRoot, archiveDirectory: child })).code).toBe('invalid-path')
    writeFileSync(join(archiveDirectory, 'unknown'), '', { mode: 0o600 }); expect(error(() => verifyIsolationAuditArchive(archiveDirectory)).code).toBe('invalid-archive'); rmSync(join(archiveDirectory, 'unknown'))
    const file = archiveFiles(archiveDirectory)[0]!; chmodSync(join(archiveDirectory, file), 0o644); expect(error(() => verifyIsolationAuditArchive(archiveDirectory)).code).toBe('invalid-archive'); chmodSync(join(archiveDirectory, file), 0o600)
    const hardlink = join(archiveDirectory, 'copy'); linkSync(join(archiveDirectory, file), hardlink); expect(error(() => verifyIsolationAuditArchive(archiveDirectory)).code).toBe('invalid-archive'); rmSync(hardlink)
    const target = join(archiveDirectory, file); const real = `${target}.real`; renameSync(target, real); symlinkSync(real, target); expect(error(() => verifyIsolationAuditArchive(archiveDirectory)).code).toBe('invalid-archive')
  })

  it('recovers the exact link-before-unlink crash residue under the control lock', () => {
    const stateRoot = privateRoot('recovery-state'); const archiveDirectory = privateRoot('recovery-archive'); const ledger = prepare(stateRoot); ledger.close()
    archiveIsolationAudit({ stateRoot, archiveDirectory }); const file = archiveFiles(archiveDirectory)[0]!; const digest = file.slice('isolation-audit-v1-'.length, -'.ndjson'.length)
    const temporary = join(archiveDirectory, `.isolation-audit-v1-${digest}.${process.pid}.00000000-0000-4000-8000-000000000001.tmp`)
    linkSync(join(archiveDirectory, file), temporary); expect(lstatSync(join(archiveDirectory, file)).nlink).toBe(2)
    const result = archiveIsolationAudit({ stateRoot, archiveDirectory })
    expect(existsSync(temporary)).toBe(false); expect(lstatSync(join(archiveDirectory, file)).nlink).toBe(1); expect(result.createdFiles).toEqual([])
  })

  it('resumes a partial multi-batch snapshot without changing the archived prefix', () => {
    const stateRoot = privateRoot('partial-state'); const archiveDirectory = privateRoot('partial-archive'); const ledger = prepare(stateRoot, 4); ledger.close()
    archiveIsolationAudit({ stateRoot, archiveDirectory, batchSize: 2 })
    const files = archiveFiles(archiveDirectory); const manifests = new Map(files.map(name => [name, JSON.parse(readFileSync(join(archiveDirectory, name), 'utf8').split('\n')[0]!) as { previousDigest: string | null }]))
    const referenced = new Set([...manifests.values()].map(manifest => manifest.previousDigest).filter((value): value is string => value !== null))
    const head = files.find(name => !referenced.has(name.slice('isolation-audit-v1-'.length, -'.ndjson'.length)))!
    const prefixBytes = new Map(files.filter(name => name !== head).map(name => [name, readFileSync(join(archiveDirectory, name))]))
    rmSync(join(archiveDirectory, head)); expect(() => verifyIsolationAuditArchive(archiveDirectory)).toThrow(/incomplete snapshot tail/u)
    const resumed = archiveIsolationAudit({ stateRoot, archiveDirectory, batchSize: 2 })
    expect(resumed.createdRecords).toBe(1); expect(resumed.verification.highestSequence).toBe(5)
    for (const [name, bytes] of prefixBytes) expect(readFileSync(join(archiveDirectory, name))).toEqual(bytes)
  })

  it('rejects symlinked, hardlinked, broad-mode, and noncanonical source or archive paths', () => {
    const stateRoot = privateRoot('metadata-state'); const archiveDirectory = privateRoot('metadata-archive'); const ledger = prepare(stateRoot); ledger.close()
    chmodSync(stateRoot, 0o755); expect(error(() => archiveIsolationAudit({ stateRoot, archiveDirectory })).code).toBe('invalid-path'); chmodSync(stateRoot, 0o700)
    chmodSync(join(stateRoot, 'ledger.sqlite'), 0o644); expect(error(() => archiveIsolationAudit({ stateRoot, archiveDirectory })).code).toBe('invalid-source'); chmodSync(join(stateRoot, 'ledger.sqlite'), 0o600)
    const linkedLedgerRoot = privateRoot('linked-ledger'); const linkedArchive = privateRoot('linked-archive'); linkSync(join(stateRoot, 'ledger.sqlite'), join(linkedLedgerRoot, 'ledger.sqlite')); expect(error(() => archiveIsolationAudit({ stateRoot: linkedLedgerRoot, archiveDirectory: linkedArchive })).code).toBe('invalid-source'); rmSync(join(linkedLedgerRoot, 'ledger.sqlite'))
    symlinkSync(join(stateRoot, 'ledger.sqlite'), join(linkedLedgerRoot, 'ledger.sqlite')); expect(error(() => archiveIsolationAudit({ stateRoot: linkedLedgerRoot, archiveDirectory: linkedArchive })).code).toBe('invalid-source')
    const actualArchive = privateRoot('actual-archive'); const archiveLink = join(privateRoot('archive-link-parent'), 'link'); symlinkSync(actualArchive, archiveLink); expect(error(() => verifyIsolationAuditArchive(archiveLink)).code).toBe('invalid-path')
    chmodSync(actualArchive, 0o755); expect(error(() => verifyIsolationAuditArchive(actualArchive)).code).toBe('invalid-path')
  })
})
