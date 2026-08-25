import { execFile as execFileCallback } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { readFileObservation } from '../src/sensors.ts'

const roots: string[] = []
const execFile = promisify(execFileCallback)

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

  test('rejects an ancestor directory replaced by a symlink after validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-file-ancestor-swap-'))
    const outside = await mkdtemp(join(tmpdir(), 'event-file-ancestor-outside-'))
    roots.push(root, outside)
    const directory = join(root, 'slot')
    const original = join(root, 'original-slot')
    const path = join(directory, 'watched.txt')
    await mkdir(directory)
    await writeFile(path, 'safe')
    await writeFile(join(outside, 'watched.txt'), 'outside-secret')

    await expect(readFileObservation({
      path,
      roots: [root],
      mode: 'content-hash',
      maxBytes: 64,
      beforeOpen: async () => {
        await rename(directory, original)
        await symlink(outside, directory, 'dir')
      },
    })).rejects.toThrow(/allowlist|changed|escape|unsafe/i)
  })

  test('pins the original allowed root when the root itself is replaced by a symlink', async () => {
    const container = await mkdtemp(join(tmpdir(), 'event-file-root-swap-'))
    const outside = await mkdtemp(join(tmpdir(), 'event-file-root-outside-'))
    roots.push(container, outside)
    const allowed = join(container, 'allowed')
    const original = join(container, 'allowed-original')
    const path = join(allowed, 'watched.txt')
    await mkdir(allowed)
    await writeFile(path, 'safe')
    await writeFile(join(outside, 'watched.txt'), 'outside-secret')

    await expect(readFileObservation({
      path,
      roots: [allowed],
      mode: 'content-hash',
      maxBytes: 64,
      beforeOpen: async () => {
        await rename(allowed, original)
        await symlink(outside, allowed, 'dir')
      },
    })).rejects.toThrow(/allowlist|changed|escape|unsafe/i)
  })

  test.skipIf(process.platform === 'win32')('opens a swapped FIFO non-blocking and rejects it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-file-fifo-swap-'))
    roots.push(root)
    const path = join(root, 'watched.txt')
    await writeFile(path, 'safe')
    let swapped!: () => void
    const didSwap = new Promise<void>(resolve => { swapped = resolve })
    const reading = readFileObservation({
      path,
      roots: [root],
      mode: 'content-hash',
      maxBytes: 64,
      beforeOpen: async () => {
        await unlink(path)
        await execFile('mkfifo', [path])
        swapped()
      },
    }).then(() => 'resolved', error => `rejected: ${String(error)}`)
    await didSwap
    const early = await Promise.race([
      reading,
      new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 100)),
    ])
    if (early === 'blocked') {
      const writer = await open(path, constants.O_WRONLY | constants.O_NONBLOCK)
      await writer.close()
      await reading
    }
    expect(early).toMatch(/^rejected:/u)
  })
})
