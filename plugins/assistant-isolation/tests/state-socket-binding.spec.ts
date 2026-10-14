import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { bindIsolationStateSocket, stateSocketBindingMatches } from '../src/state-socket-binding.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

test('a state root cannot silently switch Docker sockets across startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-socket-binding-')); roots.push(root)
  bindIsolationStateSocket(root, '/var/run/docker.sock')
  expect(stateSocketBindingMatches(root, '/var/run/docker.sock')).toBe(true)
  expect(stateSocketBindingMatches(root, '/run/other.sock')).toBe(false)
  expect(() => bindIsolationStateSocket(root, '/run/other.sock')).toThrow(/different Docker socket/)
})

test('legacy Linux state permits only its original default socket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-legacy-binding-')); roots.push(root)
  await writeFile(join(root, 'ledger.sqlite'), '')
  expect(stateSocketBindingMatches(root, '/var/run/docker.sock')).toBe(true)
  expect(stateSocketBindingMatches(root, '/run/other.sock')).toBe(false)
  expect(() => bindIsolationStateSocket(root, '/run/other.sock')).toThrow(/legacy state root/)
  bindIsolationStateSocket(root, '/var/run/docker.sock')
})
