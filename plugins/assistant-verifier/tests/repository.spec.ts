import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import { createVerifierAuthorities, verifyAcceptanceCriteria, type RepositoryReadbackAuthorityInput } from '../src/drivers.ts'
import { AssistantVerifierService } from '../src/service.ts'
import type { AcceptedExecution, TaskAcceptanceRegistration } from '../src/host.ts'

const authority: RepositoryReadbackAuthorityInput = { kind: 'repository-readback', id: 'github', grantId: 'repo', grantRevision: 1,
  repository: 'octo/example', branch: 'automation/fix', baseBranch: 'main', requiredChecks: [{ name: 'test', appId: 42 }],
  reviewerIds: [7], minApprovals: 1, timeoutMs: 1_000, freshnessMs: 5_000 }
const authorities = createVerifierAuthorities({ authorities: [authority] })
const criterion = { id: 'remote', kind: 'target-readback' as const, authority: { id: authorities[0]!.id, digest: authorities[0]!.digest },
  objectId: 'octo/example:automation/fix', expected: [{ pointer: '/ready', value: true }] }
const task = { kind: 'goal-outcome' as const, ref: 'assessment', goal: { id: 'goal', definitionVersion: 1, definitionDigest: 'a'.repeat(64),
  assessmentId: 'assessment', sessionId: 'session', nativeGoalId: 'native' } }
const ready = { objectId: criterion.objectId, headOid: 'b'.repeat(40), ci: 'passed', review: 'approved', pullRequest: 'open', ready: true }
const contract = createTaskAcceptanceContract({ protocol: 'task-acceptance/v3', id: 'contract', scope: { workspace: '/tmp/work', preset: 'primary' },
  owner: { principalRecordId: 'owner', principalVersion: 1 }, task, objective: 'Repair and verify repository',
  profile: { id: 'profile', version: 1, digest: 'a'.repeat(64) }, issuedAt: 1_000, expiresAt: 61_000,
  bounds: { maxDurationMs: 2_000, maxEvidenceBytes: 4096 }, criteria: [criterion] })
const roots: string[] = []; const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.restart(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('authenticated repository acceptance', () => {
  it.each([
    [ready, 'passed'],
    [{ ...ready, ci: 'pending', ready: false }, 'unknown'],
    [{ ...ready, review: 'pending', ready: false }, 'unknown'],
    [{ ...ready, ci: 'failed', ready: false }, 'failed'],
    [{ ...ready, review: 'changes-requested', ready: false }, 'failed'],
    [{ ...ready, pullRequest: 'closed', ready: false }, 'failed'],
    [{ ...ready, ci: 'unknown', ready: false }, 'unknown'],
    [{ ...ready, ci: 'failed' }, 'unknown'],
    [{ ...ready, objectId: 'foreign' }, 'unknown'],
    [{ ...ready, headOid: 'old' }, 'unknown'],
    [{ ...ready, extra: 'untrusted' }, 'unknown'],
  ])('normalizes readiness without treating pending or malformed data as success (%s)', async (value, status) => {
    const observed = await verifyAcceptanceCriteria(contract, authorities, new AbortController().signal, undefined, {
      read: async (accepted, configured) => { expect(accepted).toEqual(contract); expect(configured.digest).toBe(authorities[0]!.digest); return value },
    })
    expect(observed[0]!.status).toBe(status)
  })

  it('requires the broker and exact authority, and rejects invalid requirement bounds', async () => {
    expect((await verifyAcceptanceCriteria(contract, authorities, new AbortController().signal))[0]!.status).toBe('unknown')
    for (const change of [{ reviewerIds: [7, 7] }, { minApprovals: 2 }, { requiredChecks: [] }, { freshnessMs: 60_001 },
      { requiredChecks: [{ name: 'test', appId: 42 }, { name: 'test', appId: 42 }] }, { branch: 'a'.repeat(256) }]) {
      expect(() => createVerifierAuthorities({ authorities: [{ ...authority, ...change }] })).toThrow()
    }
  })

  it.each([false, true])('uses the accepted Host binding and expires receipts by freshness; changed broker=%s', async changed => {
    const root = await mkdtemp(join(tmpdir(), 'repository-verifier-')); roots.push(root)
    const ctx = new Context(); contexts.push(ctx)
    let registration: TaskAcceptanceRegistration | undefined; let proof: AcceptedExecution | null = null
    const producer = { trustedAcceptanceProducerGeneration: () => 'generation', registerTaskAcceptanceSink: (value: TaskAcceptanceRegistration) => { registration = value; return () => { registration = undefined } }, inspectAcceptedExecution: async () => proof }
    ctx.provide('assistantGoals' as never, producer as never)
    let generation = 'actions-a'; let called = 0
    ctx.provide('assistantActions' as never, { repositoryReadbackGeneration: () => generation,
      readRepositoryGoalOutcome: async (input: { contractId: string; authorityId: string; authorityDigest: string }) => {
        called++
        const inspected = verifier.inspectRepositoryReadbackAuthority(input.contractId, input.authorityId, input.authorityDigest)
        expect(inspected.contract.task).toEqual(task); expect(inspected.authority).toMatchObject(authority)
        if (changed) generation = 'actions-b'
        return ready
      } } as never)
    const selection = { scope: contract.scope, owner: contract.owner, objective: contract.objective, taskKind: 'goal-outcome' as const }
    const verifier = new AssistantVerifierService(ctx, { databasePath: join(root, 'verifier.sqlite'), authorities: [authority], tickIntervalMs: 0,
      profiles: [{ ...selection, id: 'profile', version: 1, validityMs: 60_000, bounds: contract.bounds, criteria: [criterion] },
        { ...selection, objective: 'unsafe success condition', id: 'unsafe', version: 1, validityMs: 60_000, bounds: contract.bounds, criteria: [{ ...criterion, expected: [{ pointer: '/ready', value: false }] }] }] }, { now: () => 2_000 })
    expect(verifier.supportsPreauthorizedGoalAcceptance(selection)).toBe(true)
    expect(verifier.supportsPreauthorizedGoalAcceptance({ ...selection, objective: 'unsafe success condition' })).toBe(false)
    expect(() => verifier.inspectRepositoryReadbackAuthority('missing', authority.id, authorities[0]!.digest)).toThrow()
    const handle = registration!.prepare({ scope: contract.scope, owner: contract.owner, objective: contract.objective, task })!
    proof = { ...handle, dispatchedAt: 2_000, completedAt: 2_000, status: 'succeeded', quiescent: true, executionRef: task.ref }
    await registration!.completed(handle); await verifier.tick()
    expect(called).toBe(1)
    expect(verifier.inspectAcceptedTask(handle.contractId)).toMatchObject({ contract: { protocol: 'task-acceptance/v3' }, receipt: {
      objectiveStatus: changed ? 'unknown' : 'achieved', validUntil: 7_000,
    } })
  })
})
