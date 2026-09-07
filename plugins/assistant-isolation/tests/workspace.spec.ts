import { chmod, link, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { collectArtifacts, normalizeRequest, stageWorkspace } from '../src/workspace.ts'
import type { IsolationLimits, IsolationRequest } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const limits: IsolationLimits = { maxDurationMs: 1_000, maxInputBytes: 32, maxOutputBytes: 1024, maxArtifactBytes: 16, maxFiles: 3, memoryMiB: 64, pidsLimit: 8, cpus: 1 }
const request = (files: IsolationRequest['files'] = [{ path: 'input.txt', content: 'hello' }]): IsolationRequest => ({ grantId: 'grant', idempotencyKey: 'key', command: 'printf ok', files })
const jobId = '00000000-0000-4000-8000-000000000000'
function root(): string { const value = mkdtempSync(join(tmpdir(), 'isolation-workspace-')); roots.push(value); return value }

describe('isolation workspace boundaries', () => {
  it('canonicalizes request fields before digesting and rejects traversal, collisions, and over-budget input', () => {
    const normalized = normalizeRequest({ ...request([{ path: 'z.txt', content: 'a' }, { path: 'a.txt', content: 'b' }]), artifacts: ['z/out', 'a/out'] }, limits)
    expect(normalized.files?.map(file => file.path)).toEqual(['a.txt', 'z.txt'])
    expect(normalized.artifacts).toEqual(['a/out', 'z/out'])
    expect(normalized.timeoutMs).toBe(limits.maxDurationMs)
    expect(() => normalizeRequest({ ...request([{ path: '../escape', content: '' }]) }, limits)).toThrow(/workspace/)
    expect(() => normalizeRequest({ ...request([{ path: 'a', content: '' }, { path: 'a/b', content: '' }]) }, limits)).toThrow(/workspace/)
    expect(() => normalizeRequest({ ...request([{ path: 'a', content: 'x'.repeat(30) }]) }, limits)).toThrow(/workspace/)
    expect(() => normalizeRequest({ ...request(), command: 'x\0y' }, limits)).toThrow(/workspace/)
  })

  it('stages only a fresh private job workspace with 0700 directories and 0600 files', async () => {
    const state = root(); await chmod(state, 0o755)
    const workspace = await stageWorkspace(state, jobId, normalizeRequest(request(), limits))
    const file = await stat(join(workspace, 'input.txt'))
    const directory = await stat(workspace)
    expect(file.mode & 0o777).toBe(0o600)
    expect(directory.mode & 0o777).toBe(0o700)
    await expect(stageWorkspace(state, jobId, normalizeRequest(request(), limits))).rejects.toThrow(/collision/)
  })

  it('collects only regular unlinked files under the workspace and enforces one total byte budget', async () => {
    const workspace = await stageWorkspace(root(), jobId, normalizeRequest(request([]), limits))
    await writeFile(join(workspace, 'one.txt'), 'one')
    await writeFile(join(workspace, 'two.txt'), 'two')
    await expect(collectArtifacts(workspace, ['two.txt', 'one.txt'], limits)).resolves.toEqual([{ path: 'one.txt', content: 'one' }, { path: 'two.txt', content: 'two' }])
    await writeFile(join(workspace, 'large.txt'), 'x'.repeat(17))
    await expect(collectArtifacts(workspace, ['large.txt'], limits)).rejects.toThrow(/workspace/)
    await link(join(workspace, 'one.txt'), join(workspace, 'hard.txt'))
    await expect(collectArtifacts(workspace, ['hard.txt'], limits)).rejects.toThrow(/workspace/)
  })

  it('rejects symlink, symlink-parent, directory, and Unix socket artifact canaries', async () => {
    const workspace = await stageWorkspace(root(), jobId, normalizeRequest(request([]), limits))
    await writeFile(join(workspace, 'file.txt'), 'safe')
    await symlink(join(workspace, 'file.txt'), join(workspace, 'link.txt'))
    await mkdir(join(workspace, 'directory'))
    await mkdir(join(workspace, 'linked-parent'))
    await symlink(join(workspace, 'linked-parent'), join(workspace, 'parent-link'))
    await expect(collectArtifacts(workspace, ['link.txt'], limits)).rejects.toThrow(/workspace/)
    await expect(collectArtifacts(workspace, ['directory'], limits)).rejects.toThrow(/workspace/)
    await expect(collectArtifacts(workspace, ['parent-link/file.txt'], limits)).rejects.toThrow(/workspace/)
    const socket = join(workspace, 'server.sock'); const server = createServer()
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
    try { await expect(collectArtifacts(workspace, ['server.sock'], limits)).rejects.toThrow(/workspace/) } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
})
