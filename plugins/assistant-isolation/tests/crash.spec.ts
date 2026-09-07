import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const image = process.env.DSH_ISOLATION_TEST_IMAGE ?? ''
const dockerPath = process.env.DSH_ISOLATION_TEST_DOCKER ?? '/usr/bin/docker'
const enabled = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() !== 0 && /^sha256:[0-9a-f]{64}$/u.test(image)
const dockerTests = enabled ? describe.sequential : describe.skip
const roots: string[] = []
const environment = { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }
const limits = { maxDurationMs: 45_000, maxInputBytes: 1024, maxOutputBytes: 4096, maxArtifactBytes: 1024, maxFiles: 8, memoryMiB: 64, pidsLimit: 32, cpus: 0.5, workspaceMiB: 4, workspaceInodes: 64 }

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const wait = async (predicate: () => Promise<boolean>, message: string, timeout = 10_000): Promise<void> => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error(message)
}

async function docker(config: string, args: string[]): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return await new Promise(resolve => {
    const child = spawn(dockerPath, ['--config', config, '-H', 'unix:///var/run/docker.sock', ...args], { shell: false, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''; let stdout = ''; let settled = false; let timer: NodeJS.Timeout | undefined
    const finish = (code: number | null, value: string): void => { if (settled) return; settled = true; if (timer !== undefined) clearTimeout(timer); resolve({ code, stderr: value, stdout }) }
    child.stdout.on('data', chunk => { if (Buffer.byteLength(stdout) < 4096) stdout += Buffer.from(chunk).subarray(0, 4096 - Buffer.byteLength(stdout)).toString('utf8') })
    child.stderr.on('data', chunk => { if (Buffer.byteLength(stderr) < 4096) stderr += Buffer.from(chunk).subarray(0, 4096 - Buffer.byteLength(stderr)).toString('utf8') })
    child.once('error', error => finish(null, `spawn:${error.message}`))
    child.once('exit', code => finish(code, stderr))
    timer = setTimeout(() => { child.kill('SIGKILL'); finish(null, 'inspect-timeout') }, 2_000)
    timer.unref()
  })
}

dockerTests('runner supervisor Host-crash cleanup (opt in)', () => {
  it('survives a killed controller process group and removes its setsid container descendants', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-isolation-crash-')); roots.push(root); await chmod(root, 0o700)
    const workspace = join(root, 'workspace'); const inspectConfig = await mkdtemp(join(root, 'docker-')); await chmod(inspectConfig, 0o700)
    await mkdir(workspace, { mode: 0o700 })
    const name = `dsh-isolation-${randomUUID()}`
    const runner = new URL('../lib/runner.js', import.meta.url).href
    const script = `
      const [runner, image, dockerPath, workspace, name] = process.argv.slice(1)
      const { runIsolatedProcess } = await import(runner)
      const controller = new AbortController()
      await runIsolatedProcess({ jobId: '${randomUUID()}', containerName: name, image, dockerPath, workspacePath: workspace,
        command: "setsid sh -c 'while :; do printf x >> /workspace/heartbeat; sleep 0.1; done' & wait",
        deadline: Date.now() + 45_000, limits: ${JSON.stringify(limits)}, signal: controller.signal, authorizeStart: () => true })
    `
    const controller = spawn(process.execPath, ['--input-type=module', '-e', script, runner, image, dockerPath, workspace, name], { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: environment })
    let spawnError = ''
    controller.once('error', error => { spawnError = error.message })
    controller.stdout?.resume(); controller.stderr?.resume()
    try {
      await wait(async () => (await docker(inspectConfig, ['exec', name, '/bin/busybox', 'test', '-f', '/workspace/heartbeat'])).code === 0, `controller did not start isolated workload${spawnError ? `: ${spawnError}` : ''}`)
      const before = (await docker(inspectConfig, ['exec', name, '/bin/busybox', 'cat', '/workspace/heartbeat'])).stdout
      await new Promise(resolve => setTimeout(resolve, 250))
      expect((await docker(inspectConfig, ['exec', name, '/bin/busybox', 'cat', '/workspace/heartbeat'])).stdout).not.toBe(before)
      expect(controller.pid).toBeGreaterThan(0)
      process.kill(-controller.pid!, 'SIGKILL')
      for (const [type, resource] of [['container', name], ['container', `${name}-keeper`], ['volume', `${name}-workspace`]]) {
        await wait(async () => {
          const observed = await docker(inspectConfig, ['inspect', '--type', type!, resource!])
          return observed.code !== 0 && /no such (object|container|volume)/iu.test(observed.stderr)
        }, `supervisor did not prove removal of ${resource}`)
      }
    } finally {
      if (controller.pid !== undefined) { try { process.kill(-controller.pid, 'SIGKILL') } catch {} }
      await docker(inspectConfig, ['rm', '-f', name, `${name}-keeper`]).catch(() => undefined)
      await docker(inspectConfig, ['volume', 'rm', `${name}-workspace`]).catch(() => undefined)
      await rm(inspectConfig, { recursive: true, force: true })
    }
  }, 60_000)
})
