import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import * as release from '../src/release.ts'
import { advanceSourceRelease, sourceReleaseAuthorities } from '../src/source-release-runner.ts'
import { ControlPlaneStore } from '../src/store.ts'
import { cleanupReleaseFixtures, fixture } from './helpers/source-release-runner.ts'
vi.mock('../src/release.ts', async original => ({ ...await original<typeof release>(), invokeSourceReleaseAdapter: vi.fn() }))
afterEach(cleanupReleaseFixtures)

test('v17 migration preserves completed receipts and makes historical pending dispatch uncertain until signed reconciliation', async () => {
  const f = await fixture(); await advanceSourceRelease(f.options)
  const pr = f.store.findSourceReleaseOperation(f.plan.id, 'pr', 1)!, review = f.store.findSourceReleaseOperation(f.plan.id, 'review', 1)!
  const db = new DatabaseSync(join(f.root, 'control.sqlite'))
  db.exec('DROP TABLE source_release_dispatches; PRAGMA user_version = 17;'); db.close()
  const recovered = new ControlPlaneStore({ path: join(f.root, 'control.sqlite') })
  try {
    expect(recovered.getSourceReleaseDispatchStatus(pr.operationId)).toBe('completed')
    expect(recovered.getSourceReleaseOperation(pr.operationId).receipt).toEqual(pr.receipt)
    expect(recovered.getSourceReleaseDispatchStatus(review.operationId)).toBe('claimed')
    await f.decide()
    await expect(advanceSourceRelease({ ...f.options, store: recovered })).rejects.toThrow('unknown')
    expect(release.invokeSourceReleaseAdapter).toHaveBeenCalledTimes(1)
    // Model an independent signed receipt recovered from the external review authority.
    const receipt = await f.execute(review.request), plan = recovered.getSourcePlan(f.plan.id)
    const { authority, authorize } = sourceReleaseAuthorities(f.options.trust)
    await recovered.acceptSourceReleaseReceipt({ operationId: review.operationId, expectedRevision: plan.revision, expectedFence: 1,
      receipt, resolveAuthority: authority, resolveAuthorizationAuthority: authorize })
    expect((await advanceSourceRelease({ ...f.options, store: recovered })).status).toBe('release-complete')
    expect(vi.mocked(release.invokeSourceReleaseAdapter).mock.calls.filter(call => call[1].phase === 'review')).toHaveLength(0)
  } finally { recovered.close() }
})
