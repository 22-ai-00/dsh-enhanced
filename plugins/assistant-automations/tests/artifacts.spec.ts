import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AutomationArtifactError, AutomationArtifactStore } from '../src/artifacts.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(maxBytes = 4_096) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-automations-artifacts-'))
  roots.push(root)
  const path = join(root, 'runs')
  return { root, path, store: new AutomationArtifactStore({ rootPath: path, maxBytes }) }
}

describe('private run artifacts', () => {
  test('atomically writes bounded 0600 JSON and replays the exact artifact idempotently', async () => {
    const fixtureValue = await fixture()
    const value = { occurrenceId: 'occ-abc123', outcome: 'succeeded', output: 'done', usage: { tokens: 2 } }
    const first = fixtureValue.store.write('occ-abc123', value)
    const replay = fixtureValue.store.write('occ-abc123', value)
    expect(replay).toEqual(first)
    expect(first).toBe('occ-abc123.json')
    expect((await stat(fixtureValue.path)).mode & 0o777).toBe(0o700)
    expect((await stat(join(fixtureValue.path, first))).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(join(fixtureValue.path, first), 'utf8'))).toEqual(value)
    const names = await import('node:fs/promises').then(fs => fs.readdir(fixtureValue.path))
    expect(names).toEqual(['occ-abc123.json'])
  })

  test('rejects traversal, oversize output, and conflicting replay without partial files', async () => {
    const fixtureValue = await fixture(128)
    expect(() => fixtureValue.store.write('../escape', { value: 'x' }))
      .toThrowError(expect.objectContaining<Partial<AutomationArtifactError>>({ code: 'invalid-id' }))
    expect(() => fixtureValue.store.write('occ-large', { value: 'x'.repeat(200) }))
      .toThrowError(expect.objectContaining<Partial<AutomationArtifactError>>({ code: 'too-large' }))
    fixtureValue.store.write('occ-stable', { value: 'one' })
    expect(() => fixtureValue.store.write('occ-stable', { value: 'two' }))
      .toThrowError(expect.objectContaining<Partial<AutomationArtifactError>>({ code: 'idempotency-conflict' }))
    await expect(access(join(fixtureValue.root, 'escape.json'), constants.F_OK)).rejects.toThrow()
  })
})
