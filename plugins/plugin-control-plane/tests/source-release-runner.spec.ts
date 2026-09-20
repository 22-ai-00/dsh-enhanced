import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import * as release from '../src/release.ts'
import { advanceSourceRelease, validateSourceReleaseExecutionConfig } from '../src/source-release-runner.ts'
import { ControlPlaneStore } from '../src/store.ts'
import { cleanupReleaseFixtures, fixture, phases } from './helpers/source-release-runner.ts'
vi.mock('../src/release.ts', async original => ({ ...await original<typeof release>(), invokeSourceReleaseAdapter: vi.fn() }))
afterEach(cleanupReleaseFixtures)

test('waits without dispatching review, then resumes all eight signed phases through the same durable operations', async () => {
  const f = await fixture(); validateSourceReleaseExecutionConfig(f.options.config)
  expect((await advanceSourceRelease(f.options)).status).toBe('awaiting-review')
  expect(release.invokeSourceReleaseAdapter).toHaveBeenCalledTimes(1)
  const review = f.store.findSourceReleaseOperation(f.plan.id, 'review', 1)!
  expect((await advanceSourceRelease(f.options)).status).toBe('awaiting-review')
  expect(f.store.findSourceReleaseOperation(f.plan.id, 'review', 1)!.operationId).toBe(review.operationId)
  await f.decide()
  expect((await advanceSourceRelease(f.options)).status).toBe('release-complete')
  expect(vi.mocked(release.invokeSourceReleaseAdapter).mock.calls.map(call => call[1].phase)).toEqual(phases)
  expect(f.store.sourceReleaseCandidate(f.plan.id).version).toBe('0.1.1')
})

test('rejects a decision for a different checked head before any review dispatch', async () => {
  const f = await fixture(); await advanceSourceRelease(f.options); await f.decide({ headCommit: '9'.repeat(40) })
  await expect(advanceSourceRelease(f.options)).rejects.toThrow('decision')
  expect(release.invokeSourceReleaseAdapter).toHaveBeenCalledTimes(1)
})

test('requests independent review only when enabled, then validates its decision through the normal signed phases', async () => {
  const f = await fixture()
  const review = vi.fn(async (request, plan) => {
    expect(request.phase).toBe('review')
    expect(request.plan.id).toBe(plan.id)
    expect(release.invokeSourceReleaseAdapter).toHaveBeenCalledTimes(1)
    await f.decide()
  })
  expect((await advanceSourceRelease({ ...f.options, review })).status).toBe('awaiting-review')
  expect(review).not.toHaveBeenCalled()
  const config = { ...f.options.config, independentReview: true }
  validateSourceReleaseExecutionConfig(config)
  expect((await advanceSourceRelease({ ...f.options, config, review })).status).toBe('release-complete')
  expect(review).toHaveBeenCalledTimes(1)
  expect(vi.mocked(release.invokeSourceReleaseAdapter).mock.calls.map(call => call[1].phase)).toEqual(phases)
})

test('a rejected or unknown review cannot advance without a matching decision', async () => {
  const f = await fixture(), review = vi.fn(async () => {})
  expect((await advanceSourceRelease({ ...f.options, config: { ...f.options.config, independentReview: true }, review })).status).toBe('awaiting-review')
  expect(review).toHaveBeenCalledTimes(1)
  expect(release.invokeSourceReleaseAdapter).toHaveBeenCalledTimes(1)
})

test('cancellation after independent review prevents signed review dispatch', async () => {
  const f = await fixture()
  await expect(advanceSourceRelease({ ...f.options, config: { ...f.options.config, independentReview: true },
    review: async () => { await f.decide(); f.controller.abort() } })).rejects.toThrow()
  expect(release.invokeSourceReleaseAdapter).toHaveBeenCalledTimes(1)
  expect(f.store.getSourcePlan(f.plan.id).status).toBe('awaiting-review')
})

test('does not replay an adapter after a lost response, including a new Store connection', async () => {
  const f = await fixture()
  vi.mocked(release.invokeSourceReleaseAdapter).mockRejectedValueOnce(new Error('lost response'))
  await expect(advanceSourceRelease(f.options)).rejects.toThrow('lost response')
  const recovered = new ControlPlaneStore({ path: join(f.root, 'control.sqlite') })
  try { await expect(advanceSourceRelease({ ...f.options, store: recovered })).rejects.toThrow(/unknown|dispatch|claimed/u) } finally { recovered.close() }
  expect(release.invokeSourceReleaseAdapter).toHaveBeenCalledTimes(1)
})

test('resumes a completed catalog receipt without rebuilding its already-applied catalog preview', async () => {
  const f = await fixture(); await advanceSourceRelease(f.options); await f.decide()
  const apply = f.store.applySourceRelease.bind(f.store)
  const spy = vi.spyOn(f.store, 'applySourceRelease').mockImplementation(async input => {
    if (input.receipt.phase === 'catalog-admission') throw new Error('crash before ledger apply')
    return apply(input)
  })
  await expect(advanceSourceRelease(f.options)).rejects.toThrow('crash before ledger apply'); spy.mockRestore()
  expect((await advanceSourceRelease(f.options)).status).toBe('release-complete')
  expect(release.invokeSourceReleaseAdapter).toHaveBeenCalledTimes(8)
})

test('suppresses late results after cancellation and never continues to review', async () => {
  const f = await fixture()
  vi.mocked(release.invokeSourceReleaseAdapter).mockImplementationOnce(async (_trust, request) => {
    const receipt = await f.execute(request); f.controller.abort(); return receipt
  })
  await expect(advanceSourceRelease(f.options)).rejects.toThrow()
  expect(f.store.getSourcePlan(f.plan.id).status).toBe('awaiting-pr')
  expect(release.invokeSourceReleaseAdapter).toHaveBeenCalledTimes(1)
})
