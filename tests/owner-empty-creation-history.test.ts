import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import * as yaml from 'yaml'
import { afterEach, expect, test, vi } from 'vitest'
import { CreationCapabilityJournal, creationCapabilityAuthorityDigest, creationCapabilityPublicKey } from '../plugins/plugin-control-plane/src/creation-capability-journal.ts'
import type { CreationCapabilityConfig } from '../plugins/plugin-control-plane/src/creation-capability-types.ts'
import { CreationReviewStore } from '../plugins/assistant-verifier/src/creation-review-store.ts'
import { inspectOwnerCreationHistory, inspectOwnerEmptyCreationHistory, staleRunnerImageConfig } from '../scripts/install/owner-empty-creation-history.mjs'
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'empty-owner-test-'))); roots.push(home)
  const stateRoot = join(home, 'rsi-authorities', 'owner', 'state'), statePath = join(stateRoot, 'control-plane')
  fs.mkdirSync(statePath, { recursive: true, mode: 0o700 }); fs.mkdirSync(join(home, 'assistant-verifier'), { mode: 0o700 })
  const keyPath = join(home, 'adoption.key'), keys = generateKeyPairSync('ed25519')
  fs.writeFileSync(keyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const config: CreationCapabilityConfig = { authorityId: 'owner-adoption', keyId: 'owner-key', keyPath,
    owner: { authorityId: 'owner', authorityHash: 'a'.repeat(64), principalId: 'channel/account/tenant/user',
      principalRecordId: 'record-1', principalVersion: 1, workspace: home, agentPreset: 'default' },
    namePrefix: 'generated-', expiresAt: Date.now() + 120000, maxAdoptions: 2, maxTools: 2,
    maxCallsPerAdoption: 3, maxCallRecords: 3, maxInputBytes: 1024,
    runner: { stateRoot: join(stateRoot, 'creation-adoption-runner'), image: `runner@sha256:${'b'.repeat(64)}`, dockerPath: '/usr/bin/docker',
      expiresAt: Date.now() + 120000, maxRuns: 5, maxTotalDurationMs: 30000, maxDurationMs: 10000, maxOutputBytes: 65536 } }
  fs.mkdirSync(config.runner.stateRoot, { recursive: true, mode: 0o700 })
  const reviewConfig = { authorityId: 'creation-review', keyId: 'review-key', keyPath, owner: config.owner,
    namePrefix: 'generated-', expiresAt: config.expiresAt, maxVerifications: 2, runner: config.runner,
    policy: 'owner approved', maxInputBytes: 4096, maxOutputTokens: 1024, maxDurationMs: 60000, maxCases: 2, receiptTtlMs: 60000 }
  const review = join(home, 'assistant-verifier', 'verification.sqlite.creation-reviews')
  new CreationReviewStore(review).close()
  const adoption = join(statePath, 'creation-adoptions.sqlite')
  new CreationCapabilityJournal({ path: adoption, config }).close()
  const manifest = { sourceReviews: { authorityId: 'source-review' }, pluginCreation: { reviews: reviewConfig, capabilities: config },
    controlPlane: { statePath, creationCapabilities: config } }
  const verifier = { databasePath: join(home, 'assistant-verifier', 'verification.sqlite'), sourceReviews: manifest.sourceReviews, creationReviews: reviewConfig }
  const rows = [{ id: 'dsh-enhanced-assistant-verifier', config: verifier }, { id: 'dsh-enhanced-plugin-control-plane', config: manifest.controlPlane }]
  const ownerUpdate = { homePath: home, profile: 'owner', original: { resources: { installationId: 'install-1', stateRoot }, manifest,
    effective: { targetEffective: yaml.stringify(rows) } } }
  const api = { yaml, control: { creationCapabilityAuthorityDigest, creationCapabilityPublicKey } }
  return { home, statePath, stateRoot, config, review, adoption, manifest, verifier, rows, ownerUpdate, api }
}
function sql(file: string, statement: string) { const db = new DatabaseSync(file); try { db.exec(statement) } finally { db.close() } }
function observe(file: string) { const stat = fs.statSync(file, { bigint: true }); return { sha: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), ino: String(stat.ino), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs), entries: fs.readdirSync(join(file, '..')).sort() } }
const inspect = (f: ReturnType<typeof fixture>) => inspectOwnerEmptyCreationHistory({ ownerUpdate: f.ownerUpdate, api: f.api })

