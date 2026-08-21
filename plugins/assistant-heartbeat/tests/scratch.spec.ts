import { mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { HeartbeatScratch, HeartbeatScratchError } from '../src/scratch.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('heartbeat scratch store', () => {
  test('creates a private human-readable file and updates it with revision CAS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-heartbeat-scratch-'))
    roots.push(root)
    const path = join(root, 'private', 'primary.md')
    const scratch = new HeartbeatScratch({ path, maxBytes: 64, initialContent: 'Review inbox.' })
    const initial = scratch.read()
    expect(initial).toMatchObject({ content: 'Review inbox.', empty: false })
    expect((await stat(join(root, 'private'))).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)

    const updated = scratch.write({ expectedRevision: initial.revision, content: 'Check project risks.' })
    expect(updated.content).toBe('Check project risks.')
    expect(await readFile(path, 'utf8')).toBe('Check project risks.\n')
    expect(() => scratch.write({ expectedRevision: initial.revision, content: 'stale' }))
      .toThrowError(expect.objectContaining<Partial<HeartbeatScratchError>>({ code: 'revision-conflict' }))
  })

  test('rejects relative paths, symlink leaves, and oversized content', async () => {
    expect(() => new HeartbeatScratch({ path: 'relative.md', maxBytes: 64 }))
      .toThrowError(expect.objectContaining<Partial<HeartbeatScratchError>>({ code: 'invalid-path' }))
    const root = await mkdtemp(join(tmpdir(), 'assistant-heartbeat-link-'))
    roots.push(root)
    await mkdir(join(root, 'scratch'))
    await symlink(join(root, 'target.md'), join(root, 'scratch', 'linked.md'))
    expect(() => new HeartbeatScratch({ path: join(root, 'scratch', 'linked.md'), maxBytes: 64 }))
      .toThrowError(expect.objectContaining<Partial<HeartbeatScratchError>>({ code: 'unsafe-path' }))
    const scratch = new HeartbeatScratch({ path: join(root, 'scratch', 'bounded.md'), maxBytes: 8 })
    expect(() => scratch.write({ expectedRevision: scratch.read().revision, content: '012345678' }))
      .toThrowError(expect.objectContaining<Partial<HeartbeatScratchError>>({ code: 'content-too-large' }))
  })
})
