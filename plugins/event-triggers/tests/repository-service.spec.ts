import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { CredentialsKeychainService } from '@dsh-enhanced/credentials-keychain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventTriggersService } from '../src/service.ts'
import { EVENT_OBSERVER_EXECUTOR } from '../src/observer.ts'

const roots: string[] = []
const contexts: Context[] = []
const repository = 'owner/repository'
const branch = 'delivery/fix'
const baseBranch = 'main'
const head = 'a'.repeat(40)

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.restart()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function response(body: unknown): Response { return new Response(JSON.stringify(body), { status: 200 }) }

async function fixture(requestTimeoutMs = 1_000, lifetime: 'shared' | 'goal' = 'shared') {
  const root = await mkdtemp(join(tmpdir(), 'event-triggers-repository-service-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  let goal = { scope: { principalId: 'owner:one', principalRecordId: 'record', principalVersion: 1, workspace: root, preset: 'primary' }, id: 'goal-one', definition: { version: 1, digest: 'c'.repeat(64) }, native: { sessionId: 'session-one', goalId: 'native-one', revision: 2, phase: 'paused' } }
  ctx.provide('assistantGoals' as never, { inspectGoalLifecycle: ({ scope, goalId }: { scope: unknown; goalId: string }) => JSON.stringify(scope) === JSON.stringify(goal.scope) && goalId === goal.id ? Object.freeze(goal) : undefined } as never)
  let routeGeneration = 1
  const route = () => Object.freeze({ authorityId: 'route', authorityHash: 'a'.repeat(64), receiptVersion: 2 as const,
    principalId: 'owner:one', principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'primary', bindingVersion: 1, generation: routeGeneration })
  ctx.provide('assistantDelivery' as never, { validateOwnerRoute: vi.fn(route) } as never)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), budgets: [{ id: 'repository-observations', metric: 'requests', limit: 100, periodMs: 60_000, scope: 'subject' }], rules: [
    { id: 'observer-reconcile', effect: 'allow', subject: { kind: 'background', id: EVENT_OBSERVER_EXECUTOR, workspace: root, principal: 'owner:one' }, actions: ['observe', 'reconcile', 'execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
    { id: 'repository-observe', effect: 'allow', subject: { kind: 'background', id: 'event-triggers:repository', workspace: root, principal: 'owner:one' }, actions: ['observe'], resource: { kind: 'network', id: `https://api.github.com/repos/${repository}` }, context: { initiators: ['background'] }, budget: { id: 'repository-observations', amount: 1 } },
    { id: 'credential', effect: 'allow', subject: { kind: 'background', id: 'dsh-enhanced-event-triggers' }, actions: ['credential.use'], resource: { kind: 'credential', id: 'github' }, context: { initiators: ['background'] } },
    { id: 'event-ingest', effect: 'allow', subject: { kind: 'external', id: 'event-triggers:repository', workspace: root }, actions: ['ingest'], resource: { kind: 'automation', id: 'repository-target' }, context: { initiators: ['external'] } },
  ] })
  await ctx.plugin(AssistantAutomationsService, { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0, allowUnbudgetedExecution: true })
  await ctx.plugin({ name: 'credentials-keychain-fixture', apply(runtime: Context) {
    new CredentialsKeychainService(runtime, { databasePath: join(root, 'credentials.sqlite'), handles: [{ id: 'github', provider: 'environment', environmentName: 'GITHUB_TOKEN', consumers: ['dsh-enhanced-event-triggers'], purposes: ['github.observe'], maxLeaseMs: 30_000 }] }, { env: { GITHUB_TOKEN: 'repository-fixture-token' } })
  } })
  let conclusion = 'success'
  let reviewState = 'APPROVED'
  let hang = false; let release: (() => void) | undefined
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer repository-fixture-token')
    const path = new URL(url).pathname
    const result = () => {
      if (path.includes('/check-runs')) return response({ total_count: 1, check_runs: [{ id: 1, name: 'CI', app: { id: 7 }, head_sha: head, status: 'completed', conclusion }] })
      if (path.endsWith('/pulls')) return response([{ number: 7, state: 'open', head: { ref: branch, sha: head, repo: { full_name: repository } }, base: { ref: baseBranch, repo: { full_name: repository } } }])
      return response([{ id: 1, user: { id: 42 }, commit_id: head, state: reviewState }])
    }
    if (hang) return await new Promise<Response>((resolve, reject) => { release = () => { hang = false; resolve(result()) }; init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }) })
    return result()
  })
  const config = { databasePath: join(root, 'events.sqlite'), pollerEnabled: false, pollIntervalMs: 1_000, requestTimeoutMs, maxBodyBytes: 16_384, triggers: [{ id: 'repository', kind: 'github-repository' as const, automationId: 'repository-target', repository, branch, baseBranch, credentialHandle: 'github', fireWhen: 'changed' as const, debounceMs: 0, cooldownMs: 0, maxFires: 10, observerLifetime: lifetime, observer: { workspace: root, preset: 'primary', principalId: 'owner:one', principalRecordId: 'record', principalVersion: 1, ownerRouteId: 'route', expiresAt: Date.now() + 60_000, budgetId: 'repository-observations' } }] }
  const install = async () => {
    let service!: EventTriggersService
    const fiber = await ctx.plugin({ name: 'dsh-enhanced-event-triggers', apply(runtime: Context) { service = new EventTriggersService(runtime, config, { fetcher, lookup: async () => [{ address: '93.184.216.34', family: 4 }] }) } })
    return { service, fiber }
  }
  return { ctx, root, fetcher, install, change: () => { conclusion = 'failure' }, changeReview: () => { reviewState = 'CHANGES_REQUESTED' }, revokeRoute: () => { routeGeneration = 2 }, hang: () => { hang = true }, release: () => release?.(), hasRelease: () => release !== undefined, completeGoal: () => { goal = { ...goal, native: { ...goal.native, revision: 5, phase: 'complete' } } }, goal }
}

