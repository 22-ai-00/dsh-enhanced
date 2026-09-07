import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { MemoryDevelopmentTask } from './memory-corpus.js'

export const memoryRuntimeConfig = Object.freeze({
  protocol: 'native-memory-retrieval-v1', preset: 'benchmark-memory',
  snapshotMaxBytes: 8_192, snapshotMaxTokens: 2_048,
  approvalMode: 'delivery-or-headless', toolAccess: 'none',
  seed: 'public-host-proposal-and-approval', baseline: 'same-fixtures-snapshot-denied',
})

type Entry = MemoryDevelopmentTask['memories'][number]['entry']
interface Proposal {
  proposalId: string
  version: number
  status: string
  record?: Entry & { id: string; version: number; status: string }
}
interface MemoryService {
  propose(agent: Agent, input: {
    principal: string; idempotencyKey: string
    mutation: { op: 'add'; identity: { owner: 'user'; scope: 'workspace'; workspace: string }; entry: Entry & { expiresAt?: number } }
      | { op: 'remove'; identity: { owner: 'user'; scope: 'workspace'; workspace: string }; id: string; expectedVersion: number }
  }): Proposal
  decideProposal(input: { proposalId: string; principal: string; expectedVersion: number; decision: 'approved'; reason: string }): Proposal
}

/** Optional Host peers load only for the Memory suite, without an Evaluation/Memory build cycle. */
export async function installBenchmarkMemory(ctx: Context, workspace: string, snapshotLimit: number, enabled: boolean): Promise<MemoryService> {
  const policyPackage = '@dsh-enhanced/assistant-policy'
  const memoryPackage = '@dsh-enhanced/personal-memory'
  const [policyModule, memoryModule] = await Promise.all([import(policyPackage), import(memoryPackage)])
  if (typeof policyModule.AssistantPolicyService !== 'function' || typeof memoryModule.PersonalMemoryService !== 'function') throw new Error('native Memory peers lack required public services')
  const Policy = policyModule.AssistantPolicyService as new (ctx: Context, config: unknown) => unknown
  const Memory = memoryModule.PersonalMemoryService as new (ctx: Context, config: unknown) => MemoryService
  new Policy(ctx, {
    databasePath: join(workspace, 'policy.sqlite'),
    rules: [workspace, join(workspace, 'other-workspace')].map((cwd, index) => ({
      id: `benchmark-memory-${index}`, effect: 'allow',
      subject: { kind: 'agent', id: memoryRuntimeConfig.preset, workspace: cwd },
      actions: enabled && index === 0 ? ['propose', 'snapshot'] : ['propose'],
      resource: { kind: 'memory', id: '*' }, context: { initiators: ['foreground'] },
    })),
  })
  return new Memory(ctx, {
    databasePath: join(workspace, 'memory.sqlite'), approvalMode: memoryRuntimeConfig.approvalMode,
    snapshotLimit, snapshotMaxBytes: memoryRuntimeConfig.snapshotMaxBytes,
    snapshotMaxTokens: memoryRuntimeConfig.snapshotMaxTokens, reconcileIntervalMs: 0,
  })
}

/** The operator approves authored fixtures before inference; the model receives no mutation tools. */
export async function seedBenchmarkMemory(ctx: Context, memory: MemoryService, agent: Agent, workspace: string, cellId: string, task: MemoryDevelopmentTask): Promise<void> {
  for (const fixture of task.memories) {
    const cwd = fixture.visibility === 'other-workspace' ? join(workspace, 'other-workspace') : workspace
    const principal = `benchmark-memory:${cellId}${fixture.visibility === 'other-owner' ? ':foreign' : ''}`
    const foreign = fixture.visibility === 'other-owner' || fixture.visibility === 'other-workspace'
    await mkdir(cwd, { recursive: true })
    const handle = foreign ? await ctx.agents.create({
      sessionId: SessionId(`seed-${acceptanceDigest({ cellId, id: fixture.id }).slice(0, 40)}`),
      meta: { cwd, agentPreset: memoryRuntimeConfig.preset },
      setup: agentCtx => { agentCtx.tools.restrict({ allow: [] }) },
    }) : undefined
    try {
      const identity = { owner: 'user' as const, scope: 'workspace' as const, workspace: cwd }
      const entry: Entry & { expiresAt?: number } = { ...fixture.entry, ...(fixture.visibility === 'sensitive' ? { sensitivity: 'sensitive' } : {}), ...(fixture.visibility === 'expired' ? { expiresAt: 1 } : {}) }
      const proposal = memory.propose(handle?.agent ?? agent, { principal, idempotencyKey: `seed:${fixture.id}`, mutation: { op: 'add', identity, entry } })
      const approved = memory.decideProposal({ proposalId: proposal.proposalId, principal, expectedVersion: proposal.version, decision: 'approved', reason: 'Operator-approved public benchmark fixture' })
      if (approved.status !== 'approved' || approved.record?.content !== entry.content
        || acceptanceCanonicalJson(approved.record?.knowledge ?? null) !== acceptanceCanonicalJson(entry.knowledge ?? null)) throw new Error('native Memory fixture approval did not preserve content and knowledge')
      if (fixture.visibility === 'removed') {
        const remove = memory.propose(handle?.agent ?? agent, { principal, idempotencyKey: `remove:${fixture.id}`, mutation: { op: 'remove', identity, id: approved.record.id, expectedVersion: approved.record.version } })
        const removed = memory.decideProposal({ proposalId: remove.proposalId, principal, expectedVersion: remove.version, decision: 'approved', reason: 'Operator-approved fixture withdrawal before task' })
        if (removed.status !== 'approved') throw new Error('native Memory fixture withdrawal failed')
      }
    } finally { await handle?.dispose() }
  }
}
