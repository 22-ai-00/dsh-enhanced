import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { configuredDockerSocketPath } from '../src/docker-socket.ts'
import { bindIsolationStateSocket, stateSocketBindingMatches } from '../src/state-socket-binding.ts'

const roots: string[] = []
const nativePlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(async () => {
  Object.defineProperty(process, 'platform', nativePlatform)
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test('a bound Linux state root cannot silently switch Docker sockets across startup', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-socket-binding-'))); roots.push(root)
  bindIsolationStateSocket(root, '/var/run/docker.sock')
  expect(stateSocketBindingMatches(root, '/var/run/docker.sock')).toBe(true)
  expect(stateSocketBindingMatches(root, '/run/other.sock')).toBe(false)
  expect(() => bindIsolationStateSocket(root, '/run/other.sock')).toThrow(/different Docker socket/)
})

test('legacy Linux state permits only its original default socket', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-legacy-binding-'))); roots.push(root)
  await writeFile(join(root, 'ledger.sqlite'), '')
  expect(stateSocketBindingMatches(root, '/var/run/docker.sock')).toBe(true)
  expect(stateSocketBindingMatches(root, '/run/other.sock')).toBe(false)
  expect(() => bindIsolationStateSocket(root, '/run/other.sock')).toThrow(/legacy state root/)
  bindIsolationStateSocket(root, '/var/run/docker.sock')
})

test('Linux Docker binding refuses a native-marked state root', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-native-binding-'))); roots.push(root)
  await writeFile(join(root, 'native-backend'), 'macos-seatbelt-v1\n', { mode: 0o600 })
  await writeFile(join(root, 'ledger.sqlite'), '')
  expect(stateSocketBindingMatches(root, '/var/run/docker.sock')).toBe(false)
  expect(() => bindIsolationStateSocket(root, '/var/run/docker.sock')).toThrow(/native-bound/)
})

test('new Mac state binds only the current user Docker socket', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-mac-socket-binding-'))); roots.push(root)
  const socket = configuredDockerSocketPath(undefined)
  bindIsolationStateSocket(root, socket)
  bindIsolationStateSocket(root, socket)
  expect(stateSocketBindingMatches(root, socket)).toBe(true)
  expect(stateSocketBindingMatches(root, '/var/run/docker.sock')).toBe(false)
  expect(() => bindIsolationStateSocket(root, '/var/run/docker.sock')).toThrow(/macOS Docker socket must be in the current user Docker run directory/)
})

test('Mac refuses an unbound legacy state root', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-mac-legacy-binding-'))); roots.push(root)
  await writeFile(join(root, 'ledger.sqlite'), '')
  const socket = configuredDockerSocketPath(undefined)
  expect(stateSocketBindingMatches(root, socket)).toBe(false)
  expect(() => bindIsolationStateSocket(root, socket)).toThrow(/legacy state root/)
})