describe('GitHub repository trigger service composition', () => {
  it('supports the minimum request timeout with a valid credential lease', async () => {
    const f = await fixture(100), installed = await f.install()
    await installed.service.pollOnce()
    expect(f.fetcher).toHaveBeenCalledTimes(3)
    expect(installed.service.health().pendingEvents).toBe(0)
  })

  it('persists an untrusted changed CI/review event, deduplicates repeats, and preserves the cursor across restart', async () => {
    const f = await fixture()
    let installed = await f.install()
    expect(f.ctx.assistantAutomations.inspectSystemOwned({ owner: EVENT_OBSERVER_EXECUTOR, automationId: 'repository-target' })).toMatchObject({ automationStatus: 'active' })
    await installed.service.pollOnce()
    const baseline = installed.service.sourceSnapshot('repository')
    expect(baseline).toMatchObject({ kind: 'github-repository', sourceId: 'event-triggers:repository', highWaterSequence: 0 })

    f.change()
    await installed.service.pollOnce()
    const changed = installed.service.firstEventAfter(baseline, baseline.highWaterSequence, Date.now() + 1_000)!
    expect(changed).toMatchObject({ sequence: 1, envelope: { source: { kind: 'github-repository', id: 'event-triggers:repository' }, trust: { content: 'untrusted', method: 'https-observation' } } })
    await f.ctx.assistantAutomations.tick()
    await f.ctx.assistantAutomations.whenIdle()
    await installed.service.pollOnce()
    expect(installed.service.sourceSnapshot('repository').highWaterSequence).toBe(1)
    f.changeReview()
    await installed.service.pollOnce()
    expect(installed.service.firstEventAfter(baseline, 1, Date.now() + 1_000)).toMatchObject({ sequence: 2 })
    await installed.service.pollOnce()
    expect(installed.service.sourceSnapshot('repository').highWaterSequence).toBe(2)
    expect(JSON.stringify([changed, installed.service.health()])).not.toContain('repository-fixture-token')

    await installed.fiber.dispose()
    installed = await f.install()
    expect(installed.service.sourceSnapshot('repository').highWaterSequence).toBe(2)
    await installed.service.pollOnce()
    expect(installed.service.sourceSnapshot('repository').highWaterSequence).toBe(2)
    expect(f.ctx.assistantPolicy.health()).toMatchObject({ emergencyStop: false })
  })

  it('stops polling and hides the source after an explicit persisted source pause', async () => {
    const f = await fixture(), installed = await f.install()
    await installed.service.pollOnce()
    const current = f.ctx.assistantAutomations.inspectSystemOwned({ owner: EVENT_OBSERVER_EXECUTOR, automationId: 'repository-target' })
    f.ctx.assistantAutomations.pauseSystemOwned({ owner: EVENT_OBSERVER_EXECUTOR, automationId: 'repository-target', operationId: 'owner-pause', expectedVersion: current.definitionVersion, definitionHash: current.definitionHash })
    const calls = f.fetcher.mock.calls.length
    await expect(installed.service.pollOnce()).rejects.toThrow(/paused|changed/)
    expect(f.fetcher).toHaveBeenCalledTimes(calls)
    expect(() => installed.service.sourceSnapshot('repository')).toThrow(/paused|changed/)
  })

  it('aborts before a durable event when the owner route changes while GitHub I/O waits', async () => {
    const f = await fixture()
    const installed = await f.install()
    await installed.service.pollOnce()
    installed.service.sourceSnapshot('repository')
    f.hang()
    const polling = installed.service.pollOnce()
    await new Promise(resolve => setImmediate(resolve))
    f.revokeRoute()
    await expect(polling).rejects.toThrow(/owner route|unavailable|abort/i)
    expect(installed.service.health()).toMatchObject({ pendingEvents: 0, retryingEvents: 0, deliveredEvents: 0 })
    expect(JSON.stringify(installed.service.health())).not.toContain('repository-fixture-token')
  })

  it('drops an observation that finishes after its claimed goal completes, and stays stopped after service restart', async () => {
    const f = await fixture(1_000, 'goal')
    let installed = await f.install()
    const snapshot = installed.service.sourceSnapshot('repository')
    const claim = { triggerId: 'repository', scope: f.goal.scope, goalId: f.goal.id, definition: f.goal.definition,
      native: { sessionId: f.goal.native.sessionId, goalId: f.goal.native.goalId, revision: f.goal.native.revision },
      configDigest: snapshot.configDigest, automationId: snapshot.target.automationId }
    expect(installed.service.claimGoalSource(claim)).toBe(true)
    f.change(); f.hang()
    const polling = installed.service.pollOnce()
    await vi.waitFor(() => expect(f.hasRelease()).toBe(true))
    f.completeGoal(); f.release()
    await expect(polling).rejects.toThrow()
    const database = new DatabaseSync(join(f.root, 'events.sqlite'), { readOnly: true })
    expect(database.prepare('SELECT COUNT(*) AS count FROM event_outbox').get()).toEqual({ count: 0 })
    database.close()
    expect(() => installed.service.sourceSnapshot('repository')).toThrow(/retired|changed/)
    await installed.fiber.dispose()
    installed = await f.install()
    expect(() => installed.service.sourceSnapshot('repository')).toThrow(/retired|changed/)
  })
})
