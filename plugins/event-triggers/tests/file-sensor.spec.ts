import { mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { readFileObservation } from '../src/sensors.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('file sensor fences', () => {
  test('reads a bounded regular file through its validated descriptor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-file-sensor-'))
    roots.push(root)
    const path = join(root, 'watched.txt')
    await writeFile(path, 'ready')

    await expect(readFileObservation({ path, roots: [root], mode: 'content-hash', maxBytes: 64 }))
      .resolves.toMatchObject({ fingerprint: expect.stringMatching(/^sha256:/u), truthy: true })
    await expect(readFileObservation({ path, roots: [root], mode: 'content-hash', maxBytes: 4 }))
      .rejects.toThrow(/maxBodyBytes|limit/i)
  })

  test('rejects a leaf replaced by a symlink after validation and before open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-file-swap-'))
    const outside = await mkdtemp(join(tmpdir(), 'event-file-outside-'))
    roots.push(root, outside)
    const path = join(root, 'watched.txt')
    const secret = join(outside, 'secret.txt')
    await writeFile(path, 'safe')
    await writeFile(secret, 'outside-secret')

    await expect(readFileObservation({
      path,
      roots: [root],
      mode: 'content-hash',
      maxBytes: 64,
      beforeOpen: async () => {
        await unlink(path)
        await symlink(secret, path)
      },
    })).rejects.toThrow(/symlink|unsafe|loop/i)
  })
})
