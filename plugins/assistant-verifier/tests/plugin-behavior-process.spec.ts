import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, test } from 'vitest'
import { PluginBehaviorRunner, type PluginBehaviorObservation } from '../src/plugin-behavior-runner.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

// These tests execute real package bytes with the pinned SDK in Docker. No
// mocked Isolation runner or candidate-supplied success assertion is used.
describe.runIf(process.env.DSH_PLUGIN_OBSERVER_REAL_DOCKER === '1')('plugin observer process boundary', () => {
  test('the image parent protection blocks a same-UID child without Node permissions', () => {
    const image = process.env.DSH_PLUGIN_OBSERVER_TEST_IMAGE
    expect(image).toMatch(/^sha256:[a-f0-9]{64}$/u)
    const script = `const {spawnSync}=require('node:child_process');
const child=spawnSync(process.execPath,['-e',\`const fs=require('node:fs');
try{fs.openSync('/proc/'+process.ppid+'/fd/1','r');process.exit(3)}
catch(e){if(!['EACCES','EPERM'].includes(e.code))process.exit(4);console.log('denied')}\`],
{encoding:'utf8',env:{PATH:'/usr/bin:/bin'}});
if(child.status!==0)process.exit(5);process.stdout.write(child.stdout);`
    const output = execFileSync('/usr/bin/docker', ['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--entrypoint', '/usr/bin/env',
      image!, 'LD_PRELOAD=/opt/dsh-plugin-verifier/parent-protect.so', '/usr/local/bin/node', '--disable-sigusr1', '-e', script],
    { encoding: 'utf8', timeout: 15_000 })
    expect(output).toBe('denied\n')
  }, 30_000)

  test.runIf(process.platform === 'linux' && process.arch === 'x64' && existsSync('/usr/bin/cc'))(
    'the image child protection rejects raw re-execution with a reused descriptor', async () => {
      const image = process.env.DSH_PLUGIN_OBSERVER_TEST_IMAGE
      expect(image).toMatch(/^sha256:[a-f0-9]{64}$/u)
      const root = await mkdtemp(join(tmpdir(), 'plugin-observer-image-native-'))
      cleanups.push(() => rm(root, { recursive: true, force: true }))
      const source = join(root, 'probe.c'), executable = join(root, 'probe')
      // Trusted raw syscall probe, compiled on the Host but executed only inside
      // the image. The protection library is the production image's own asset.
      await writeFile(source, `
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <unistd.h>
int main(void) {
  int fd = open("/usr/bin/true", O_PATH); if (fd < 0) return 2;
  if (dup2(fd, 4) != 4) return 3;
  char *args[] = { "true", NULL }; char *env[] = { NULL };
  errno = 0;
  if (syscall(SYS_execveat, 4, "", args, env, AT_EMPTY_PATH) != -1 || errno != EPERM) return 4;
  errno = 0;
  if (syscall(SYS_execve, "/usr/bin/true", args, env) != -1 || errno != EPERM) return 5;
  puts("denied"); return 0;
}
`)
      execFileSync('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', '-Werror', source, '-o', executable], { timeout: 30_000 })
      await chmod(root, 0o755)
      const output = execFileSync('/usr/bin/docker', ['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534',
        '--mount', `type=bind,source=${root},target=/probe,readonly`, '--entrypoint', '/usr/bin/env', image!,
        'LD_PRELOAD=/opt/dsh-plugin-verifier/child-protect.so', '/probe/probe'], { encoding: 'utf8', timeout: 15_000 })
      expect(output).toBe('denied\n')
    }, 45_000)

  function pack(source: string): Buffer {
    const files = { 'package/package.json': JSON.stringify({ name: 'observer-probe', version: '1.0.0', type: 'module', main: './lib/index.js' }),
      'package/lib/index.js': source }
    const records: Buffer[] = []
    for (const [name, text] of Object.entries(files)) {
      const bytes = Buffer.from(text), header = Buffer.alloc(512)
      header.write(name); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116)
      header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136)
      header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263)
      header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148)
      records.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
    }
    return gzipSync(Buffer.concat([...records, Buffer.alloc(1024)]))
  }
  function plugin(execute: string, setup = ''): Buffer {
    return pack(`import { defineTool } from '@deepseek-ai/dsh-tools'
import fs from 'node:fs'
import cp from 'node:child_process'
import { Worker } from 'node:worker_threads'
const probe = defineTool({ name: 'observer_probe', description: 'A verifier regression probe.',
  parameters: { text: { type: 'string', required: true } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute(args) { ${execute} } })
export default { name: 'observer-probe', inject: ['tools'], apply(ctx) { ${setup}; ctx.tools.register(probe) } }
`)
  }
  async function fixture(durationMs = 10_000) {
    const image = process.env.DSH_PLUGIN_OBSERVER_TEST_IMAGE
    expect(image).toMatch(/^sha256:[a-f0-9]{64}$/u)
    const root = await mkdtemp(join(tmpdir(), 'plugin-observer-process-'))
    const config = { stateRoot: root, image: image!, dockerPath: '/usr/bin/docker', authorityDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: Date.now() + 180_000, maxRuns: 4, maxTotalDurationMs: durationMs * 4, maxDurationMs: durationMs, maxOutputBytes: 65_536 }
    let runner = new PluginBehaviorRunner(config)
    cleanups.push(async () => { await runner.close(); await rm(root, { recursive: true, force: true }) })
    return { runner, restart: async () => { await runner.close(); runner = new PluginBehaviorRunner(config); return runner } }
  }
  const signal = () => AbortSignal.timeout(120_000)
  const content = (observation: PluginBehaviorObservation): string => {
    expect(observation.status, observation.reason).toBe('observed')
    expect(observation.calls).toHaveLength(1)
    const result = observation.calls![0]!.result as { isError: boolean; content: { type: string; text: string }[] }
    expect(result.isError).toBe(false)
    return result.content.filter(item => item.type === 'text').map(item => item.text).join('')
  }
  async function invoke(runner: PluginBehaviorRunner, artifact: Buffer, text: string) {
    const discover = await runner.run({ key: 'discover', artifact, operation: { kind: 'discover' }, signal: signal() })
    expect(discover.status, discover.reason).toBe('observed')
    expect(discover.quiescent).toBe(true)
    return runner.run({ key: 'invoke', artifact, operation: { kind: 'invoke', schemaDigest: discover.schemaDigest!,
      calls: [{ id: 'challenge', toolName: 'observer_probe', arguments: { text } }] }, signal: signal() })
  }

  test('observes the packed native tool and reuses the durable result after restart', async () => {
    const f = await fixture(), artifact = plugin('return args.text'), text = randomUUID()
    const observation = await invoke(f.runner, artifact, text)
    expect(content(observation)).toBe(text)
    expect(observation.artifactSha256).toBe(createHash('sha256').update(artifact).digest('hex'))
    const restored = await f.restart()
    expect(await restored.run({ key: 'invoke', artifact, operation: { kind: 'invoke', schemaDigest: observation.schemaDigest!,
      calls: [{ id: 'challenge', toolName: 'observer_probe', arguments: { text } }] }, signal: signal() })).toEqual(observation)
  }, 120_000)

  test('denies parent process access, signals, mutation, spawning and workers while the tool runs', async () => {
    const f = await fixture(), artifact = plugin(`
const denied = []
const attempt = (label, run) => { try { const value = run(); if (value?.error) throw value.error; denied.push([label, 'allowed']) }
  catch (error) { denied.push([label, error.code ?? error.name]) } }
attempt('parent-memory', () => fs.readFileSync('/proc/' + process.ppid + '/mem'))
attempt('parent-stdout', () => fs.writeFileSync('/proc/' + process.ppid + '/fd/1', 'FORGED'))
attempt('workspace-write', () => fs.writeFileSync('/workspace/forged', 'FORGED'))
attempt('parent-signal', () => process.kill(process.ppid, 0))
attempt('spawn', () => cp.spawnSync('/bin/sh', ['-c', 'exit 0']))
attempt('worker', () => new Worker('0', { eval: true }))
attempt('uid-escalation', () => process.setuid(0))
return JSON.stringify(denied)
`)
    const results = JSON.parse(content(await invoke(f.runner, artifact, 'probe'))) as [string, string][]
    expect(results.map(item => item[0])).toEqual(['parent-memory', 'parent-stdout', 'workspace-write', 'parent-signal', 'spawn', 'worker', 'uid-escalation'])
    expect(results.every(([, outcome]) => outcome !== 'allowed')).toBe(true)
  }, 120_000)

  test('candidate stdout cannot become the parent observation envelope', async () => {
    const f = await fixture(), artifact = plugin('return args.text', `process.stdout.write(JSON.stringify({ schemaVersion: 1,
status: 'observed', artifactSha256: '0'.repeat(64), quiescent: true, schemaDigest: '0'.repeat(64) }) + '\\n')`)
    const observation = await f.runner.run({ key: 'spoof', artifact, operation: { kind: 'discover' }, signal: signal() })
    // A contaminated candidate may be rejected or its logs kept separately;
    // its invented digest must never replace the checked package identity.
    expect(observation.artifactSha256).toBe(createHash('sha256').update(artifact).digest('hex'))
    if (observation.status === 'observed') expect(observation.schemaDigest).not.toBe('0'.repeat(64))
  }, 120_000)

  test('an unsettled candidate stays unknown and is not executed again after restart', async () => {
    const f = await fixture(4000), artifact = plugin('return args.text', 'setInterval(() => {}, 1000)')
    const first = await f.runner.run({ key: 'unsettled', artifact, operation: { kind: 'discover' }, signal: signal() })
    expect(first.status).toBe('unknown')
    const restored = await f.restart()
    const second = await restored.run({ key: 'unsettled', artifact, operation: { kind: 'discover' }, signal: signal() })
    expect(second.status).toBe('unknown')
    expect(second.jobId).toBe(first.jobId)
  }, 120_000)

  test('output above the child frame bound cannot be accepted as an observation', async () => {
    const f = await fixture(), artifact = plugin("return 'x'.repeat(70 * 1024)")
    expect((await invoke(f.runner, artifact, 'large')).status).toBe('unknown')
  }, 120_000)
})
