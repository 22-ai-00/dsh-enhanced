import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, test } from 'vitest'
import { removeIsolatedContainer, runIsolatedProcess } from '../src/runner.ts'

const execFileAsync = promisify(execFile)
const image = process.env.DSH_ISOLATION_TEST_IMAGE ?? ''
const dockerPath = process.env.DSH_ISOLATION_TEST_DOCKER ?? '/usr/bin/docker'
const enabled = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() !== 0
  && /^sha256:[0-9a-f]{64}$/.test(image)
const dockerTests = enabled ? describe.sequential : describe.skip
const roots: string[] = []
const names: string[] = []
const socket = 'unix:///var/run/docker.sock'
const environment = { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }

afterEach(async () => {
  await Promise.all(names.splice(0).map(name => removeIsolatedContainer(dockerPath, name)))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function privateDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  await chmod(path, 0o700)
  roots.push(path)
  return path
}

async function docker(config: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync(dockerPath, ['--config', config, '-H', socket, ...args], {
    env: environment, timeout: 5_000, maxBuffer: 16 * 1024,
  })
  return result.stdout
}

function input(workspacePath: string, name: string, command: string, authorizeStart: () => boolean | Promise<boolean> = () => true) {
  return {
    jobId: randomUUID(), containerName: name, image, dockerPath, workspacePath, command,
    deadline: Date.now() + 20_000,
    limits: { maxDurationMs: 20_000, maxInputBytes: 1024, maxOutputBytes: 4096, maxArtifactBytes: 1024,
      maxFiles: 8, memoryMiB: 64, pidsLimit: 32, cpus: 0.5, workspaceMiB: 4, workspaceInodes: 64 },
    signal: new AbortController().signal, authorizeStart,
  }
}

dockerTests('Docker isolation security boundary (opt in)', () => {
  test('blocks bridge access to a Host HTTP canary while completing normally', async () => {
    const workspace = await privateDirectory('assistant-isolation-network-workspace-')
    const config = await privateDirectory('assistant-isolation-network-config-')
    let calls = 0
    const server = createServer((_request, response) => { calls += 1; response.end('canary') })
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '0.0.0.0', resolve))
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('Host canary did not bind a TCP port')
      const gateway = (await docker(config, ['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}'])).trim()
      if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(gateway)) throw new Error('Docker bridge gateway is unavailable')
      const name = `dsh-isolation-${randomUUID()}`; names.push(name)
      // With --network none this succeeds after wget fails. If a reviewer
      // temporarily removes that flag, wget reaches the canary and exits 91.
      const result = await runIsolatedProcess(input(workspace, name,
        `set -e; command -v busybox >/dev/null; if busybox wget -T1 -qO- http://${gateway}:${address.port}/canary; then exit 91; fi; printf network-blocked`))
      expect(calls).toBe(0)
      expect(result).toMatchObject({ status: 'succeeded', quiescent: true, exitCode: 0 })
      expect(result.stdout).toContain('network-blocked')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 30_000)

  test('keeps Host files, environment, Docker socket, and control IPC outside the worker', async () => {
    const parent = await privateDirectory('assistant-isolation-host-secret-parent-')
    const workspace = join(parent, 'workspace'); const secret = join(parent, 'host-secret')
    await Promise.all([privateChild(workspace), writeFile(secret, 'do-not-disclose', { mode: 0o600 })])
    const config = await privateDirectory('assistant-isolation-inspect-config-')
    const name = `dsh-isolation-${randomUUID()}`; names.push(name)
    let inspected = false
    const command = `set -e; test ! -r ${shellQuote(secret)}; test ! -r /proc/${process.pid}/root${shellQuote(secret)}; test ! -S /var/run/docker.sock; test -z "${'$'}DSH_ISOLATION_ENV_CANARY"; printf '{"type":"result","status":"succeeded"}'; exit 17`
    const previousCanary = process.env.DSH_ISOLATION_ENV_CANARY
    const canary = randomUUID()
    process.env.DSH_ISOLATION_ENV_CANARY = canary
    let result: Awaited<ReturnType<typeof runIsolatedProcess>> | undefined
    try { result = await runIsolatedProcess(input(workspace, name, command, async () => {
      const [container] = JSON.parse(await docker(config, ['inspect', name])) as Array<Record<string, unknown>>
      const host = container?.HostConfig as Record<string, unknown> | undefined
      const mounts = container?.Mounts as Array<Record<string, unknown>> | undefined
      const containerConfig = container?.Config as Record<string, unknown> | undefined
      expect(host).toMatchObject({ NetworkMode: 'none', ReadonlyRootfs: true, Memory: 64 * 1024 * 1024,
        MemorySwap: 64 * 1024 * 1024, PidsLimit: 32, NanoCpus: 500_000_000 })
      expect(host?.LogConfig).toMatchObject({ Type: 'none' })
      const [keeper] = JSON.parse(await docker(config, ['inspect', `${name}-keeper`])) as Array<{ HostConfig: Record<string, unknown>; Mounts: Array<Record<string, unknown>> }>
      expect(keeper?.HostConfig).toMatchObject({ NetworkMode: 'none', ReadonlyRootfs: true, Memory: 32 * 1024 * 1024, MemorySwap: 32 * 1024 * 1024, PidsLimit: 16, LogConfig: { Type: 'none' } })
      expect(keeper?.Mounts).toHaveLength(1)
      expect(keeper?.Mounts[0]).toMatchObject({ Type: 'volume', Name: `${name}-workspace`, Destination: '/workspace' })
      expect(host?.CapDrop).toContain('ALL')
      expect(host?.SecurityOpt).toContain('no-new-privileges')
      expect(containerConfig).toMatchObject({ WorkingDir: '/workspace', Entrypoint: ['/bin/sh'] })
      expect(mounts).toHaveLength(1)
      expect(mounts?.[0]).toMatchObject({ Type: 'volume', Name: `${name}-workspace`, Destination: '/workspace', RW: true })
      inspected = true
      return true
    })) } finally {
      if (previousCanary === undefined) delete process.env.DSH_ISOLATION_ENV_CANARY
      else process.env.DSH_ISOLATION_ENV_CANARY = previousCanary
    }
    if (result === undefined) throw new Error('runner returned no result')
    expect(inspected).toBe(true)
    expect(result).toMatchObject({ status: 'failed', quiescent: true, exitCode: 17 })
    expect(result.stdout).toContain('{"type":"result","status":"succeeded"}')
    expect(`${result.stdout}${result.stderr}`).not.toContain(canary)
    expect(`${result.stdout}${result.stderr}`).not.toContain('do-not-disclose')
  }, 30_000)
})

async function privateChild(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