test('real legacy stores: only private copies queried, exact authority/config checked, source unchanged and output redacted', async () => {
  const f = fixture(), before = [observe(f.review), observe(f.adoption)]
  const queried: string[] = [], prepare = DatabaseSync.prototype.prepare
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function(this: DatabaseSync, query: string) {
    queried.push(this.location() ?? ':memory:'); return prepare.call(this, query)
  })
  const result = await inspect(f)
  expect(queried.length).toBeGreaterThan(0)
  expect(queried.every(path => path === ':memory:' || path.includes('/owner-empty-history-'))).toBe(true)
  expect(result.status).toBe('empty'); expect(result.reviews.map(r => r.status)).toEqual(['empty', 'disabled', 'disabled'])
  expect(result.adoption.counts).toEqual({ authority: 1, adoptions: 0, calls: 0, sourceArchives: 0 })
  expect(result.adoption.logicalPath).toBe(f.adoption)
  expect([observe(f.review), observe(f.adoption)]).toEqual(before)
  const rendered = JSON.stringify(result)
  expect(rendered).not.toContain('BEGIN PUBLIC KEY'); expect(rendered).not.toContain('config_json'); expect(rendered).not.toContain('cases')
})
test('strict dshHomePath literal is supported without evaluation and staging keeps logical digest/path', async () => {
  const f = fixture()
  f.ownerUpdate.original.effective.targetEffective = yaml.stringify(f.rows).replace(`databasePath: ${f.verifier.databasePath}`, `databasePath: !!js "dshHomePath('assistant-verifier/verification.sqlite')"`)
  const live = await inspect(f), stage = join(f.home, 'stage')
  fs.mkdirSync(stage, { mode: 0o700 }); fs.cpSync(join(f.home, 'assistant-verifier'), join(stage, 'assistant-verifier'), { recursive: true }); fs.cpSync(join(f.home, 'rsi-authorities'), join(stage, 'rsi-authorities'), { recursive: true })
  const privateDirs = (path: string) => { fs.chmodSync(path, 0o700); for (const name of fs.readdirSync(path)) { const child = join(path, name); if (fs.statSync(child).isDirectory()) privateDirs(child) } }; privateDirs(stage)
  const copied = await inspectOwnerEmptyCreationHistory({ ownerUpdate: f.ownerUpdate, physicalHome: stage, api: f.api })
  expect(copied.adoption.logicalPath).toBe(f.adoption); expect(copied.adoption.storageDigest).toBe(live.adoption.storageDigest)
  expect(copied.digest).not.toBe(live.digest)
})
test('committed WAL-only nonempty history is seen without touching source main/WAL/SHM', async () => {
  const f = fixture(), db = new DatabaseSync(f.review)
  try {
    db.exec("PRAGMA journal_mode=WAL; INSERT INTO grants VALUES('authority','digest',2,1)")
    const files = [f.review, `${f.review}-wal`, `${f.review}-shm`], before = files.map(observe)
    await expect(inspect(f)).rejects.toThrow('review-history-present')
    expect(files.map(observe)).toEqual(before)
  } finally { db.close() }
})
test.each(['missing-review', 'missing-adoption', 'journal', 'orphan', 'symlink', 'hardlink', 'schema', 'shadow'])('refuses %s', async condition => {
  const f = fixture()
  if (condition === 'missing-review') fs.unlinkSync(f.review)
  if (condition === 'missing-adoption') fs.unlinkSync(f.adoption)
  if (condition === 'journal') fs.writeFileSync(f.review + '-journal', '', { mode: 0o600 })
  if (condition === 'orphan') fs.writeFileSync(f.review + '-wal', '', { mode: 0o600 })
  if (condition === 'symlink') { fs.renameSync(f.review, f.review + '.real'); fs.symlinkSync(f.review + '.real', f.review) }
  if (condition === 'hardlink') fs.linkSync(f.review, f.review + '.link')
  if (condition === 'schema') sql(f.review, 'PRAGMA user_version=1')
  if (condition === 'shadow') sql(f.review, 'CREATE TABLE sqliteXshadow(value TEXT)')
  await expect(inspect(f)).rejects.toThrow()
})
test.each(['source', 'review', 'capability', 'path', 'duplicate', 'expression'])('refuses authenticated-layout %s mismatch', async field => {
  const f = fixture()
  if (field === 'source') f.verifier.sourceReviews = { authorityId: 'other' }
  if (field === 'review') f.verifier.creationReviews = { ...f.verifier.creationReviews, maxVerifications: 3 }
  if (field === 'capability') f.rows[1]!.config = { ...f.manifest.controlPlane, creationCapabilities: { ...f.config, maxAdoptions: 3 } } as never
  if (field === 'path') f.rows[1]!.config = { ...f.manifest.controlPlane, statePath: f.home } as never
  if (field === 'duplicate') f.rows.push(f.rows[0]!)
  f.ownerUpdate.original.effective.targetEffective = yaml.stringify(f.rows)
  if (field === 'expression') f.ownerUpdate.original.effective.targetEffective = f.ownerUpdate.original.effective.targetEffective.replace(`databasePath: ${f.verifier.databasePath}`, 'databasePath: !!js "process.exit()"')
  await expect(inspect(f)).rejects.toThrow()
})
test.each(['owner', 'key', 'config-nul', 'key-nul', 'schema'])('adoption %s mismatch rejects full actual authority', async field => {
  const f = fixture()
  if (field === 'owner') sql(f.adoption, "UPDATE authority SET authority_id='other-owner'")
  if (field === 'key') fs.writeFileSync(f.config.keyPath, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }))
  if (field === 'config-nul') sql(f.adoption, "PRAGMA ignore_check_constraints=ON; UPDATE authority SET config_json=config_json||char(0)||'hidden'")
  if (field === 'key-nul') sql(f.adoption, "UPDATE authority SET public_key=public_key||char(0)||'hidden'")
  if (field === 'schema') sql(f.adoption, 'CREATE TABLE foreign_table(id INTEGER)')
  await expect(inspect(f)).rejects.toThrow()
})
test.each(['source-bytes', 'source-replace', 'sidecar-appear', 'parent-swap'])('copy-time %s race rejects and preserves source', async race => {
  const f = fixture(), ino = fs.statSync(f.review).ino, original = fs.readSync; let injected = false
  vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, ...args: unknown[]) => {
    const result = Reflect.apply(original, fs, [fd, ...args])
    if (!injected && fs.fstatSync(fd).ino === ino) {
      injected = true
      if (race === 'source-bytes') sql(f.review, 'PRAGMA user_version=2')
      if (race === 'source-replace') { fs.renameSync(f.review, f.review + '.saved'); fs.copyFileSync(f.review + '.saved', f.review) }
      if (race === 'sidecar-appear') fs.writeFileSync(f.review + '-shm', '', { mode: 0o600 })
      if (race === 'parent-swap') { fs.renameSync(join(f.home, 'assistant-verifier'), join(f.home, 'assistant-verifier-old')); fs.mkdirSync(join(f.home, 'assistant-verifier'), { mode: 0o700 }) }
    }
    return result
  }) as typeof fs.readSync)
  await expect(inspect(f)).rejects.toThrow(); expect(injected).toBe(true)
})

