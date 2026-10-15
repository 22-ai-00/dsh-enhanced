import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, constants, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'

const race = vi.hoisted(() => ({ swapBeforeSqliteOpen: false, replacement: '', moved: '', widenTempBeforePin: false, widened: '' }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, openSync: ((...args: Parameters<typeof actual.openSync>) => {
    const fd = actual.openSync(...args)
    const path = String(args[0])
    if (race.widenTempBeforePin && /\/automations-operator-snapshot-[^/]*$/u.test(path)) {
      race.widenTempBeforePin = false; race.widened = path; actual.chmodSync(path, 0o755)
    }
    return fd
  }) as typeof actual.openSync }
})
vi.mock('node:sqlite', async importOriginal => {
  const actual = await importOriginal<typeof import('node:sqlite')>()
  const fs = await import('node:fs')
  const path = await import('node:path')
  return { ...actual, DatabaseSync: new Proxy(actual.DatabaseSync, { construct(target, args) {
    const filename = String(args[0])
    if (race.swapBeforeSqliteOpen && filename.includes('automations-operator-snapshot-')) {
      race.swapBeforeSqliteOpen = false
      race.replacement = path.dirname(filename); race.moved = `${race.replacement}-moved`
      fs.renameSync(race.replacement, race.moved)
      fs.mkdirSync(race.replacement, { mode: 0o700 })
      fs.copyFileSync(path.join(race.moved, 'automations.sqlite'), filename)
      fs.copyFileSync(path.join(race.moved, 'automations.sqlite-wal'), `${filename}-wal`)
      fs.writeFileSync(path.join(race.replacement, 'replacement-sentinel'), 'keep', { mode: 0o600 })
    }
    return Reflect.construct(target, args)
  } }) }
})
import { AutomationStore } from '../src/store.ts'
import { AutomationOperatorSnapshotError, inspectAutomationsOperatorSnapshot } from '../src/operator.ts'
import { macExclusiveWriter, parseMacLockOutput } from '../src/operator-macos.ts'

