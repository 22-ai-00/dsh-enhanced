#!/usr/bin/env node
import { constants, openSync, closeSync, fstatSync, readFileSync, lstatSync, realpathSync, chmodSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { StringDecoder } from 'node:string_decoder'
import { HoldoutAuthority, type AuthorityOptions, type QualificationBinding, type CellObservation } from './holdout-authority.js'
import { createProspectiveCertificate, generateProspectiveDataset, generatorDigest, type ProspectiveHoldoutCertificate } from './prospective-holdout.js'

function privateParent(path: string): void {
  if (!isAbsolute(path) || realpathSync(dirname(path)) !== dirname(path)) throw new Error('private-path-required')
  const parent = lstatSync(dirname(path))
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) throw new Error('private-directory-required')
}
function privateRead(path: string, limit: number): string {
  privateParent(path)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > limit) throw new Error('private-file-required')
    const data = readFileSync(fd)
    if (data.byteLength > limit) throw new Error('input-too-large')
    return data.toString('utf8')
  } finally { closeSync(fd) }
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
interface ProspectiveRecord { readonly phase: 'frozen' | 'generated' | 'complete'; readonly freezeId: string; readonly binding: QualificationBinding; readonly dataset?: AuthorityOptions['dataset']; readonly certificate?: ProspectiveHoldoutCertificate }