test('committed empty WAL is accepted using copies and source main/WAL/SHM remain unchanged', async () => {
  const f = fixture(), db = new DatabaseSync(f.review)
  try {
    db.exec("PRAGMA journal_mode=WAL; BEGIN; INSERT INTO grants VALUES('temporary','digest',1,0); DELETE FROM grants; COMMIT")
    const paths = [f.review, f.review + '-wal', f.review + '-shm'], before = paths.map(observe)
    const result = await inspect(f)
    expect(result.reviews[0]!.status).toBe('empty'); expect(result.reviews[0]!.sidecars!.wal).not.toBeNull()
    expect(paths.map(observe)).toEqual(before)
  } finally { db.close() }
})
test.each(['claimed', 'unknown', 'rejected', 'closed'])('adoption %s business record is never empty', async status => {
  const f = fixture()
  sql(f.adoption, `PRAGMA ignore_check_constraints=ON; INSERT INTO adoptions(plan_id,status,certificate_json,certificate_digest,artifact,artifact_sha,reason) VALUES('plan','${status}','{}','${'a'.repeat(64)}',X'01','${'b'.repeat(64)}',${status === 'claimed' ? 'NULL' : "'uncertain'"})`)
  await expect(inspect(f)).rejects.toThrow('adoption-history-present')
})
test.each(['calls', 'source_archives'])('adoption %s rows refuse even if an invalid orphan would hide business history', async table => {
  const f = fixture()
  if (table === 'calls') sql(f.adoption, `PRAGMA foreign_keys=OFF; INSERT INTO calls(plan_id,call_key,arguments_digest,status) VALUES('missing','call','${'a'.repeat(64)}','unknown')`)
  else sql(f.adoption, "PRAGMA foreign_keys=OFF; INSERT INTO source_archives VALUES('missing','{}')")
  await expect(inspect(f)).rejects.toThrow()
})
test('all three configured review lanes must independently be present and empty', async () => {
  const f = fixture(), revision = { reviews: f.verifier.creationReviews, regressions: f.verifier.creationReviews }
  Object.assign(f.manifest, { pluginRevision: revision })
  Object.assign(f.verifier, { revisionReviews: revision.reviews, revisionRegressions: revision.regressions })
  f.ownerUpdate.original.effective.targetEffective = yaml.stringify(f.rows)
  const revisionPath = f.review.replace('creation-reviews', 'revision-reviews'), regressionPath = f.review.replace('creation-reviews', 'revision-regressions')
  new CreationReviewStore(revisionPath).close(); new CreationReviewStore(regressionPath).close()
  expect((await inspect(f)).reviews.map(r => r.status)).toEqual(['empty', 'empty', 'empty'])
  sql(regressionPath, "INSERT INTO verifications VALUES('old','digest','owner','unknown','{}')")
  await expect(inspect(f)).rejects.toThrow('review-history-present')
})
test.each(['drop-shm', 'truncate-wal'])('sidecar %s during private read refuses', async race => {
  const f = fixture(), db = new DatabaseSync(f.review)
  db.exec("PRAGMA journal_mode=WAL; INSERT INTO grants VALUES('a','digest',1,0); DELETE FROM grants")
  const ino = fs.statSync(f.review).ino, original = fs.readSync; let changed = false
  vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, ...args: unknown[]) => {
    const result = Reflect.apply(original, fs, [fd, ...args])
    if (!changed && fs.fstatSync(fd).ino === ino) {
      changed = true
      if (race === 'drop-shm') fs.unlinkSync(f.review + '-shm')
      else fs.truncateSync(f.review + '-wal', 0)
    }
    return result
  }) as typeof fs.readSync)
  try { await expect(inspect(f)).rejects.toThrow(); expect(changed).toBe(true) } finally { db.close() }
})
test('source mutation after SQLite query still refuses before returning an empty proof', async () => {
  const f = fixture(), prepare = DatabaseSync.prototype.prepare; let changed = false
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function(this: DatabaseSync, query: string) {
    if (!changed && this.location()?.includes('/owner-empty-history-') && query.includes('COUNT(*) AS n FROM grants')) {
      changed = true; sql(f.review, "INSERT INTO grants VALUES('late','digest',1,0)")
    }
    return prepare.call(this, query)
  })
  await expect(inspect(f)).rejects.toThrow(); expect(changed).toBe(true)
})
test('private copy parent replacement refuses and never removes the replacement directory', async () => {
  const f = fixture(), original = fs.openSync; let replacement: string | undefined
  vi.spyOn(fs, 'openSync').mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
    const text = String(path)
    if (!replacement && text.includes('/owner-empty-history-') && text.endsWith('/snapshot.sqlite')) {
      replacement = join(text, '..')
      fs.renameSync(replacement, replacement + '.saved'); roots.push(replacement + '.saved')
      fs.mkdirSync(replacement, { mode: 0o700 }); roots.push(replacement)
    }
    return Reflect.apply(original, fs, [path, ...args])
  }) as typeof fs.openSync)
  await expect(inspect(f)).rejects.toThrow('copy-parent-race'); expect(replacement).toBeDefined(); expect(fs.existsSync(replacement!)).toBe(true)
})

