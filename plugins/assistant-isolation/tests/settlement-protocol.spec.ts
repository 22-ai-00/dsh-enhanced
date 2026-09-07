import { fork } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
type Settlement = { type: 'result'; settlementProtocol: string; requestsSettled: boolean; result: { status: string; quiescent: boolean; reason?: string } }

function fakeDocker(mode: string): string {
  return `#!/bin/sh
args=" $* "
mutation() {
  case '${mode}' in
    nonzero-volume) [ "$1" = volume ] && exit 17 ;;
    nonzero-create) [ "$1" = create ] && exit 17 ;;
    nonzero-start) [ "$1" = start ] && exit 17 ;;
    nonzero-cp) [ "$1" = cp ] && exit 17 ;;
    signal) [ "$1" = volume ] && kill -KILL $$ ;;
    overflow) if [ "$1" = volume ]; then head -c 70000 /dev/zero | tr '\\0' x; exit 0; fi ;;
    timeout) [ "$1" = volume ] && sleep 11 ;;
  esac
}
case "$args" in
  *" image inspect "*)
    if [ '${mode}' = spawnerror ]; then rm -- "$0"; fi
    printf 'null\\n'; exit 0 ;;
  *" volume create "*) mutation volume; exit 0 ;;
  *" create "*) mutation create; exit 0 ;;
  *" start "*) mutation start; exit 0 ;;
  *" cp "*) mutation cp; exit 0 ;;
  *" exec "*)
    case '${mode}' in
      exec-signal) kill -KILL $$ ;;
      exec-overflow) head -c 70000 /dev/zero | tr '\\0' x; exit 0 ;;
      exec-timeout) sleep 11 ;;
    esac
    exit 0 ;;
  *" inspect --type container --format "*) printf '{"Running":false,"ExitCode":0}\\n'; exit 0 ;;
  *" inspect "*)
    if [ '${mode}' = cleanup ]; then exit 0; fi
    printf 'No such object\\n' >&2; exit 1 ;;
  *" volume rm "*|*" rm -f "*)
    if [ '${mode}' = cleanup ]; then exit 2; fi
    exit 0 ;;
  *) exit 0 ;;
esac
`
}

async function run(mode: string): Promise<Settlement> {
  const root = await mkdtemp(join(tmpdir(), 'settlement-protocol-')); roots.push(root)
  const executable = join(root, 'docker'); const workspace = join(root, 'workspace')
  await writeFile(executable, fakeDocker(mode), { mode: 0o700 }); await chmod(executable, 0o700); await writeFile(workspace, '')
  const supervisor = fork(new URL('../runtime/supervisor.mjs', import.meta.url), [], { serialization: 'json', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const exited = once(supervisor, 'exit')
  return await new Promise<Settlement>((resolve, reject) => {
    const timeout = setTimeout(() => { supervisor.kill('SIGKILL'); reject(new Error(`supervisor timeout for ${mode}`)) }, 20_000)
    const finish = (value: Settlement): void => { clearTimeout(timeout); resolve(value) }
    supervisor.once('error', reject)
    supervisor.on('message', (message: { type?: string }) => {
      if (message.type === 'ready') { supervisor.send({ type: 'start' }); return }
      if (message.type === 'result') finish(message as Settlement)
    })
    supervisor.send({ type: 'configure', config: {
      dockerPath: executable, containerName: 'dsh-isolation-00000000-0000-0000-0000-000000000001', image: `sha256:${'a'.repeat(64)}`,
      workspacePath: workspace, artifacts: mode.startsWith('exec-') ? ['out'] : [], command: 'true', deadline: Date.now() + 15_000,
      limits: { maxDurationMs: 300_000, maxInputBytes: 1024, maxOutputBytes: 1024, maxArtifactBytes: 1024, maxFiles: 1, memoryMiB: 64, workspaceMiB: 4, workspaceInodes: 64, pidsLimit: 16, cpus: 1 },
    } })
  }).finally(async () => { if (supervisor.connected) supervisor.disconnect(); if (!supervisor.killed) supervisor.kill('SIGKILL'); await exited })
}

describe('supervisor settlement protocol', () => {
  it.each(['nonzero-volume', 'nonzero-create', 'nonzero-start', 'nonzero-cp', 'signal', 'spawnerror', 'overflow', 'exec-signal', 'exec-overflow'])(
    'marks mutation %s as not settled after every CLI closes', async (mode) => {
      const value = await run(mode)
      expect(value).toMatchObject({ type: 'result', settlementProtocol: 'all-cli-closed/v1', requestsSettled: false })
    }, 20_000)

  it.each(['timeout', 'exec-timeout'])('marks timed-out %s as not settled after its child closes', async mode => {
    const value = await run(mode)
    expect(value).toMatchObject({ type: 'result', settlementProtocol: 'all-cli-closed/v1', requestsSettled: false, result: { status: 'unknown' } })
  }, 20_000)

  it('keeps requests settled when all mutations succeeded but cleanup cannot confirm quiescence', async () => {
    const value = await run('cleanup')
    expect(value).toMatchObject({ type: 'result', settlementProtocol: 'all-cli-closed/v1', requestsSettled: true, result: { status: 'unknown', quiescent: false } })
  })
})
