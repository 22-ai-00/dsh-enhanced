import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, test, vi } from 'vitest'
import { AssistantVerifierService } from '../src/service.ts'
import { CreationReviewRuntime, type CreationReviewConfig } from '../src/creation-review.ts'

vi.mock('../src/creation-review.ts', async original => {
  const actual = await original<typeof import('../src/creation-review.ts')>()
  return { ...actual, CreationReviewRuntime: vi.fn(function (this: {
    inspect: () => unknown; run: () => Promise<unknown>; close: () => Promise<void>
  }) {
    this.inspect = vi.fn(() => ({ authority: { authorityId: 'grant' }, available: true }))
    this.run = vi.fn(async () => ({ status: 'unknown', reason: 'case-observation-unknown' }))
    this.close = vi.fn(async () => {})
  }) }
})

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.clearAllMocks() })

test('late binds the private Control Plane and native peers, then drains each verifier generation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'creation-review-service-')))
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const pair = generateKeyPairSync('ed25519'), keyPath = join(root, 'key.pem'), stateRoot = join(root, 'observer')
  await mkdir(stateRoot, { mode: 0o700 })
  await writeFile(keyPath, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  const owner = { authorityId: 'route', authorityHash: 'a'.repeat(64), principalId: 'owner', principalRecordId: 'record',
    principalVersion: 1, workspace: root, agentPreset: 'main' }
  const expiresAt = Date.now() + 60_000
  const creationReviews: CreationReviewConfig = { authorityId: 'grant', owner, namePrefix: 'owner-', keyId: 'key-1', keyPath,
    expiresAt, maxVerifications: 1,
    runner: { stateRoot, image: 'sha256:' + 'b'.repeat(64), dockerPath: '/usr/bin/docker', expiresAt,
      maxRuns: 3, maxTotalDurationMs: 30_000, maxDurationMs: 10_000, maxOutputBytes: 65_536 },
    policy: 'Review the owner task.', maxInputBytes: 8192, maxOutputTokens: 512, maxDurationMs: 20_000,
    maxCases: 2, receiptTtlMs: 10_000 }
  const service = new AssistantVerifierService(ctx, { databasePath: join(root, 'state.sqlite'), tickIntervalMs: 0, creationReviews })
  const request = { protocol: 'assistant-growth/creation-verification-request/v1' as const, planId: 'plan-1' }
  expect(service.inspectCreationAcceptanceAuthority({ owner })).toBeUndefined()
  expect(await service.verifyPluginCreation(request)).toEqual({ status: 'unknown', reason: 'verification-unavailable' })
  const provider = ctx.plugin({ name: 'creation-review-peers', apply(peer: Context) {
    for (const name of ['agents', 'sessions', 'tools', 'llm', 'systemPrompt', 'assistantPolicy', 'pluginControlPlane']) {
      peer.provide(name as never, {} as never)
    }
  } })
  await provider; await new Promise(resolve => setImmediate(resolve))
  expect(CreationReviewRuntime).toHaveBeenCalledTimes(1)
  expect(service.inspectCreationAcceptanceAuthority({ owner })).toMatchObject({ available: true })
  expect(await service.verifyPluginCreation(request)).toEqual({ status: 'unknown', reason: 'case-observation-unknown' })
  const runtime = vi.mocked(CreationReviewRuntime).mock.instances[0]!
  expect(runtime.run).toHaveBeenCalledWith(request, undefined)
  await provider.dispose(); await new Promise(resolve => setImmediate(resolve))
  expect(runtime.close).toHaveBeenCalledOnce()
  expect(service.inspectCreationAcceptanceAuthority({ owner })).toBeUndefined()
  expect(service.trustedVerificationProducerGeneration()).toEqual(expect.any(String))
})
