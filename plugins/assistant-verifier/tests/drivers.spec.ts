import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import { createVerifierAuthorities, verifyAcceptanceCriteria, type VerifierAuthority } from '../src/drivers.ts'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const cleanup: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function directory(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'assistant-verifier-')); cleanup.push(path); return path }
async function server(body: string): Promise<{ url: string; hits: () => number }> {
  let requests = 0
  const instance = createServer((_request, response) => { requests++; response.setHeader('content-type', 'application/json'); response.end(body) })
  instance.listen(0, '127.0.0.1'); await once(instance, 'listening'); servers.push(instance)
  const address = instance.address(); if (address === null || typeof address === 'string') throw new Error('server did not bind')
  return { url: `http://127.0.0.1:${address.port}/proof`, hits: () => requests }
}
function contract(workspace: string, criteria: TaskAcceptanceContract['criteria']): TaskAcceptanceContract {
  return {
    protocol: 'task-acceptance/v1', id: 'contract-1', scope: { workspace, preset: 'test' }, owner: { principalRecordId: 'owner-1', principalVersion: 1 },
    task: { kind: 'automation-run', ref: 'run-1' }, objective: 'exact objective', profile: { id: 'profile-1', version: 1, digest: 'a'.repeat(64) },
    issuedAt: 1, expiresAt: 10_000, criteria, bounds: { maxDurationMs: 2_000, maxEvidenceBytes: 16_384 }, digest: 'b'.repeat(64),
  }
}
function ref(authority: VerifierAuthority) { return { id: authority.id, digest: authority.digest } }

