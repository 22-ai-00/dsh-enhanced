import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { IsolationLedger } from '../src/ledger.ts'

const roots: string[] = []
const cli = fileURLToPath(new URL('../lib/cli.js', import.meta.url))

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function run(...arguments_: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [cli, ...arguments_], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, env: { ...process.env, NODE_NO_WARNINGS: '1' } })
}

function fixture(): { stateRoot: string; archiveDirectory: string } {
  const parent = mkdtempSync(join(tmpdir(), 'isolation-audit-cli-')); roots.push(parent)
  const stateRoot = join(parent, 'state'); const archiveDirectory = join(parent, 'archive')
  mkdirSync(stateRoot, { mode: 0o700 }); mkdirSync(archiveDirectory, { mode: 0o700 })
  chmodSync(stateRoot, 0o700); chmodSync(archiveDirectory, 0o700)
  const ledger = new IsolationLedger(join(stateRoot, 'ledger.sqlite'), { now: () => 10_000 })
  ledger.syncGrants([{ id: 'grant', revision: 1, principalDigest: 'principal', principalRecordId: 'record', principalVersion: 1, workspace: '/work', agentPreset: 'default', expiresAt: 100_000, maxRuns: 1, maxTotalDurationMs: 1_000 }])
  ledger.close()
  return { stateRoot, archiveDirectory }
}

function json(stdout: string): Record<string, unknown> {
  expect(stdout.endsWith('\n')).toBe(true)
  return JSON.parse(stdout) as Record<string, unknown>
}

const execFileAsync = promisify(execFile)

describe('built isolation audit archive CLI', () => {
  it('publishes both archive functions from the built package root', async () => {
    const entry = await import('../lib/index.js')
    expect(entry.archiveIsolationAudit).toBeTypeOf('function')
    expect(entry.verifyIsolationAuditArchive).toBeTypeOf('function')
  })

  it('archives and verifies through JSON-only stdout', () => {
    const { stateRoot, archiveDirectory } = fixture()
    const archived = run('archive-audit', stateRoot, archiveDirectory, '1')
    expect(archived).toMatchObject({ status: 0, stderr: '' })
    const archiveResult = json(archived.stdout)
    expect(archiveResult).toMatchObject({ createdRecords: 1, verification: { valid: true, highestSequence: 1, sourceStateRootDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) } })

    const verified = run('verify-audit', archiveDirectory)
    expect(verified).toMatchObject({ status: 0, stderr: '' })
    expect(json(verified.stdout)).toMatchObject({
      valid: true,
      archiveInstanceId: expect.any(String),
      highestSequence: 1,
      headDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sourceStateRootDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
  })

  it.each([
    ['archive-audit'],
    ['archive-audit', '/state'],
    ['archive-audit', '/state', '/archive', '0'],
    ['archive-audit', '/state', '/archive', '01'],
    ['archive-audit', '/state', '/archive', '1e2'],
    ['archive-audit', '/state', '/archive', '1001'],
    ['archive-audit', '/state', '/archive', '9007199254740992'],
    ['archive-audit', '/state', '/archive', '1', 'extra'],
    ['verify-audit'],
    ['verify-audit', '/archive', 'extra'],
  ])('rejects invalid command arguments: %j', (...arguments_: string[]) => {
    const result = run(...arguments_)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^usage: dsh-isolation (?:archive-audit|verify-audit) /u)
  })

  it('reports a tampered archive on stderr and exits one', () => {
    const { stateRoot, archiveDirectory } = fixture()
    expect(run('archive-audit', stateRoot, archiveDirectory).status).toBe(0)
    const batch = readdirSync(archiveDirectory).find(name => name.endsWith('.ndjson'))
    expect(batch).toBeDefined()
    appendFileSync(join(archiveDirectory, batch!), '{}\n')

    const result = run('verify-audit', archiveDirectory)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/digest|invalid|archive/u)
  })

  it('serializes repeated four-process archive races without a fork or duplicate records', async () => {
    const options = { encoding: 'utf8' as const, timeout: 10_000, maxBuffer: 64 * 1024, env: { ...process.env, NODE_NO_WARNINGS: '1' } }
    for (let repetition = 0; repetition < 3; repetition += 1) {
      const { stateRoot, archiveDirectory } = fixture()
      const arguments_ = [cli, 'archive-audit', stateRoot, archiveDirectory, '1']
      const completed = await Promise.all(Array.from({ length: 4 }, async () => await execFileAsync(process.execPath, arguments_, options)))
      for (const result of completed) expect(result.stderr).toBe('')
      const results = completed.map(result => json(result.stdout))
      expect(results.map(result => result.createdRecords).sort()).toEqual([0, 0, 0, 1])

      const verified = run('verify-audit', archiveDirectory)
      expect(verified).toMatchObject({ status: 0, stderr: '' })
      expect(json(verified.stdout)).toMatchObject({
        valid: true, fileCount: 1, recordCount: 1, highestSequence: 1,
        archiveInstanceId: expect.any(String),
        headDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        sourceStateRootDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      })
    }
  })
})