test('initial sidecar lstat EACCES closes every previously pinned parent descriptor', async () => {
  const f = fixture(), open = fs.openSync, lstat = fs.lstatSync, pinned: number[] = []
  vi.spyOn(fs, 'openSync').mockImplementation(((path: fs.PathLike, flags: number, ...args: unknown[]) => {
    const fd = Reflect.apply(open, fs, [path, flags, ...args])
    if (flags & fs.constants.O_DIRECTORY) pinned.push(fd)
    return fd
  }) as typeof fs.openSync)
  vi.spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
    if (String(path) === f.review + '-wal') throw Object.assign(new Error('injected sidecar EACCES'), { code: 'EACCES' })
    return Reflect.apply(lstat, fs, [path, ...args])
  }) as typeof fs.lstatSync)
  await expect(inspect(f)).rejects.toThrow('injected sidecar EACCES')
  expect(pinned.length).toBeGreaterThanOrEqual(2)
  for (const fd of pinned) expect(() => fs.fstatSync(fd)).toThrow('EBADF')
})

function staleJournal(f: ReturnType<typeof fixture>, change: (runner: CreationCapabilityConfig['runner']) => CreationCapabilityConfig['runner']) {
  const stale = { ...f.config, runner: change({ ...f.config.runner }) }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${f.adoption}${suffix}`, { force: true })
  new CreationCapabilityJournal({ path: f.adoption, config: stale }).close()
  return stale
}
test('empty journal whose authority predates a runner.image re-pin is carried from the stored row', async () => {
  const f = fixture(), stale = staleJournal(f, runner => ({ ...runner, image: `runner@sha256:${'c'.repeat(64)}` }))
  for (const result of [await inspect(f), await inspectOwnerCreationHistory({ ownerUpdate: f.ownerUpdate, api: f.api })]) {
    expect(result.status).toBe('empty')
    expect(result.adoption.staleConfig).toEqual(stale)
    expect(result.adoption.authorityDigest).toBe(creationCapabilityAuthorityDigest({ path: f.adoption, config: stale }))
    expect(result.adoption.authorityDigest).not.toBe(creationCapabilityAuthorityDigest({ path: f.adoption, config: f.config }))
  }
  expect((await inspect(fixture())).adoption).not.toHaveProperty('staleConfig')
})
test('stale authority rows refuse unless only runner.image differs, the digest is derived and history is empty', async () => {
  for (const change of [(runner: CreationCapabilityConfig['runner']) => ({ ...runner, image: 'other@sha256:' + 'd'.repeat(64), maxRuns: 6 }),
    (runner: CreationCapabilityConfig['runner']) => ({ ...runner, dockerPath: '/opt/docker' })]) {
    const f = fixture(); staleJournal(f, change)
    await expect(inspect(f)).rejects.toThrow('adoption-authority-mismatch')
  }
  const forged = fixture(); staleJournal(forged, runner => ({ ...runner, image: `runner@sha256:${'f'.repeat(64)}` }))
  sql(forged.adoption, `UPDATE authority SET authority_digest='${'e'.repeat(64)}'`)
  await expect(inspect(forged)).rejects.toThrow('adoption-authority-mismatch')
  const used = fixture(); staleJournal(used, runner => ({ ...runner, image: `runner@sha256:${'f'.repeat(64)}` }))
  sql(used.adoption, `INSERT INTO adoptions(plan_id,status,certificate_json,certificate_digest,artifact,artifact_sha) VALUES('p','claimed','{}','${'a'.repeat(64)}',X'01','${'b'.repeat(64)}')`)
  await expect(inspectOwnerCreationHistory({ ownerUpdate: used.ownerUpdate, api: used.api })).rejects.toThrow('adoption-authority-mismatch')
  const config = fixture().config, text = (value: unknown) => JSON.stringify(value, Object.keys(value as object).sort())
  expect(staleRunnerImageConfig('{', config)).toBeUndefined()
  expect(staleRunnerImageConfig(' {}', config)).toBeUndefined()
  expect(staleRunnerImageConfig(text({ a: 1 }), config)).toBeUndefined()
})