describe('independent verifier drivers', () => {
  it('requires exact executable behavior instead of accepting exit zero', async () => {
    const workspace = await directory(); const artifact = join(workspace, 'result.txt'); const program = join(workspace, 'check.mjs')
    await writeFile(artifact, 'artifact')
    await writeFile(program, "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('wrong'))")
    const [runner] = createVerifierAuthorities({ authorities: [{ kind: 'runner', id: 'runner', executable: realpathSync(process.execPath), fixedArgs: [program], timeoutMs: 1_000, maxOutputBytes: 1_024 }] })
    if (runner === undefined) throw new Error('missing runner')
    const result = await verifyAcceptanceCriteria(contract(workspace, [{ id: 'process', kind: 'process-behavior', authority: ref(runner), artifactPath: 'result.txt', stdin: 'input', expectedStdout: 'expected', expectedExitCode: 0 }]), [runner], new AbortController().signal)
    expect(result).toMatchObject([{ status: 'failed', reason: 'unexpected-stdout' }])
  })

  it('runs a captured artifact snapshot even if the original is replaced and restored', async () => {
    const workspace = await directory(); const artifact = join(workspace, 'result.txt'); const program = join(workspace, 'mutate.mjs')
    await writeFile(artifact, 'before'); await writeFile(program, "import { readFileSync, writeFileSync } from 'node:fs'; const original = process.argv[2]; const snapshot = process.argv.at(-1); writeFileSync(original, 'after'); process.stdout.write(readFileSync(snapshot)); writeFileSync(original, 'before')")
    const [runner] = createVerifierAuthorities({ authorities: [{ kind: 'runner', id: 'runner', executable: realpathSync(process.execPath), fixedArgs: [program, artifact], timeoutMs: 1_000, maxOutputBytes: 1_024 }] })
    if (runner === undefined) throw new Error('missing runner')
    const criteria = [
      { id: 'snapshot', kind: 'process-behavior' as const, authority: ref(runner), artifactPath: 'result.txt', stdin: '', expectedStdout: 'before', expectedExitCode: 0 },
      { id: 'escape', kind: 'process-behavior' as const, authority: ref(runner), artifactPath: '../outside', stdin: '', expectedStdout: 'ok', expectedExitCode: 0 },
    ]
    const result = await verifyAcceptanceCriteria(contract(workspace, criteria), [runner], new AbortController().signal)
    expect(result).toMatchObject([{ status: 'passed' }, { status: 'unknown', reason: 'artifact-unavailable' }])
    await expect(readFile(artifact, 'utf8')).resolves.toBe('before')
  })

  it('independently checks configured sources and document citations', async () => {
    const workspace = await directory(); const source = 'primary source quote'; const remote = await server(source)
    const artifact = join(workspace, 'report.md'); await writeFile(artifact, `required text\n${source}\n${remote.url}`)
    const [authority] = createVerifierAuthorities({ authorities: [{ kind: 'document', id: 'docs', sources: [{ id: 'primary', url: remote.url }], timeoutMs: 1_000, maxResponseBytes: 1_024, allowHttpLoopback: true }] })
    if (authority === undefined) throw new Error('missing authority')
    const criterion = { id: 'document', kind: 'document-citations' as const, authority: ref(authority), artifactPath: 'report.md', requiredText: ['required text'], quotes: [{ quote: source, sourceId: 'primary', sourceSha256: hash(source) }] }
    await expect(verifyAcceptanceCriteria(contract(workspace, [criterion]), [authority], new AbortController().signal)).resolves.toMatchObject([{ status: 'passed' }])
    expect(remote.hits()).toBe(1)
    const wrongDigest = { ...criterion, id: 'wrong-digest', quotes: [{ ...criterion.quotes[0]!, sourceSha256: 'f'.repeat(64) }] }
    await expect(verifyAcceptanceCriteria(contract(workspace, [wrongDigest]), [authority], new AbortController().signal)).resolves.toMatchObject([{ status: 'failed', reason: 'citation-mismatch' }])
  })

  it('reads exactly the configured target, rejects mismatches, and does no IO on an authority digest mismatch', async () => {
    const workspace = await directory(); const remote = await server(JSON.stringify({ id: 'object/1', revision: 'r1', state: { ready: true } }))
    const [authority] = createVerifierAuthorities({ authorities: [{ kind: 'readback', id: 'target', urlTemplate: `${remote.url}/{id}`, objectIdPointer: '/id', revisionPointer: '/revision', timeoutMs: 1_000, maxResponseBytes: 1_024, allowHttpLoopback: true }] })
    if (authority === undefined) throw new Error('missing authority')
    const criterion = { id: 'target', kind: 'target-readback' as const, authority: ref(authority), objectId: 'object/1', expectedRevision: 'r1', expected: [{ pointer: '/state/ready', value: true }] }
    await expect(verifyAcceptanceCriteria(contract(workspace, [criterion]), [authority], new AbortController().signal)).resolves.toMatchObject([{ status: 'passed' }])
    const wrong = { ...criterion, id: 'wrong', expected: [{ pointer: '/state/ready', value: false }] }
    await expect(verifyAcceptanceCriteria(contract(workspace, [wrong]), [authority], new AbortController().signal)).resolves.toMatchObject([{ status: 'failed', reason: 'readback-value-mismatch' }])
    const mismatched = { ...criterion, id: 'no-io', authority: { id: authority.id, digest: '0'.repeat(64) } }
    const before = remote.hits()
    await expect(verifyAcceptanceCriteria(contract(workspace, [mismatched]), [authority], new AbortController().signal)).resolves.toMatchObject([{ status: 'unknown', reason: 'authority-mismatch' }])
    expect(remote.hits()).toBe(before)
  })

  it('honors pre-abort without starting a configured network read', async () => {
    const workspace = await directory(); const remote = await server(JSON.stringify({ id: 'object', value: 1 }))
    const [authority] = createVerifierAuthorities({ authorities: [{ kind: 'readback', id: 'target', urlTemplate: `${remote.url}/{id}`, objectIdPointer: '/id', timeoutMs: 1_000, maxResponseBytes: 1_024, allowHttpLoopback: true }] })
    if (authority === undefined) throw new Error('missing authority')
    const controller = new AbortController(); controller.abort(new Error('cancelled'))
    const criterion = { id: 'cancelled', kind: 'target-readback' as const, authority: ref(authority), objectId: 'object', expected: [{ pointer: '/value', value: 1 }] }
    await expect(verifyAcceptanceCriteria(contract(workspace, [criterion]), [authority], controller.signal)).resolves.toMatchObject([{ status: 'unknown', reason: 'verification-aborted' }])
    expect(remote.hits()).toBe(0)
  })

  it('rejects placeholders outside the one encoded readback path segment', () => {
    expect(() => createVerifierAuthorities({ authorities: [{ kind: 'document', id: 'docs', sources: [{ id: 'source', url: 'https://{id}.example.test/proof' }], timeoutMs: 1_000, maxResponseBytes: 1_024 }] }))
      .toThrow(/placeholder/i)
    expect(() => createVerifierAuthorities({ authorities: [{ kind: 'readback', id: 'target', urlTemplate: 'https://example.test/objects/{id}?next={other}', objectIdPointer: '/id', timeoutMs: 1_000, maxResponseBytes: 1_024 }] }))
      .toThrow(/placeholder/i)
  })

  it('terminates a timed-out process and reports an unknown result', async () => {
    const workspace = await directory(); const artifact = join(workspace, 'result.txt'); const program = join(workspace, 'slow.mjs')
    await writeFile(artifact, 'artifact'); await writeFile(program, "setTimeout(() => process.stdout.write('late'), 2_000)")
    const [runner] = createVerifierAuthorities({ authorities: [{ kind: 'runner', id: 'runner', executable: realpathSync(process.execPath), fixedArgs: [program], timeoutMs: 30, maxOutputBytes: 1_024 }] })
    if (runner === undefined) throw new Error('missing runner')
    const criterion = { id: 'slow', kind: 'process-behavior' as const, authority: ref(runner), artifactPath: 'result.txt', stdin: '', expectedStdout: 'late', expectedExitCode: 0 }
    await expect(verifyAcceptanceCriteria(contract(workspace, [criterion]), [runner], new AbortController().signal)).resolves.toMatchObject([{ status: 'unknown' }])
  })

  it('settles on deadline when an escaped descendant retains stdout', async () => {
    const workspace = await directory(); const artifact = join(workspace, 'result.txt'); const program = join(workspace, 'escape.mjs'); const marker = join(workspace, 'descendant.pid')
    try {
      await writeFile(artifact, 'artifact')
      await writeFile(program, `import { spawn } from 'node:child_process'; import { writeFile } from 'node:fs/promises'; const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] }); await writeFile(${JSON.stringify(marker)}, String(child.pid)); child.unref(); process.exit(0)`)
      const [runner] = createVerifierAuthorities({ authorities: [{ kind: 'runner', id: 'runner', executable: realpathSync(process.execPath), fixedArgs: [program], timeoutMs: 50, maxOutputBytes: 1_024 }] })
      if (runner === undefined) throw new Error('missing runner')
      const criterion = { id: 'escape', kind: 'process-behavior' as const, authority: ref(runner), artifactPath: 'result.txt', stdin: '', expectedStdout: '', expectedExitCode: 0 }
      const started = Date.now()
      const result = await verifyAcceptanceCriteria(contract(workspace, [criterion]), [runner], new AbortController().signal)
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(result).toMatchObject([{ status: 'unknown', reason: 'verification-aborted' }])
    } finally {
      const pid = Number(await readFile(marker, 'utf8').catch(() => '0'))
      if (pid > 0) try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
  })

  it('rejects symlink artifacts before an executable can consume them', async () => {
    const workspace = await directory(); const outside = join(workspace, '..', `outside-${Date.now()}`); const artifact = join(workspace, 'link'); const program = join(workspace, 'check.mjs')
    await writeFile(outside, 'outside'); cleanup.push(outside); await symlink(outside, artifact); await writeFile(program, "process.stdout.write('ok')")
    const [runner] = createVerifierAuthorities({ authorities: [{ kind: 'runner', id: 'runner', executable: realpathSync(process.execPath), fixedArgs: [program], timeoutMs: 1_000, maxOutputBytes: 1_024 }] })
    if (runner === undefined) throw new Error('missing runner')
    const criterion = { id: 'link', kind: 'process-behavior' as const, authority: ref(runner), artifactPath: 'link', stdin: '', expectedStdout: 'ok', expectedExitCode: 0 }
    await expect(verifyAcceptanceCriteria(contract(workspace, [criterion]), [runner], new AbortController().signal)).resolves.toMatchObject([{ status: 'unknown', reason: 'artifact-unavailable' }])
  })
})
