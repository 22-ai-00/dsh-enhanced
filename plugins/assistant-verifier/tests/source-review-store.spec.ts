import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { SourceReviewStore } from '../src/source-review-store.ts'

const roots: string[] = [], stores: SourceReviewStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'review-ledger-')); roots.push(root)
  const path = join(root, 'review.sqlite')
  const open = () => { const store = new SourceReviewStore(path); stores.push(store); return store }
  const input = { operationId: 'operation', requestDigest: 'a'.repeat(64), authorityId: 'grant', authorityDigest: 'b'.repeat(64), maxReviews: 1,
    model: { provider: 'supplier', model: 'task-model' } }
  return { root, path, open, input }
}
const result = { status: 'approved' as const, reason: 'The scoped fix preserves resource ownership.', outputDigest: 'c'.repeat(64) }

test('persists unknown claims and immutable natural-language terminal replay', async () => {
  const f = await fixture(), first = f.open()
  expect(first.claim(f.input)).toEqual({ state: 'claimed' }); first.close(); first.close()
  const next = f.open(); expect(next.claim(f.input)).toEqual({ state: 'unknown' })
  next.finish(f.input.operationId, f.input.requestDigest, result)
  expect(next.claim({ ...f.input, model: { model: 'task-model', provider: 'supplier' } })).toEqual({ state: 'approved',
    result: { reason: result.reason, outputDigest: result.outputDigest } })
  expect(() => next.finish(f.input.operationId, f.input.requestDigest, { ...result, status: 'rejected' })).toThrow('differs')
  expect(() => next.claim({ ...f.input, operationId: 'other' })).toThrow('quota')
})

test.each(['claimed', 'approved'] as const)('freezes authority and request binding on %s replay', async status => {
  const f = await fixture(), store = f.open(); store.claim(f.input)
  if (status === 'approved') store.finish(f.input.operationId, f.input.requestDigest, result)
  for (const override of [{ authorityDigest: 'd'.repeat(64) }, { maxReviews: 2 }, { requestDigest: 'e'.repeat(64) },
    { model: { provider: 'other', model: 'task-model' } }]) expect(() => store.claim({ ...f.input, ...override })).toThrow('differs')
})

test('two connections atomically share grant quota and cannot repeat a live claim', async () => {
  const f = await fixture(), first = f.open(), second = f.open()
  expect(first.claim(f.input).state).toBe('claimed')
  expect(second.claim(f.input).state).toBe('unknown')
  expect(() => second.claim({ ...f.input, operationId: 'other' })).toThrow('quota')
})

test('refuses symlink databases, parents, sidecars and nonprivate directories before opening SQLite', async () => {
  const f = await fixture(), target = join(f.root, 'target'); await writeFile(target, '', { mode: 0o600 })
  await symlink(target, f.path); expect(() => f.open()).toThrow('private'); await rm(f.path)
  const alias = join(f.root, 'alias'); await symlink(f.root, alias)
  expect(() => new SourceReviewStore(join(alias, 'x.sqlite'))).toThrow('private')
  await symlink(target, f.path + '-wal'); expect(() => f.open()).toThrow('private'); await rm(f.path + '-wal')
  await chmod(f.root, 0o755); expect(() => f.open()).toThrow('private')
})
