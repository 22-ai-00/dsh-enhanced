import { chmod, rm, stat } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeRequest, stageWorkspace } from '../src/workspace.ts'
import { validateConfig } from '../src/config.ts'
import type { IsolationLimits, IsolationRequest } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const limits: IsolationLimits = { maxDurationMs: 1_000, maxInputBytes: 64, maxOutputBytes: 1024, maxArtifactBytes: 16, maxFiles: 3, memoryMiB: 64, workspaceMiB: 4, workspaceInodes: 64, pidsLimit: 8, cpus: 1 }
const request = (files: IsolationRequest['files'] = [{ path: 'input.txt', content: 'hello' }]): IsolationRequest => ({ grantId: 'grant', idempotencyKey: 'key', command: 'printf ok', files })
const jobId = '00000000-0000-4000-8000-000000000000'
function root(): string { const value = mkdtempSync(join(tmpdir(), 'isolation-workspace-')); roots.push(value); return value }

describe('isolation workspace boundaries', () => {
  it('rejects invalid workspace/pool bounds and counts staged parent directories before creation', () => {
    expect(validateConfig({}).limits).toMatchObject({ workspaceMiB: 64, workspaceInodes: 4096 })
    for (const value of [0, -1, 1.5, NaN, Infinity, 1025]) expect(() => validateConfig({ limits: { workspaceMiB: value } })).toThrow(/limits/)
    expect(() => validateConfig({ maxReservedMemoryMiB: 351 })).toThrow(/pool/)
    expect(() => validateConfig({ maxReservedWorkspaceInodes: 4095 })).toThrow(/pool/)
    const nested = request([{ path: 'a/b/c', content: '' }])
    expect(() => normalizeRequest(nested, { ...limits, workspaceInodes: 3 })).toThrow(/inode/)
    expect(normalizeRequest(nested, { ...limits, workspaceInodes: 4 }).files).toEqual(nested.files)
    expect(() => normalizeRequest(request([{ path: 'a'.repeat(64), content: '' }]), limits)).toThrow(/input/)
  })

  it('canonicalizes request fields before digesting and rejects traversal, collisions, and over-budget input', () => {
    const normalized = normalizeRequest({ ...request([{ path: 'z.txt', content: 'a' }, { path: 'a.txt', content: 'b' }]), artifacts: ['z/out', 'a/out'] }, limits)
    expect(normalized.files?.map(file => file.path)).toEqual(['a.txt', 'z.txt'])
    expect(normalized.artifacts).toEqual(['a/out', 'z/out'])
    expect(normalized.timeoutMs).toBe(limits.maxDurationMs)
    expect(() => normalizeRequest({ ...request([{ path: '../escape', content: '' }]) }, limits)).toThrow(/workspace/)
    expect(() => normalizeRequest({ ...request([{ path: 'a', content: '' }, { path: 'a/b', content: '' }]) }, limits)).toThrow(/workspace/)
    expect(() => normalizeRequest({ ...request([{ path: 'a', content: 'x'.repeat(64) }]) }, limits)).toThrow(/workspace/)
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

})
