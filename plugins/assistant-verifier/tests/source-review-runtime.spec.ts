import { chmod, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, test, vi } from 'vitest'
import { SourceReviewRuntime, validateSourceReviewConfig, type SourceReviewConfig, type SourceReviewRequest } from '../src/source-review.ts'
import { runNativeSourceReview } from '../src/source-review-native.ts'
import { assertSourceReviewHead, inspectSourceReviewGit } from '../src/source-review-git.ts'

vi.mock('../src/source-review-native.ts', () => ({ runNativeSourceReview: vi.fn() }))
vi.mock('../src/source-review-git.ts', () => ({ assertSourceReviewHead: vi.fn(), inspectSourceReviewGit: vi.fn() }))
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.resetAllMocks() })
async function fixture() {
  // macOS 上 os.tmpdir() 经 /var → /private/var；决策根有 canonical 校验。
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-review-runtime-'))), ctx = new Context()
  const owner = { authorityId: 'route', authorityHash: 'a'.repeat(64), principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'main' }
  const config: SourceReviewConfig = { authorityId: 'grant', expiresAt: Date.now() + 60_000, maxReviews: 1,
    repository: root, git: { path: '/usr/bin/git', sha256: 'b'.repeat(64) }, decisionRoot: root, plugins: ['sample'], owner,
    reviewerPrincipal: 'reviewer', policy: 'Review correctness.', maxChangedFiles: 8, maxInputBytes: 32_768, maxOutputTokens: 512, timeoutMs: 10_000 }
  const request: SourceReviewRequest = { protocol: 'dsh-source-review/v1', operationId: 'op', planId: 'plan', planDigest: 'c'.repeat(64),
    releaseId: 'release', fence: 1, revision: 1, name: 'sample', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), prId: 'pr-1',
    prEvidenceDigest: 'd'.repeat(64), checkedTreeDigest: 'e'.repeat(64), checkedPatchDigest: 'f'.repeat(64), scope: ['plugins/sample'],
    source: { owner: { ...owner, receiptVersion: 2, bindingVersion: 1, generation: 1 }, outcomeId: 'task', sourceDigest: '0'.repeat(64),
      objective: 'Fix the actual user task', modelSelection: { provider: 'supplier', model: 'task-model', reasoningEffort: 'high' } } }
  const runtimes: SourceReviewRuntime[] = []
  const open = (override: Partial<SourceReviewConfig> = {}) => {
    const runtime = new SourceReviewRuntime(ctx, { ...config, ...override }, join(root, 'verifier.sqlite')); runtimes.push(runtime); return runtime
  }
  cleanups.push(async () => { for (const runtime of runtimes) await runtime.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  vi.mocked(inspectSourceReviewGit).mockResolvedValue({ patch: '+ fix', changedPaths: ['plugins/sample/index.ts'], digest: request.checkedPatchDigest })
  vi.mocked(runNativeSourceReview).mockResolvedValue({ status: 'approved', reason: 'The scoped fix is sound.', outputDigest: '1'.repeat(64) })
  let current = true, depth = 0
  const withSourceFence = <T>(callback: () => T): T => {
    if (!current) throw new Error('source withdrawn')
    if (depth !== 0) throw new Error('nested writer fence')
    depth++; try { const result = callback(); if (result instanceof Promise) throw new Error('async writer fence'); return result } finally { depth-- }
  }
  return { root, config, request, open, selection: { decisionRoot: root, owner: request.source.owner, name: request.name, modelSelection: request.source.modelSelection! }, input: { request, withSourceFence }, withdraw: () => { current = false } }
}

test('inherits the task model, writes an exact private decision, and recovers it without another model call', async () => {
  const f = await fixture(), first = f.open()
  expect(first.available(f.selection)).toBe(true)
  expect(first.available({ decisionRoot: f.root, owner: f.request.source.owner, name: f.request.name })).toBe(false)
  expect(first.available({ ...f.selection, decisionRoot: join(f.root, 'wrong') })).toBe(false)
  expect(first.available({ ...f.selection, owner: { ...f.selection.owner, principalId: 'another' } })).toBe(false)
  expect(first.available({ ...f.selection, name: 'another' })).toBe(false)
  expect((await first.run(f.input)).status).toBe('approved')
  expect(first.available(f.selection)).toBe(false)
  expect(first.available({ ...f.selection, operationId: f.request.operationId })).toBe(true)
  expect(vi.mocked(runNativeSourceReview).mock.calls[0]![1].model).toEqual(f.request.source.modelSelection)
  const path = join(f.root, 'pr-1.json'), decision = JSON.parse(await readFile(path, 'utf8'))
  expect(decision).toEqual({ schemaVersion: 1, kind: 'dsh-local-review-decision', prId: 'pr-1', baseCommit: f.request.baseCommit,
    headCommit: f.request.headCommit, prEvidenceDigest: f.request.prEvidenceDigest, decision: 'approved', reviewerPrincipal: 'reviewer' })
  await rm(path); await first.close()
  expect((await f.open().run(f.input)).status).toBe('approved')
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(decision)
  expect(runNativeSourceReview).toHaveBeenCalledTimes(1)
  expect(assertSourceReviewHead).toHaveBeenCalledTimes(4)
})

test('a fixed model can review missing inherited selection; absent model cannot dispatch', async () => {
  const f = await fixture(); delete f.request.source.modelSelection
  await expect(f.open().run(f.input)).rejects.toThrow('frozen task model')
  expect(runNativeSourceReview).not.toHaveBeenCalled()
  const fixed = { provider: 'supplier', model: 'fixed-review' }, runtime = f.open({ model: fixed })
  expect(runtime.available({ decisionRoot: f.root, owner: f.request.source.owner, name: f.request.name })).toBe(true)
  expect((await runtime.run(f.input)).status).toBe('approved')
  expect(vi.mocked(runNativeSourceReview).mock.calls[0]![1].model).toEqual(fixed)
})

test('a lost model result stays unknown across restart, and consumes finite quota', async () => {
  const f = await fixture(), first = f.open(); vi.mocked(runNativeSourceReview).mockRejectedValue(new Error('lost result'))
  expect((await first.run(f.input)).status).toBe('unknown'); await first.close()
  const next = f.open(); expect((await next.run(f.input)).status).toBe('unknown')
  expect(runNativeSourceReview).toHaveBeenCalledTimes(1)
  await expect(next.run({ ...f.input, request: { ...f.request, operationId: 'other' } })).rejects.toThrow('quota')
})

test('withdrawn source and changed Git head cannot produce a decision after model completion', async () => {
  const f = await fixture(); vi.mocked(runNativeSourceReview).mockImplementation(async () => {
    f.withdraw(); return { status: 'approved', reason: 'looks good', outputDigest: '1'.repeat(64) }
  })
  expect((await f.open().run(f.input)).status).toBe('unknown')
  await expect(readFile(join(f.root, 'pr-1.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  const second = await fixture()
  vi.mocked(assertSourceReviewHead).mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('head changed') })
  expect((await second.open().run(second.input)).status).toBe('unknown')
  await expect(readFile(join(second.root, 'pr-1.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('does not overwrite an existing conflicting decision or follow a symlink', async () => {
  const f = await fixture(); await symlink(join(f.root, 'target'), join(f.root, 'pr-1.json'))
  expect((await f.open().run(f.input)).status).toBe('unknown')
  await expect(readFile(join(f.root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('close aborts and drains a model call before closing its ledger', async () => {
  const f = await fixture(), runtime = f.open()
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve })
  vi.mocked(runNativeSourceReview).mockImplementation(async (_ctx, input) => {
    started(); await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }))
    input.signal.throwIfAborted(); throw new Error('unreachable')
  })
  const running = runtime.run(f.input); await ready; await runtime.close()
  expect((await running).status).toBe('unknown')
  expect(() => runtime.run(f.input)).toThrow('disposed')
  expect((await f.open().run(f.input)).status).toBe('unknown')
})

test('validates finite authority, owner scope and private decision roots before dispatch', async () => {
  const f = await fixture()
  expect(() => validateSourceReviewConfig({ ...f.config, maxReviews: 0 })).toThrow('bound')
  await expect(f.open().run({ ...f.input, request: { ...f.request, name: 'another' } })).rejects.toThrow('scope')
  await chmod(f.root, 0o755); expect(() => validateSourceReviewConfig(f.config)).toThrow('private')
  expect(runNativeSourceReview).not.toHaveBeenCalled()
})