/** Private operator process. Its stdin belongs to a trusted executor, never a model tool. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length !== 2 || !['--config', '--inspect-config'].includes(argv[0]!) || typeof process.getuid !== 'function') throw new Error('usage: dsh-skill-holdout --config|--inspect-config /private/config.json')
  const config: unknown = JSON.parse(privateRead(argv[1]!, 16384))
  const hasDataset = object(config) && Object.hasOwn(config, 'datasetPath'), hasProspective = object(config) && Object.hasOwn(config, 'prospective')
  if (!object(config) || Object.keys(config).some(key => !['datasetPath', 'prospective', 'privateKeyPath', 'statePath', 'limits'].includes(key))
    || !['privateKeyPath', 'statePath'].every(key => typeof config[key] === 'string') || !object(config.limits)
    || hasDataset === hasProspective || hasDataset && typeof config.datasetPath !== 'string'
    || hasProspective && (!object(config.prospective) || Object.keys(config.prospective).length !== 1 || config.prospective.generator !== 'order-summary/v1')) throw new Error('invalid-operator-config')
  const privateKey = privateRead(config.privateKeyPath as string, 16384), prospective = hasProspective
  const fixedOptions = (): AuthorityOptions => ({ dataset: JSON.parse(privateRead(config.datasetPath as string, 262144)), privateKey, limits: config.limits as unknown as AuthorityOptions['limits'] })
  if (argv[0] === '--inspect-config') {
    if (prospective) { const publicKey = HoldoutAuthority.create({ dataset: { id: 'inspect', version: '1', cases: [{ id: 'r', kind: 'replay', stdin: '', expectedStdout: '', expectedExitCode: 0 }, { id: 'e', kind: 'evaluation', stdin: '', expectedStdout: '', expectedExitCode: 0 }, { id: 'g', kind: 'regression', stdin: '', expectedStdout: '', expectedExitCode: 0 }] }, privateKey, limits: config.limits as unknown as AuthorityOptions['limits'] }).metadata().publicKey; process.stdout.write(JSON.stringify({ publicKey, generatorDigest, limits: config.limits }) + '\n'); return }
    process.stdout.write(JSON.stringify(HoldoutAuthority.create(fixedOptions()).metadata()) + '\n'); return
  }
  const path = config.statePath as string
  privateParent(path)
  process.umask(0o077)
  try { const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); closeSync(fd) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; privateRead(path, 4194304) }
  const db = new DatabaseSync(path); chmodSync(path, 0o600)
  db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS authority (id INTEGER PRIMARY KEY CHECK(id=1), controller TEXT NOT NULL, lease_until INTEGER NOT NULL, state TEXT, prospective TEXT) STRICT')
  if (!(db.prepare("SELECT 1 FROM pragma_table_info('authority') WHERE name='prospective'").get())) db.exec('ALTER TABLE authority ADD COLUMN prospective TEXT')
  const controller = randomUUID(), leaseMs = 8000
  let authority: HoldoutAuthority | undefined, active = false, timer: ReturnType<typeof setInterval> | undefined
  const transaction = <T>(operation: () => T): T => { db.exec('BEGIN IMMEDIATE'); try { const value = operation(); db.exec('COMMIT'); return value } catch (error) { db.exec('ROLLBACK'); throw error } }
  const persist = () => {
    if (!authority) throw new Error('authority-not-begun')
    const result = db.prepare('UPDATE authority SET state=?, lease_until=? WHERE id=1 AND controller=? AND lease_until>?').run(authority.serialize(), Date.now() + leaseMs, controller, Date.now())
    if (result.changes !== 1) throw new Error('authority-controller-lost')
  }
  const beginProspective = (binding: QualificationBinding): unknown => {
    if (authority) throw new Error('authority-already-begun')
    const freezeId = randomUUID()
    transaction(() => {
      const result = db.prepare('UPDATE authority SET prospective=? WHERE id=1 AND controller=? AND lease_until>?').run(JSON.stringify({ phase: 'frozen', freezeId, binding } satisfies ProspectiveRecord), controller, Date.now())
      if (result.changes !== 1) throw new Error('authority-controller-lost')
    })
    const dataset = generateProspectiveDataset(), certificate = createProspectiveCertificate(binding, dataset, privateKey, freezeId)
    return transaction(() => {
      const result = db.prepare('UPDATE authority SET prospective=? WHERE id=1 AND controller=? AND lease_until>?').run(JSON.stringify({ phase: 'generated', freezeId, binding, dataset, certificate } satisfies ProspectiveRecord), controller, Date.now())
      if (result.changes !== 1) throw new Error('authority-controller-lost')
      authority = HoldoutAuthority.create({ dataset, privateKey, limits: config.limits as unknown as AuthorityOptions['limits'], prospective: certificate })
      const begun = authority.begin(binding)
      const completed = db.prepare('UPDATE authority SET state=?, prospective=?, lease_until=? WHERE id=1 AND controller=? AND lease_until>?').run(authority.serialize(), JSON.stringify({ phase: 'complete', freezeId, binding, dataset, certificate } satisfies ProspectiveRecord), Date.now() + leaseMs, controller, Date.now())
      if (completed.changes !== 1) throw new Error('authority-controller-lost')
      return begun
    })
  }
  try {
    transaction(() => {
      const row = db.prepare('SELECT * FROM authority WHERE id=1').get() as { controller: string; lease_until: number; state: string | null; prospective: string | null } | undefined
      if (row && row.lease_until > Date.now()) throw new Error('authority-controller-busy')
      if (row && (row.state !== null || row.prospective !== null) && Boolean(row.prospective) !== prospective) throw new Error('authority-mode-changed')
      if (prospective) {
        if (row?.prospective) {
          const record = JSON.parse(row.prospective) as ProspectiveRecord
          if (record.phase !== 'complete' || !row.state || !record.dataset || !record.certificate) throw new Error('prospective-authority-poisoned')
          authority = HoldoutAuthority.restore(row.state, { dataset: record.dataset, privateKey, limits: config.limits as unknown as AuthorityOptions['limits'], prospective: record.certificate })
        }
      } else authority = row?.state ? HoldoutAuthority.restore(row.state, fixedOptions()) : HoldoutAuthority.create(fixedOptions())
      db.prepare('INSERT INTO authority (id,controller,lease_until,state,prospective) VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET controller=excluded.controller,lease_until=excluded.lease_until,state=excluded.state,prospective=excluded.prospective').run(controller, Date.now() + leaseMs, authority?.serialize() ?? null, row?.prospective ?? null)
    })
    active = true
    timer = setInterval(() => {
      try { if (db.prepare('UPDATE authority SET lease_until=? WHERE id=1 AND controller=? AND lease_until>?').run(Date.now() + leaseMs, controller, Date.now()).changes !== 1) active = false } catch { active = false }
    }, 2000)
    timer.unref()
    process.stdout.write(JSON.stringify({ event: 'ready', protocol: 'assistant-skills/holdout-ipc/v1' }) + '\n')
    let buffer = ''
    const decoder = new StringDecoder('utf8')
    for await (const chunk of process.stdin) {
      buffer += Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk)
      if (Buffer.byteLength(buffer) > 1048576) throw new Error('request-too-large')
      let offset: number
      while ((offset = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, offset); buffer = buffer.slice(offset + 1)
        let id: string | null = null
        try {
          const request: unknown = JSON.parse(line)
          if (!active || !object(request) || typeof request.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(request.id)
            || Object.keys(request).some(key => !['id', 'operation', 'value'].includes(key))) throw new Error('invalid-request')
          id = request.id
          const value = request.operation === 'begin' && prospective && !authority ? beginProspective(request.value as QualificationBinding) : transaction(() => {
            const row = db.prepare('SELECT controller,lease_until FROM authority WHERE id=1').get() as { controller: string; lease_until: number }
            if (row.controller !== controller || row.lease_until <= Date.now()) throw new Error('authority-controller-lost')
            let result: unknown
            if (request.operation === 'begin' && authority) result = authority.begin(request.value as QualificationBinding)
            else if (request.operation === 'next' && request.value === undefined && authority) result = authority.next() ?? null
            else if (request.operation === 'record' && authority) result = authority.record(request.value as CellObservation)
            else if (request.operation === 'finish' && request.value === undefined && authority) result = authority.finish()
            else throw new Error('invalid-operation')
            persist(); return result
          })
          process.stdout.write(JSON.stringify({ id, ok: true, value }) + '\n')
        } catch {
          // Failed operations may have stopped a plan; persist that conservative state.
          try { transaction(persist) } catch { active = false }
          process.stdout.write(JSON.stringify({ id, ok: false, error: 'holdout-request-rejected' }) + '\n')
          if (!active) throw new Error('authority-controller-lost')
        }
      }
    }
    if ((buffer + decoder.end()).trim()) throw new Error('incomplete-request')
  } finally {
    if (timer) clearInterval(timer)
    if (active) { try { db.prepare('UPDATE authority SET lease_until=0 WHERE id=1 AND controller=?').run(controller) } catch { /* Persisted lease fences recovery. */ } }
    db.close()
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('holdout authority unavailable; verify private operator configuration and controller lease\n'); process.exitCode = 1 })
}
