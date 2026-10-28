import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { LinuxRepositoryRunner, type LinuxRepositoryRunnerConfig } from '../src/linux-repository-runner.js'
import { linuxRepositoryImplementationDigest } from '../src/linux-user-namespace.js'
import { linuxRuntimeFixture } from './helpers/linux-runtime-fixture.js'

const runtimeFile = process.env.DSH_LINUX_REPOSITORY_RUNTIME_JSON
const real = process.platform === 'linux' && process.env.DSH_NATIVE_CGROUP_REAL === '1' && !!runtimeFile

test.runIf(process.platform === 'linux' && (process.getuid?.() ?? 0) > 0)('explicit invalid identity fields cannot downgrade to the legacy runner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runner-invalid-identity-'))
  try {
    const { runtime, cgroupRoots } = await linuxRuntimeFixture(root)
    const input = { backend: 'linux-native', runtime, cgroupRoots,
      stateRoot: join(root, 'state'), authorityDigest: 'a'.repeat(64), expiresAt: Date.now() + 60_000,
      maxRuns: 1, maxTotalDurationMs: 60_000,
      limits: { maxDurationMs: 60_000, maxInputBytes: 64 * 1024 ** 2, maxOutputBytes: 4096,
        maxArtifactBytes: 32 * 1024 ** 2, maxFiles: 8, memoryMiB: 256, pidsLimit: 64, cpus: 1,
        workspaceMiB: 8, workspaceInodes: 256, tmpMiB: 8, tmpInodes: 128, inputMiB: 65, inputInodes: 16 } }
    for (const invalid of [null, false, 0, '']) {
      expect(() => new LinuxRepositoryRunner({ ...input, userNamespace: invalid, systemSnapshot: invalid } as unknown as LinuxRepositoryRunnerConfig)).toThrow()
      await expect(lstat(input.stateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

describe.skipIf(!real)('finite repository runner with dual kernel identity', () => {
  test('keeps the original proof, binary receipt and spent grant across reopening without replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-runner-identity-'))
    const decoded = JSON.parse(await readFile(runtimeFile!, 'utf8')) as {
      environment: Required<Pick<LinuxRepositoryRunnerConfig, 'runtime' | 'systemSnapshot' | 'userNamespace'>> }
    const { runtime, systemSnapshot, userNamespace } = decoded.environment
    const uid = process.getuid!()
    const cgroupRoots = { mode: 'v1' as const, cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${uid}`,
      memory: `/sys/fs/cgroup/memory/dsh-native/uid-${uid}`, pids: `/sys/fs/cgroup/pids/dsh-native/uid-${uid}`,
      freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${uid}` }
    const input: LinuxRepositoryRunnerConfig = { backend: 'linux-native', runtime, cgroupRoots,
      stateRoot: join(root, 'state'), authorityDigest: 'a'.repeat(64), expiresAt: Date.now() + 180_000,
      maxRuns: 1, maxTotalDurationMs: 60_000, userNamespace, systemSnapshot,
      limits: { maxDurationMs: 60_000, maxInputBytes: 64 * 1024 ** 2, maxOutputBytes: 4096,
        maxArtifactBytes: 32 * 1024 ** 2, maxFiles: 8, memoryMiB: 256, pidsLimit: 64, cpus: 1,
        workspaceMiB: 8, workspaceInodes: 256, tmpMiB: 8, tmpInodes: 128, inputMiB: 65, inputInodes: 16 } }
    const payload = Buffer.from([0, 255, 128, 3])
    const request = { argv: ['/bin/sh', '-ec', 'cat /input/source.tar > package.tgz; /runtime/0/bin/node -e "console.log(process.getuid())"'],
      archive: { bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') }, artifacts: ['package.tgz'] }
    let current: LinuxRepositoryRunner | undefined, clean = false, loads = 0
    try {
      const otherRoot = await mkdtemp(join(root, 'other-runtime-'))
      const other = await linuxRuntimeFixture(otherRoot)
      const mismatched = { ...input, stateRoot: join(root, 'mismatched-state'), runtime: other.runtime }
      current = new LinuxRepositoryRunner(mismatched)
      await expect(current.run('unpaired', request, async () => { loads++; return payload }, new AbortController().signal))
        .rejects.toThrow('pinned runtime Node')
      await current.close(); current = undefined
      const untouched = new DatabaseSync(join(mismatched.stateRoot, 'ledger.sqlite'), { readOnly: true })
      try { expect(untouched.prepare('SELECT COUNT(*) AS n FROM isolation_jobs').get()?.n).toBe(0) }
      finally { untouched.close() }
      expect(loads).toBe(0)
      current = new LinuxRepositoryRunner(input)
      const first = await current.run('source-job', request, async () => { loads++; return payload }, new AbortController().signal)
      expect(first.result, JSON.stringify(first.result)).toMatchObject({ status: 'succeeded', quiescent: true, stdout: '65534\n' })
      expect(first.artifacts[0]?.bytes.equals(payload)).toBe(true)
      expect(first.receiptBinding?.receiptDigest).toMatch(/^[a-f0-9]{64}$/u)
      expect(await current.inspectQuiescence('source-job')).toBe('quiescent')
      await current.close(); current = undefined

      // Old execution schemas cannot reinterpret this ledger or reset its grant.
      const { userNamespace: _mapping, systemSnapshot: _snapshot, ...legacy } = input
      expect(() => new LinuxRepositoryRunner(legacy)).toThrow('foreign authority or backend')
      current = new LinuxRepositoryRunner(input)
      const cached = await current.run('source-job', request, async () => { loads++; throw new Error('must not replay') }, new AbortController().signal)
      expect(cached.result).toEqual(first.result)
      expect(cached.receiptBinding).toEqual(first.receiptBinding)
      expect(cached.contractDigest).toBe(first.contractDigest)
      expect(cached.artifacts[0]?.bytes.equals(payload)).toBe(true)
      await expect(current.run('new-key', request, async () => { loads++; return payload }, new AbortController().signal)).rejects.toThrow('budget')
      expect(loads).toBe(1)
      const db = new DatabaseSync(join(input.stateRoot, 'ledger.sqlite'), { readOnly: true })
      try {
        const rows = db.prepare('SELECT linux_contract_json,linux_resources_json,linux_intent_json,reserved_duration_ms FROM isolation_jobs').all()
        expect(rows).toHaveLength(1)
        const row = rows[0]!, contract = JSON.parse(row.linux_contract_json as string)
        const resources = JSON.parse(row.linux_resources_json as string), intent = JSON.parse(row.linux_intent_json as string)
        expect(contract).toMatchObject({ schemaVersion: 3, implementationDigest: linuxRepositoryImplementationDigest(),
          userNamespace: input.userNamespace, systemSnapshot: input.systemSnapshot })
        expect(resources).toMatchObject({ schemaVersion: 2, userNamespace: { witness: { mapping: input.userNamespace } } })
        expect(row.reserved_duration_ms).toBe(60_000)
        for (const group of [resources.worker, resources.keeper]) for (const directory of Object.values(group.directories) as { path: string }[]) {
          await expect(lstat(directory.path)).rejects.toMatchObject({ code: 'ENOENT' })
        }
        await expect(lstat(intent.namespacePath)).rejects.toMatchObject({ code: 'ENOENT' })
        clean = true
      } finally { db.close() }
    } finally {
      await current?.close()
      // Preserve private recovery evidence if any resource proof failed.
      if (clean) await rm(root, { recursive: true, force: true })
    }
  }, 180_000)
})
