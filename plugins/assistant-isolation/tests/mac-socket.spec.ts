import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
const homeOverride = vi.hoisted(() => ({ value: '' }))
vi.mock('node:os', async importOriginal => {
  const original = await importOriginal<typeof import('node:os')>()
  return { ...original, homedir: () => homeOverride.value || original.homedir() }
})
import { configuredDockerSocketPath, resolveLocalDockerSocket, sameLocalDockerSocket } from '../src/docker-socket.ts'
import { removeIsolatedContainer, runIsolatedProcess } from '../src/runner.ts'
import { defaultLimits, validateConfig } from '../src/config.ts'
import { bindIsolationStateSocket, stateSocketBindingMatches } from '../src/state-socket-binding.ts'

const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: nativePlatform, configurable: true })
  homeOverride.value = ''
  await Promise.all(servers.splice(0).map(server => server.listening ? new Promise<void>(resolve => server.close(() => resolve())) : Promise.resolve()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const nativePlatform = process.platform

async function socket(): Promise<{ home: string; path: string; server: Server }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-mac-socket-')); roots.push(home)
  const directory = join(home, '.docker', 'run'); await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const path = join(directory, 'docker.sock')
  const server = createServer(); servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
  return { home, path, server }
}

describe.sequential('macOS local Docker socket', () => {
  test('pure config accepts the user socket and rejects remote or displaced endpoints', async () => {
    const local = await socket()
    homeOverride.value = local.home
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    expect(validateConfig({}).socketPath).toBe(local.path)
    expect(validateConfig({ socketPath: local.path }).socketPath).toBe(local.path)
    expect(() => validateConfig({ socketPath: 'tcp://host:2375' })).toThrow()
    bindIsolationStateSocket(local.home, local.path)
    bindIsolationStateSocket(local.home, local.path)
    expect(stateSocketBindingMatches(local.home, local.path)).toBe(true)
    expect(stateSocketBindingMatches(local.home, '/var/run/docker.sock')).toBe(false)
    expect(configuredDockerSocketPath(undefined, 'darwin', local.home)).toBe(local.path)
    for (const path of ['tcp://host:2375', 'ssh://host', '/var/run/docker.sock', join(local.home, 'other.sock')]) {
      expect(() => configuredDockerSocketPath(path, 'darwin', local.home)).toThrow()
    }
    const bound = resolveLocalDockerSocket(local.path, 'darwin', local.home)
    expect(sameLocalDockerSocket(bound)).toBe(true)
    await new Promise<void>(resolve => local.server.close(() => resolve()))
    expect(sameLocalDockerSocket(bound)).toBe(false)
  })

  test('runs and cleans a job through one explicit user socket', async () => {
    const local = await socket()
    homeOverride.value = local.home
    const workspacePath = await mkdtemp(join(tmpdir(), 'dsh-mac-workspace-')); roots.push(workspacePath)
    const bin = join(local.home, 'docker'); const log = join(local.home, 'calls')
    const body = `const fs=require('fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');const op=a.slice(a.indexOf('-H')+2);if(op[0]==='image'){console.log('null');process.exit(0)}if(op[0]==='start'&&op[1]==='--attach'){process.stdout.write('mac-ok');process.exit(0)}if(op[0]==='inspect'&&op.includes('--format')){console.log(JSON.stringify({Running:false,ExitCode:0}));process.exit(0)}if(op[0]==='inspect'){process.stderr.write('No such container');process.exit(1)}process.exit(0)`
    await writeFile(bin, `#!${process.execPath}\n${body}`, { mode: 0o700 })
    const name = `dsh-isolation-${randomUUID()}`
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const result = await runIsolatedProcess({ jobId: randomUUID(), containerName: name,
      image: `sha256:${'a'.repeat(64)}`, dockerPath: bin, socketPath: local.path, workspacePath,
      command: 'printf mac-ok', deadline: Date.now() + 20_000, limits: defaultLimits,
      signal: new AbortController().signal, authorizeStart: () => true })
    expect(result).toMatchObject({ status: 'succeeded', quiescent: true, stdout: 'mac-ok', exitCode: 0 })
    expect(result.creationWitness).toBeUndefined()
    expect(await removeIsolatedContainer(bin, name, { socketPath: local.path })).toBe(true)
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(calls.length).toBeGreaterThan(8)
    expect(calls.every(args => args[args.indexOf('-H') + 1] === `unix://${local.path}`)).toBe(true)
  }, 30_000)

  test('socket replacement after creation leaves the dispatched outcome unknown', async () => {
    const local = await socket(); homeOverride.value = local.home
    const workspacePath = await mkdtemp(join(tmpdir(), 'dsh-mac-workspace-')); roots.push(workspacePath)
    const bin = join(local.home, 'docker')
    const body = `const a=process.argv.slice(2);const op=a.slice(a.indexOf('-H')+2);if(op[0]==='image')console.log('null');process.exit(0)`
    await writeFile(bin, `#!${process.execPath}\n${body}`, { mode: 0o700 })
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const result = await runIsolatedProcess({ jobId: randomUUID(), containerName: `dsh-isolation-${randomUUID()}`,
      image: `sha256:${'a'.repeat(64)}`, dockerPath: bin, socketPath: local.path, workspacePath,
      command: 'printf forbidden', deadline: Date.now() + 20_000, limits: defaultLimits,
      signal: new AbortController().signal, authorizeStart: async () => {
        await new Promise<void>(resolve => local.server.close(() => resolve()))
        return true
      } })
    expect(result).toMatchObject({ status: 'unknown', quiescent: false, reason: 'docker-socket-changed' })
    expect(result.creationWitness).toBeUndefined()
  }, 30_000)
})
