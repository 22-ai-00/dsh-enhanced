import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { Ed25519SourceReleaseAuthorizationAuthority, Ed25519SourceReleaseAuthority } from '../src/release.ts'
import { ControlPlaneStore } from '../src/store.ts'
import type { SourceReleaseAuthorization, SourceReleaseReceipt } from '../src/types.ts'
import * as release from '../src/release.ts'
import { advanceSourceRelease } from '../src/source-release-runner.ts'
import { cleanupReleaseFixtures, fixture } from './helpers/source-release-runner.ts'

vi.mock('../src/release.ts', async original => ({ ...await original<typeof release>(), invokeSourceReleaseAdapter: vi.fn() }))

afterEach(cleanupReleaseFixtures)

function authorities(trust: Awaited<ReturnType<typeof fixture>>['options']['trust']) {
  return {
    authorization: (value: SourceReleaseAuthorization) => {
      const key = trust.releaseAuthorizationKeys!.find(item => item.authority === value.authority && item.keyId === value.keyId)!
      return new Ed25519SourceReleaseAuthorizationAuthority(key.publicKeyPem, key.authority, key.keyId)
    },
    receipt: (value: SourceReleaseReceipt) => {
      const key = trust.releaseKeys!.find(item => item.authority === value.authority && item.keyId === value.keyId)!
      return new Ed25519SourceReleaseAuthority(key.publicKeyPem, key.authority, key.keyId)
    },
  }
}

test('requires the Host owner admission before a release operation can be prepared', async () => {
  const f = await fixture(true)
  await expect(advanceSourceRelease({ ...f.options, withSourceFence: callback => callback() })).rejects.toThrow('Host admission')
  expect(f.store.findSourceReleaseOperation(f.plan.id, 'pr', 1)).toBeUndefined()
  expect(vi.mocked(release.invokeSourceReleaseAdapter)).not.toHaveBeenCalled()
})

test('keeps a revoked owner release claimed and does not dispatch it again after restart', async () => {
  const f = await fixture(true)
  let saved: SourceReleaseReceipt | undefined
  vi.mocked(release.invokeSourceReleaseAdapter).mockImplementationOnce(async (_trust, request) => {
    saved = await f.execute(request)
    f.setSourceCurrent(false)
    return saved
  })
  await expect(advanceSourceRelease(f.options)).rejects.toThrow('owner source changed')
  const operation = f.store.findSourceReleaseOperation(f.plan.id, 'pr', 1)!
  expect(f.store.getSourceReleaseDispatchStatus(operation.operationId)).toBe('claimed')
  expect(saved).toBeDefined()
  const recovered = new ControlPlaneStore({ path: join(f.root, 'control.sqlite') })
  try {
    await expect(recovered.runSourceReleaseOperation({ operationId: operation.operationId, expectedRevision: f.plan.revision, expectedFence: 1,
      execute: async () => { throw new Error('must not redispatch') }, resolveAuthority: authorities(f.options.trust).receipt,
      resolveAuthorizationAuthority: authorities(f.options.trust).authorization, withSourceFence: callback => callback() })).rejects.toThrow('Host admission')
  } finally { recovered.close() }
  expect(vi.mocked(release.invokeSourceReleaseAdapter)).toHaveBeenCalledTimes(1)
})

test('accepts an exact signed receipt only through current owner admission, then fences replay', async () => {
  const f = await fixture(true)
  let saved: SourceReleaseReceipt | undefined
  vi.mocked(release.invokeSourceReleaseAdapter).mockImplementationOnce(async (_trust, request) => {
    saved = await f.execute(request)
    throw new Error('lost adapter response')
  })
  await expect(advanceSourceRelease(f.options)).rejects.toThrow('lost adapter response')
  const operation = f.store.findSourceReleaseOperation(f.plan.id, 'pr', 1)!
  const authority = authorities(f.options.trust)
  await expect(f.store.acceptSourceReleaseReceipt({ operationId: operation.operationId, expectedRevision: f.plan.revision, expectedFence: 1,
    receipt: saved!, resolveAuthority: authority.receipt, resolveAuthorizationAuthority: authority.authorization })).rejects.toThrow('Host admission')
  await f.store.acceptSourceReleaseReceipt({ operationId: operation.operationId, expectedRevision: f.plan.revision, expectedFence: 1,
    receipt: saved!, resolveAuthority: authority.receipt, resolveAuthorizationAuthority: authority.authorization, withSourceFence: f.options.withSourceFence })
  const applied = await f.store.applySourceRelease({ planId: f.plan.id, expectedRevision: f.plan.revision, expectedFence: 1,
    receipt: saved!, resolveAuthority: authority.receipt, idempotencyKey: `source-release:${operation.operationId}`, withSourceFence: f.options.withSourceFence })
  expect(applied.result.status).toBe('awaiting-review')
  f.setSourceCurrent(false)
  await expect(f.store.applySourceRelease({ planId: f.plan.id, expectedRevision: f.plan.revision, expectedFence: 1,
    receipt: saved!, resolveAuthority: authority.receipt, idempotencyKey: `source-release:${operation.operationId}`, withSourceFence: callback => callback() })).rejects.toThrow('Host admission')
  expect(vi.mocked(release.invokeSourceReleaseAdapter)).toHaveBeenCalledTimes(1)
})