const mac = process.platform === 'darwin' ? describe.sequential : describe.skip
const roots: string[] = []
const retainedRoots = new Set<string>()
afterEach(() => {
  race.swapBeforeSqliteOpen = false
  race.widenTempBeforePin = false
  for (const root of roots.splice(0)) if (!retainedRoots.has(root)) rmSync(root, { recursive: true, force: true })
  if (race.replacement) rmSync(race.replacement, { recursive: true, force: true })
  if (race.moved) rmSync(race.moved, { recursive: true, force: true })
  if (race.widened) rmSync(race.widened, { recursive: true, force: true })
  race.replacement = ''; race.moved = ''; race.widened = ''
})
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'operator-macos-'))); roots.push(root)
  const path = join(root, 'state', 'automations.sqlite')
  new AutomationStore({ path }).close()
  return path
}
function definition() {
  return { name: 'WAL proof', prompt: 'Run WAL proof.', schedule: { kind: 'every' as const,
    anchorAt: '2026-09-11T00:00:00.000Z', intervalMs: 60_000 }, workspace: '/work/operator',
  agentPreset: 'primary', provider: 'mock', model: 'mock-model', allowedTools: ['wiki_search'],
  timeoutMs: 60_000, maxOutputTokens: 2_048, maxToolCalls: 4,
  misfire: { kind: 'latest' as const }, overlap: 'skip' as const, retrySafety: 'never' as const,
  maxRetries: 0, principal: 'owner:test' }
}
function fingerprint(paths: string[]) {
  return paths.map(path => { const s = statSync(path, { bigint: true }); return { path, dev: s.dev, ino: s.ino,
    size: s.size, mtime: s.mtimeNs, ctime: s.ctimeNs, digest: createHash('sha256').update(readFileSync(path)).digest('hex') } })
}
function expectBusy(action: () => unknown) {
  expect(action).toThrowError(expect.objectContaining<Partial<AutomationOperatorSnapshotError>>({ code: 'database-busy' }))
}
const writerSource = `import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[1]); const mode=process.argv[2];
if(mode==='wal') { db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
db.prepare("UPDATE automation_definitions SET status='paused', next_run_at=NULL, version=version+1, updated_at=updated_at+1 WHERE id='wal-proof'").run(); }
else db.exec('PRAGMA locking_mode=EXCLUSIVE');
process.stdout.write('ready\\n');
let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\\n'))>=0){const command=buffer.slice(0,i);buffer=buffer.slice(i+1);try{
if(command==='begin'){db.exec(mode==='wal'?'BEGIN IMMEDIATE':'BEGIN EXCLUSIVE');process.stdout.write('holding\\n')}
else if(command==='rollback'){db.exec('ROLLBACK');process.stdout.write('released\\n')}
else if(command==='close'){db.close();process.stdout.write('closed\\n');process.exit(0)}
}catch(error){process.stderr.write(String(error));process.exit(2)}}});`
async function writer(path: string, mode: 'wal' | 'exclusive', options: {
  source?: string; readyTimeoutMs?: number; onSpawn?: (pid: number) => void
} = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', options.source ?? writerSource, path, mode],
    { stdio: ['pipe', 'pipe', 'pipe'] })
  if (child.pid !== undefined) options.onSpawn?.(child.pid)
  const root = dirname(dirname(path))
  const lines: string[] = []
  let waiting: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined
  let buffer = ''; let stderr = ''; let failure: Error | undefined
  let closed: { code: number | null; signal: NodeJS.Signals | null } | undefined
  const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (code, signal) => {
      closed = { code, signal }
      waiting?.reject(failure ?? new Error(`writer closed before handshake: ${code}/${signal}; ${stderr}`))
      waiting = undefined
      resolve(closed)
    })
  })
  child.once('error', error => {
    failure = error
    waiting?.reject(error)
    waiting = undefined
  })
  child.stdin.on('error', error => {
    failure = error
    waiting?.reject(error)
    waiting = undefined
  })
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += String(chunk)
    if (Buffer.byteLength(buffer) > 4_096) {
      failure = new Error('writer stdout exceeded 4096 bytes')
      waiting?.reject(failure); waiting = undefined
      child.kill('SIGTERM')
      return
    }
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
      const next = waiting; waiting = undefined
      if (next) next.resolve(line); else lines.push(line)
    }
    if (lines.length > 16) {
      failure = new Error('writer sent too many handshake lines')
      waiting?.reject(failure); waiting = undefined
      child.kill('SIGTERM')
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += String(chunk)
    if (Buffer.byteLength(stderr) > 4_096) {
      stderr = stderr.slice(0, 4_096)
      failure = new Error('writer stderr exceeded 4096 bytes')
      waiting?.reject(failure); waiting = undefined
      child.kill('SIGTERM')
    }
  })
  async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: ${stderr}`)), milliseconds)
      })])
    } finally { if (timer) clearTimeout(timer) }
  }
  async function next(milliseconds = 5_000): Promise<string> {
    if (failure) throw failure
    const line = lines.shift()
    if (line !== undefined) return line
    if (closed) throw new Error(`writer closed before handshake: ${closed.code}/${closed.signal}; ${stderr}`)
    const pending = new Promise<string>((resolve, reject) => { waiting = { resolve, reject } })
    try { return await bounded(pending, milliseconds, 'writer handshake timeout') }
    finally { waiting = undefined }
  }
  async function terminate(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (!closed) child.kill('SIGTERM')
    try { return await bounded(closePromise, 1_000, 'writer did not close after SIGTERM') }
    catch {
      if (!closed) child.kill('SIGKILL')
      try { return await bounded(closePromise, 3_000, 'writer did not close after SIGKILL') }
      catch (error) { retainedRoots.add(root); throw error }
    }
  }
  async function command(value: 'begin' | 'rollback' | 'close', response: string) {
    if (closed || child.stdin.destroyed) throw new Error(`writer command ${value} could not be sent`)
    child.stdin.write(`${value}\n`)
    expect(await next()).toBe(response)
  }
  try { expect(await next(options.readyTimeoutMs)).toBe('ready') }
  catch (error) {
    try { await terminate() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'writer startup and cleanup failed') }
    throw error
  }
  return { child, command, async stop() {
    if (!closed) {
      try { await command('close', 'closed') }
      catch (error) {
        await terminate()
        throw error
      }
    }
    let result: { code: number | null; signal: NodeJS.Signals | null }
    try { result = await bounded(closePromise, 5_000, 'writer did not close after close command') }
    catch (error) { await terminate(); throw error }
    expect(result).toEqual({ code: 0, signal: null })
  } }
}

mac('macOS operator snapshot', () => {
  test('reads committed WAL state without modifying source bytes or metadata, and rejects an independent WAL writer', async () => {
    const path = fixture()
    const store = new AutomationStore({ path })
    const baseline = store.createApproved({ automationId: 'wal-proof', idempotencyKey: 'wal-proof-create', definition: definition() })
    store.close()
    const active = await writer(path, 'wal')
    const paths = [path, `${path}-wal`, `${path}-shm`]
    try {
      const before = fingerprint(paths)
      const main = new DatabaseSync(`file:${path}?mode=ro&immutable=1`, { readOnly: true })
      try { expect(main.prepare("SELECT status, version FROM automation_definitions WHERE id='wal-proof'").get())
        .toEqual({ status: 'active', version: baseline.version }) } finally { main.close() }
      const idle = inspectAutomationsOperatorSnapshot(path)
      expect(idle.records).toMatchObject([{ id: 'wal-proof', status: 'paused', version: baseline.version + 1 }])
      expect(idle.sidecars.wal).not.toBeNull()
      expect(fingerprint(paths)).toEqual(before)
      await active.command('begin', 'holding')
      const locked = fingerprint(paths)
      expectBusy(() => inspectAutomationsOperatorSnapshot(path))
      expect(fingerprint(paths)).toEqual(locked)
      await active.command('rollback', 'released')
      const released = fingerprint(paths)
      expect(inspectAutomationsOperatorSnapshot(path).records)
        .toMatchObject([{ id: 'wal-proof', status: 'paused', version: baseline.version + 1 }])
      expect(fingerprint(paths)).toEqual(released)
    } finally { await active.stop() }
  }, 25_000)

  test('closes a writer whose ready handshake times out before test cleanup', async () => {
    const path = fixture()
    let pid: number | undefined
    await expect(writer(path, 'wal', { source: 'setInterval(() => {}, 1000)', readyTimeoutMs: 100,
      onSpawn: value => { pid = value } }))
      .rejects.toThrow('writer handshake timeout')
    expect(pid).toBeDefined()
    expect(() => process.kill(pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
    expect(retainedRoots.has(dirname(dirname(path)))).toBe(false)
  }, 10_000)

  test('rejects an independent exclusive rollback writer; released connection can be read', async () => {
    const path = fixture(), active = await writer(path, 'exclusive')
    try {
      await active.command('begin', 'holding')
      const before = fingerprint([path])
      expectBusy(() => inspectAutomationsOperatorSnapshot(path))
      expect(fingerprint([path])).toEqual(before)
    } finally { await active.stop() }
    expect(inspectAutomationsOperatorSnapshot(path).records).toEqual([])
  }, 20_000)

  test('refuses same-process SQLite descriptors before opening a source inode', () => {
    const path = fixture(), db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE')
      const shm = statSync(`${path}-shm`, { bigint: true })
      const descriptor = readdirSync('/dev/fd').map(Number).find(fd => {
        if (!Number.isSafeInteger(fd) || fd <= 2) return false
        try { const stat = fstatSync(fd, { bigint: true }); return stat.dev === shm.dev && stat.ino === shm.ino }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EBADF') return false; throw error }
      })
      expect(descriptor).toBeDefined()
      expect(macExclusiveWriter([{ dev: shm.dev, ino: shm.ino, descriptor: descriptor! }])).toBe(true)
      expectBusy(() => inspectAutomationsOperatorSnapshot(path))
      expect(macExclusiveWriter([{ dev: shm.dev, ino: shm.ino, descriptor: descriptor! }])).toBe(true)
      db.exec('ROLLBACK')
    } finally { db.close() }
  })

  test('rejects a same-name private copy swap and never recursively removes the replacement', async () => {
    const path = fixture(), active = await writer(path, 'wal')
    try {
      race.swapBeforeSqliteOpen = true
      expect(() => inspectAutomationsOperatorSnapshot(path))
        .toThrowError(expect.objectContaining<Partial<AutomationOperatorSnapshotError>>({ code: 'database-drift' }))
      expect(race.swapBeforeSqliteOpen).toBe(false)
      expect(existsSync(race.replacement)).toBe(true)
      expect(readFileSync(join(race.replacement, 'replacement-sentinel'), 'utf8')).toBe('keep')
      expect(existsSync(race.moved)).toBe(true)
    } finally { await active.stop() }
  }, 20_000)

  test('retains an unpinned temporary directory instead of recursively deleting it', async () => {
    const path = fixture(), active = await writer(path, 'wal')
    try {
      race.widenTempBeforePin = true
      expect(() => inspectAutomationsOperatorSnapshot(path))
        .toThrowError(expect.objectContaining<Partial<AutomationOperatorSnapshotError>>({ code: 'unsafe-path' }))
      expect(race.widened).not.toBe('')
      expect(existsSync(race.widened)).toBe(true)
    } finally { await active.stop() }
  }, 20_000)

  test('fails closed on invalid helper descriptor identity or output', () => {
    const path = fixture(), fd = openSync(path, constants.O_RDONLY)
    try {
      const stat = fstatSync(fd, { bigint: true })
      expect(() => macExclusiveWriter([{ dev: stat.dev, ino: stat.ino + 1n, descriptor: fd }])).toThrow()
    } finally { closeSync(fd) }
    expect(parseMacLockOutput('UUU\n', 3)).toBe(false)
    expect(parseMacLockOutput('UWU\n', 3)).toBe(true)
    for (const invalid of ['UU', 'UUU\nextra', 'U?U\n', 'UUUU\n']) expect(() => parseMacLockOutput(invalid, 3)).toThrow()
  })
})
