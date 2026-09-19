import { chmod, copyFile, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { executeControlledProcess } from '../src/adapter-process.ts'
import { invokeConfiguredHostAttestor } from '../src/host-attestor.ts'
import type { PluginControlTrustConfig } from '../src/trust.ts'
import type { HostAttestationRequest } from '../src/types.ts'

const roots: string[] = []
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex')
async function active(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!)
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    for (const file of ['child.pid', 'parent.pid']) {
      try { const pid = Number(await readFile(join(root, file), 'utf8')); if (await active(pid)) process.kill(pid, 'SIGKILL') }
      catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
    }
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture(mode: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-adapter-process-'))); roots.push(root)
  const path = join(root, 'adapter.mjs')
  const childCode = `import {writeFileSync} from 'node:fs';
    writeFileSync(${JSON.stringify(join(root, 'child.pid'))}, String(process.pid));
    ${mode === 'escaped-output' ? "setTimeout(()=>process.stdout.write('x'.repeat(1024*1024),()=>process.exit(0)),35);" : 'setInterval(()=>{}, 20);'} process.send('ready');`
  await writeFile(path, `import {spawn} from 'node:child_process';
    import {readFileSync,writeFileSync} from 'node:fs';
    if (process.argv[2] === '--version') { process.stdout.write('tree-adapter-1\\n'); }
    else {
      writeFileSync(${JSON.stringify(join(root, 'parent.pid'))}, String(process.pid));
      const mode = ${JSON.stringify(mode)};
      if (mode === 'descriptor') {
        let input='';for await (const chunk of process.stdin) input+=chunk;
        process.stdout.write(readFileSync(3,'utf8')+':'+input);
      } else if(mode === 'closed-stdin') { process.exit(17); }
      else {
        const child=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(childCode)}],
          {detached:mode.startsWith('escaped'),stdio:['ignore',mode==='background'?'ignore':'inherit','ignore','ipc']});
        await new Promise(resolve=>child.once('message',resolve)); child.disconnect();child.unref();
        if(mode==='timeout') setInterval(()=>{},20);
        else if(mode==='overflow') { process.stdout.write('x'.repeat(1024*1024));setInterval(()=>{},20); }
        else {process.stdout.write('done');process.exitCode=mode==='nonzero'?19:0;}
      }
    }
  `, { mode: 0o700 })
  const execute = (timeoutMs = 1_000, maximumOutput = 4_096) => executeControlledProcess({ command: process.execPath,
    args: [path], env: {}, stdio: ['pipe', 'pipe', 'ignore'], stdin: 'request', timeoutMs, maximumOutput })
  const stopped = async () => {
    for (const file of ['parent.pid', 'child.pid']) {
      const pid = Number(await readFile(join(root, file), 'utf8')); expect(await active(pid), file).toBe(false)
    }
  }
  return { root, path, execute, stopped }
}

describe.skipIf(process.platform !== 'linux')('adapter process ownership', () => {
  test('preserves inherited descriptors and request stdin without taking caller FD ownership', async () => {
    const f = await fixture('descriptor'); const input = join(f.root, 'input'); await writeFile(input, 'artifact')
    const handle = await open(input, 'r')
    try {
      await expect(executeControlledProcess({ command: process.execPath, args: [f.path], env: {},
        stdio: ['pipe', 'pipe', 'ignore', handle.fd], stdin: 'request', timeoutMs: 1_000, maximumOutput: 4_096 })).resolves.toBe('artifact:request')
      expect((await handle.stat()).size).toBe(8)
    } finally { await handle.close() }
  })
  test.each([['timeout', 'TIMEOUT'], ['overflow', 'OUTPUT_LIMIT'], ['nonzero', 'NON_ZERO']] as const)(
    'settles %s after stopping the writer and its stdout-holding descendant', async (mode, code) => {
      const f = await fixture(mode); const start = performance.now()
      await expect(f.execute()).rejects.toMatchObject({ code })
      expect(performance.now() - start).toBeLessThan(4_000); await f.stopped()
    })
  test.each(['early-exit', 'background'])('collects a %s descendant even after its parent reports success', async mode => {
    const f = await fixture(mode)
    await expect(f.execute()).resolves.toBe('done'); await f.stopped()
  })
  test('fails within the cleanup bound when a detached descendant retains stdout', async () => {
    const f = await fixture('escaped'); const start = performance.now()
    await expect(f.execute()).rejects.toMatchObject({ code: 'CLEANUP' })
    expect(performance.now() - start).toBeLessThan(4_000)
    // A process group is not a cgroup boundary. Fixture cleanup owns this escaped process.
    expect(await active(Number(await readFile(join(f.root, 'child.pid'), 'utf8')))).toBe(true)
  })
  test('rejects an output overflow delivered after the leader exited during pipe drain', async () => {
    const f = await fixture('escaped-output')
    await expect(f.execute()).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' })
  })
  test('handles early stdin closure and failed spawn as bounded execution errors', async () => {
    const f = await fixture('closed-stdin')
    await expect(executeControlledProcess({ command: process.execPath, args: [f.path], env: {},
      stdio: ['pipe', 'pipe', 'ignore'], stdin: 'x'.repeat(4_000_000), timeoutMs: 1_000, maximumOutput: 1_024 })).rejects.toMatchObject({ code: 'NON_ZERO' })
    await expect(executeControlledProcess({ command: join(f.root, 'missing'), args: [], env: {},
      stdio: ['pipe', 'pipe', 'ignore'], stdin: '', timeoutMs: 1_000, maximumOutput: 1_024 })).rejects.toMatchObject({ code: 'START' })
  })
  test('the public Host runner maps timeout only after the complete process group stops', async () => {
    const f = await fixture('timeout'); await chmod(f.root, 0o700)
    const node = join(f.root, 'node'); await copyFile(await realpath(process.execPath), node); await chmod(node, 0o700)
    const source = await readFile(f.path, 'utf8'); await writeFile(f.path, `#!${node}\n${source}`)
    const identity = { id: 'tree-attestor', version: 'tree-adapter-1', path: f.path, sha256: sha(await readFile(f.path)),
      interpreter: { path: node, sha256: sha(await readFile(node)) }, authority: 'host-fixture', keyId: 'fixture-key' }
    const trust = { hostAttestor: { ...identity, timeoutMs: 1_000, environmentAllowlist: [] } } as unknown as PluginControlTrustConfig
    const request: HostAttestationRequest = { schemaVersion: 1, kind: 'dsh-host-attestation-request', operationId: 'op-1',
      requestedAt: Date.now(), receiptTtlMs: 30_000, installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00',
      ledger: { id: 'ledger', path: join(f.root, 'ledger') }, plan: { id: 'plan', digest: 'a'.repeat(64) },
      activation: { id: 'activation', fence: 1 }, profile: { name: 'fixture', path: f.root },
      issuer: { mode: 'configured-executable', ...identity }, phase: 'readiness', requirements: { kind: 'readiness', minimumChecks: 1 } }
    await expect(invokeConfiguredHostAttestor(trust, request)).rejects.toMatchObject({ name: 'HostAttestorError', code: 'TIMEOUT' })
    await f.stopped()
  })
})
